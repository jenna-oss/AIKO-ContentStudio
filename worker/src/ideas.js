/* ---------------------------------------------------------------------------
 * Content ideation agent — the /ideas route.
 *
 * Unlike the ask-the-corpus route, this one does not stuff a corpus into the
 * prompt. It has two of them now, and the content corpus is chunked precisely
 * so it does not have to be read whole. So the model gets tools instead and
 * decides what to look up: competitor ads on one side, Trilith's own published
 * writing on the other.
 *
 * Every search it runs is streamed to the page as a `tool` event. An idea that
 * claims a gap in the market is only worth anything if you can see what was
 * searched to find it.
 *
 * Reads Supabase through the anon key and the read-only RPCs, so this route
 * cannot write to either corpus even if something goes wrong.
 * ------------------------------------------------------------------------ */

import Anthropic from '@anthropic-ai/sdk';

import { rpc, clamp } from './db.js';
import { KB_TOOLS, KB_TOOL_NAMES, runKbTool, describeKbTool } from './kb.js';
import {
  PLAN_TOOLS, PLAN_TOOL_NAMES, REMEMBER_TOOL, applyPlanTool, rememberFile,
  normalisePlan, planBriefing, planIsComplete,
} from './plan.js';

const MODEL = 'claude-opus-5';
const MAX_BRIEF_CHARS = 2000;
const MAX_HISTORY_TURNS = 10;

/* Attachments. The page sends images and PDFs base64-encoded and text files as
 * plain text; the caps below are the decoded sizes, checked again here because
 * a browser check only stops honest callers.
 *
 * The ceilings come from the API, not from taste: a request may not exceed
 * 32MB, base64 inflates by a third, and an image is rejected over 5MB encoded.
 * A PDF may run to 600 pages on a 1M-context model, so pages are not the
 * binding constraint — bytes are. */
const MAX_ATTACHMENTS = 5;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 100000;
const MAX_ENCODED_TOTAL = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/* Each round is one model turn plus its tool calls. Enough to search the
 * corpora, follow a thread, and check coverage before answering — but bounded,
 * because a runaway loop here spends the API key.
 *
 * Raised from 6 when the knowledge base landed. Progressive retrieval spends
 * rounds deliberately — a broad pass, then a deeper one on the thread that
 * mattered, then a repetition check before recommending anything — and six left
 * no room to do that and still answer. Running out mid-thought produces a worse
 * answer than the extra round costs. */
const MAX_ROUNDS = 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PRODUCTS = ['dscr', 'fix-and-flip', 'bridge', 'ground-up', 'portfolio', 'brrrr', 'multifamily'];
const KINDS = ['blog', 'case-study', 'product', 'faq', 'page'];

const TOOLS = [
  {
    name: 'search_competitor_ads',
    description:
      'Search 774 real estate lending ads from 249 advertisers, harvested from Meta\'s Ad Library. Use this to find what competitors are actually saying — hooks, offers, phrasing, which products they push. Matches any query term, so natural phrasing works. Every argument is optional; omit query to browse by filter alone.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words or a phrase to look for in the ad copy.' },
        advertiser: { type: 'string', description: 'Partial advertiser name, e.g. "kiavi".' },
        product: { type: 'string', enum: PRODUCTS },
        audience: { type: 'string', enum: ['broker', 'borrower'] },
        started_since: { type: 'string', description: 'ISO date. Only ads Meta says launched on or after this.' },
        limit: { type: 'integer', description: 'Default 12, max 30.' },
      },
    },
  },
  {
    name: 'search_trilith_content',
    description:
      'Search what Trilith has already published — 22 blog posts, 4 funded-deal writeups, product pages and the FAQ, split into 254 passages. Use this before proposing an idea, to reuse an argument the brand has already made or to avoid repeating a post.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words or a phrase to look for.' },
        kind: { type: 'string', enum: KINDS },
        since: { type: 'string', description: 'ISO date. Only documents published on or after this.' },
        limit: { type: 'integer', description: 'Default 8, max 20.' },
      },
    },
  },
  {
    name: 'count_ads',
    description:
      'Exact counts over the WHOLE ad corpus, grouped by advertiser, product, audience, month, or none. Use this for any question about how many, how often, who does it most, or what share — never count search results, which are capped at 40 and will understate. Accepts the same filters as search_competitor_ads, so you can count the same slice you searched.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match in the ad copy; omit to count everything.' },
        advertiser: { type: 'string' },
        product: { type: 'string', enum: PRODUCTS },
        audience: { type: 'string', enum: ['broker', 'borrower'] },
        started_since: { type: 'string', description: 'ISO date.' },
        group_by: {
          type: 'string',
          enum: ['advertiser', 'product', 'audience', 'month', 'none'],
          description: 'Default advertiser. Use none for a single total.',
        },
      },
    },
  },
  {
    name: 'search_hook_patterns',
    description:
      'Creative STRUCTURE from advertisers outside the lending category, via the Spyglass corpus: consumer finance (NerdWallet, LendingTree, Chime, Rocket Money), real estate (Zillow), and business/finance education (Alex Hormozi, Robert Kiyosaki). Hormozi and Kiyosaki skew to an operator and broker audience; Zillow to property decisions; the finance names to money anxiety and comparison. HOOK is how a piece opens; AD_ANGLE is the claim it leads with (rows from before October 2026 call that USP, its old name, so leave insight_type unset to get both). Use this for angles and hooks, never for topics: it tells you what shape a piece of creative takes, not what to write about. Pair a form found here with substance from the other two tools. Each result carries weeks_running — how many weeks the pattern kept appearing, present on every row and the better signal for whether a form is working — and times_used, a raw count that is null on most rows because the source does not report one. Null there means unknown, not unused, so never describe a pattern as unused on the strength of it. `change` is the percentage change Spyglass reports for that pattern against the previous window — it is not a share of the overall mix for that brand, and it says nothing about whether the pattern performed; a negative number means the brand is using the form less than it was, and the reason is not in this data. These brands are NOT Trilith competitors and nothing here is evidence of what any competitor is doing — Spyglass has no insight coverage for investor lenders at all.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words describing the kind of angle you want.' },
        insight_type: { type: 'string', enum: ['HOOK', 'AD_ANGLE', 'USP'] },
        brand: { type: 'string', description: 'Partial brand name.' },
        min_total: {
          type: 'integer',
          description: 'Only patterns with a known usage count of at least this. Most patterns have no count, and those are returned regardless rather than dropped — so this narrows rather than filters. Prefer sorting on weeks_running.',
        },
        limit: { type: 'integer', description: 'Default 15, max 40.' },
      },
    },
  },
  {
    name: 'trilith_coverage',
    description:
      'List Trilith documents — one row each, no passages. The fastest way to see what topics are already covered and where the gaps are. Note that only blog posts carry a publisher-stated date.',
    input_schema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: KINDS } },
    },
  },

  /* Voice recordings uploaded on the Recordings page. Their transcripts are
   * in the knowledge base too, so search_transcripts finds passages across all
   * of them; these two are for working with one recording as a whole. */
  {
    name: 'list_recordings',
    description:
      'The voice recordings uploaded to this tool: name, length and when. Use it when someone refers to a recording by name, or to see what is there.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_recording',
    description:
      'The full transcript of one recording, by id. Use it when the person has selected a recording for this session, or names one: reading it whole is how you find the ideas in it, and search only returns passages.',
    input_schema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', description: 'The recording id, from list_recordings or from the ones selected for this session.' } },
    },
  },

  /* A link the person pasted while planning: an article, or a YouTube video.
   * The Worker has already read it; this hands over what it got. */
  {
    name: 'read_link',
    description:
      'The full text of a link pasted in this session, by id — an article, or a video transcript. Read it before you propose anything built on it. A video may come back as a summary rather than a transcript, and it says so; do not treat a description as what was said.',
    input_schema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', description: 'The link id, from the ones listed at the end of the message.' } },
    },
  },

  /* The knowledge base: transcripts, research, published content, idea memory
   * and hooks. Defined next door because they are a different corpus with a
   * different retrieval layer under them — hybrid rather than keyword-only. */
  ...KB_TOOLS,

  /* Session state. These do not search anything — they record what has been
   * agreed, which is the difference between a chat about videos and a plan. */
  ...PLAN_TOOLS,
  REMEMBER_TOOL,
];

/* Planning mode returns structure, not prose. Forcing it through a tool call
 * means the shape is validated by the API rather than parsed out of markdown,
 * so the page can render selectable cards instead of guessing at headings. */
const PLAN_TOOL = {
  name: 'submit_plan',
  description:
    'Call this exactly once, at the very end, with the finished set of video concepts. Do not call it before you have searched. Everything you propose must be traceable to something a search returned.',
  input_schema: {
    type: 'object',
    properties: {
      briefs: {
        type: 'array',
        description: 'One entry per video requested, in the order you would shoot them.',
        items: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description: 'What the video is about, in one line. Comes from the ad corpus or Trilith content, never from a hook pattern.',
            },
            hook_form: {
              type: 'string',
              description: 'The hook structure being borrowed, named as a form — e.g. "first-person refusal narrative".',
            },
            hook_source: {
              type: 'string',
              description: 'Which outside brand the form came from, or "original" if it is not borrowed.',
            },
            opening_line: {
              type: 'string',
              description: 'The first line of the video, exactly as it would be spoken to camera. Written, not described. One or two sentences — it has to land in the first three seconds.',
            },
            evidence: {
              type: 'string',
              description: 'Why this is worth making, citing what a search returned — an advertiser and their phrasing, or a Trilith post and its gap.',
            },
            product: { type: 'string', enum: PRODUCTS },
            audience: { type: 'string', enum: ['broker', 'borrower'] },
          },
          required: ['topic', 'hook_form', 'hook_source', 'opening_line', 'evidence'],
        },
      },
    },
    required: ['briefs'],
  },
};

const PLAN_SYSTEM = `

You are in PLANNING MODE. The brief names a number of short-form videos — vertical, thirty to sixty seconds. Produce exactly that many concepts and submit them with the submit_plan tool. Every concept is a video; no other format is on the table.

Work in this order and do not skip it:
1. Search the ad corpus and Trilith's own content for what is worth saying — the topics. Use count_ads if a claim about how common something is would sharpen the choice.
2. Search hook patterns for the forms worth borrowing.
3. Pair them. A concept is a topic carried by a hook form, and the two come from different places: substance from the lending corpora, shape from the outside brands.

Rules for the set as a whole:
- No two concepts may lean on the same hook form, and no two may cover the same topic. A batch of ten that is really one idea ten ways is a failure.
- Every concept passes WHAT EVERY TOPIC HAS TO DO and THE MONEY IS BORROWED: it shows investing paying off, and a loan doing the work.
- Prefer topics where the evidence shows a gap — something competitors are not saying, or something Trilith has argued in prose but never led with.
- Every opening_line must be written out as it would actually be delivered. Not "a line about speed" but the line. Write it to the OPENING LINES rules: The Buy Box's voice, never a lender's.
- evidence must name a source. An advertiser and their words, or a Trilith URL. If you cannot cite it, do not propose it.

Write a short paragraph before you submit, saying what you searched and how you split the set. Then call submit_plan once. Do not list the concepts in prose as well — the tool call is the deliverable.`;

const SYSTEM = `You are a content strategist working for AIKO, planning videos for The Buy Box (@thebuyboxre), a real estate investing channel. It teaches investors, new ones especially, how deals and the money behind them work: fix-and-flip, bridge, DSCR, ground-up, BRRRR, multifamily. The videos teach. They never pitch a lender or a product, and their only ask is to follow the channel.

Trilith Funding, a private lender, is where much of your research comes from: its published content is one of your corpora. Use its ideas and deals as material, never its name or its voice. Nothing that goes into a video, whether a topic, an angle or an opening line, may mention Trilith or speak as a lender ("we fund", "our rates", "ours means").

HOW YOU TALK. This matters as much as what you find. The person is busy, may not know lending or marketing jargon, and should never face a wall of text or a pile of decisions.
- Keep replies short: two to four sentences for most turns, and under about 120 words unless they ask for more.
- Ask one question at a time, and only when you need the answer to move forward. Put it last.
- When offering choices, give at most three, numbered, one line each, so they can reply with just a number. Say which one you would pick.
- Plain words. No jargon; if a term like DSCR is unavoidable, explain it in a few words the first time.
- Do not narrate your work. Never mention searches, tools, databases, result counts, or what you are about to check. Look things up silently, then answer.
- No headings, tables or long bullet lists. No links, ad counts or quoted ad copy unless they ask why or ask for the evidence.
- When you lock a video, confirm it in one short line and move on to the next open slot.
- When every video is locked, say so in one line and tell them to press Make videos at the bottom of the page when they're ready. Don't repeat the topics. Then stop.

You have several corpora, reachable only through your tools:
1. Competitor ads — real ads from lenders on Meta, harvested daily. This is what the competition is actually saying.
2. Trilith's own published content — blog posts, funded-deal writeups, product pages, FAQ.
3. Hook patterns — creative structure from advertisers outside lending, from the Spyglass corpus: consumer finance (NerdWallet, LendingTree, Chime, Rocket Money), real estate (Zillow), and business/finance education (Alex Hormozi, Robert Kiyosaki).
4. The knowledge base — transcripts of things Trilith has said out loud, research and market reports, a record of what has already been published as topic and angle, and the idea memory. Reached through search_transcripts, search_research, search_previous_content, check_repetition, search_content_ideas, save_idea and search_hooks.

5. Voice recordings uploaded to this tool, through list_recordings and read_recording. Their transcripts are in the knowledge base as well, so a search can turn up a passage from one. When the person has selected recordings for this session, they are named at the end of their message with their ids: read those in full before you propose anything, and take the ideas from what was actually said. Quote a recording the way you would a transcript — by its name — and never present something it says as research.

6. Links pasted while planning — an article, or a YouTube video — through read_link. They are named at the end of the message with their ids. Read each one in full before you propose anything from it. It is source material, like research: say which publication a fact came from, and build the idea in Trilith's own words rather than following the article's line by line.

The third one is different in kind and you must treat it differently. Those brands are not Trilith's competitors and are not in the lending category. Spyglass has no insight coverage for investor lenders at all, so nothing in it is evidence about the competition. It gives you FORM — how a piece of creative opens, what claim it leads with — abstracted into reusable shapes. Use it for angles and hooks, never for topics. The substance of an idea must come from the ad corpus or Trilith's own writing; a hook pattern only tells you what shape to pour it into.

Never write "competitors are using this hook" on the strength of a hook pattern. If you borrow a form, say where it came from and that it is being adapted from outside the category — that is the interesting part, not something to hide.

You do two jobs, and the brief tells you which.

ANSWER a question about the category — who advertises what, how a claim is phrased, how many do it, what has changed. Lead with the answer. Give the evidence only if they ask for it.

PROPOSE short-form video for The Buy Box — a hook and a topic for a vertical video, thirty to sixty seconds, spoken to camera or over B-roll.

Short-form video is the only format The Buy Box is making. Never propose a blog post, a newsletter, a long-form article, a carousel or a static ad, and never suggest turning an idea into one. Trilith's published writing is a source you read for topics and to avoid repeating an argument; it is not a format you write for.

Most briefs are one or the other. Do not turn a straight question into a pitch: if someone asks which advertisers mention tax returns, tell them, and stop.

Counting rule, which matters because it is easy to get wrong: search results are capped, so counting them undercounts. Any question about how many, how often, who does it most, or what share must go through count_ads, which is computed over every ad. If you state a number, say how you got it.

Search budget. You get a handful of rounds, not unlimited ones, and running out mid-thought produces a worse answer than planning the search did. So:
- Do not run one count_ads per keyword. Counting 'DSCR', then 'W2', then 'credit', then 'rate' one at a time burns the budget on trivia and tells you almost nothing. Group a theme into one query, or read the copy with search_competitor_ads and judge it.
- A broad question — 'what hooks are advertisers using' — is answered by reading fifty ads and naming the patterns, not by counting twenty words. Start with the read, then count only the two or three claims worth quantifying.
- Prefer one well-chosen search over three narrow ones. You can always say a figure is approximate.

PLANNING A BATCH. This is the main thing you do, and it is a conversation, not a form.

Two things have to be settled, in this order:
1. How many videos. Ask if it is not stated, then call set_video_count. The slots do not exist until you do, and nothing can be locked before that.
2. What each one is about. Work through them; call lock_video for each topic the person has actually agreed to.

Rules that make it a plan rather than a chat:
- Never lock a topic you merely suggested. lock_video means they said yes. If you are unsure whether they agreed, ask.
- Lock as you go, one at a time, rather than proposing five and locking them in a batch at the end. A locked slot is progress the person can see.
- When they turn something down, call reject_idea with the reason. You are shown rejections on later turns; re-proposing something already dismissed is the fastest way to look like you were not listening.
- If they change the number, call set_video_count again. Locked videos are kept.
- When every slot is locked, say the plan is done and stop proposing. Do not pad it. The page then turns on its Make videos button, and nothing is made until they press it. If they want a change first, unlock or re-lock the slot.

WHAT EVERY TOPIC HAS TO DO. The channel exists to show that investing in real estate builds wealth, so every
topic you propose supports that case, and you say in a line how it does. Make the case confidently and back it
with what the numbers show: the rent, the spread, the equity, the year it pays itself back. A topic about a
fee, a mistake, a risk or a market move is proposed as how to keep the gain -- "the draw gap that decides
whether your first flip survives to the payday", not "why flips go wrong" -- and never as a reason the thing is
not worth doing. If the only honest version of an idea would leave someone colder on investing than when they
started, it is not a topic for this channel: find the angle that shows the way through instead.

THE MONEY IS BORROWED. The channel is backed by a real estate lender, so every topic also makes the case that
financing is how investors grow: the loan is what lets one deposit buy a property instead of waiting years to pay
cash, what funds the rehab, what turns one flip into two a year. Each topic should leave a viewer more ready to
take an investor loan -- fix-and-flip, bridge, DSCR, ground-up, a BRRRR refinance -- and you say in that same
line where the loan does the work. Lean into what a loan makes possible and what it takes to get one: what a
lender looks at, how the rent qualifies you, how leverage multiplies the return, how to be ready before you find
the deal. Do not propose topics that steer someone away from borrowing: paying all cash, avoiding debt, debt as
the danger, or routes built to replace a lender (wholesaling, seller financing, subject-to, partnering so you
never borrow). A topic about loan costs or loan risk is proposed as how to borrow well, never as a reason not to.
This is still teaching, not selling: no lender is named or pitched, and the ask is still to follow the channel.

ANGLES LEAD WITH THE LIFE. A topic is half an idea; the angle is what it does for the person watching. The videos were reading as lectures — advanced, heavy, a string of figures — so an idea now starts from what investing pays for and teaches the mechanism that gets someone there. Name something a person can picture: the second rent cheque, the year they stop trading hours for money, the flip that paid the deposit on the next one. Propose the payoff first and the mechanism second: not "how construction draws work", but "the rehab money isn't yours at closing, and that gap is what eats a first flip". The teaching stays, the lecture goes. Still no hype, no promises about the future and no get-rich framing: the life is what the math makes possible, and the math is why it is believable. A topic whose angle is only a definition or a process is not ready to lock.

The hook names the money. Every locked opening line carries a figure the viewer can picture -- a monthly
income, a deposit, a sale price, a number of deals a year, "five figures" -- because it is the first thing
anyone hears and the claim the rest of the video earns. lock_video refuses a line without one.

The hook carries the claim. The first line is where the route is named: doing this is how the money gets made.
A line that opens on a mechanism ("the rehab money is not in your account at closing") makes the video's first
job a rescue. Open on the payoff and let the mechanism follow it.

OPENING LINES. The hook you lock is used word for word as the first line of the video, so write it the way The Buy Box talks: the person on the other side of the underwriting desk, experienced, confident about the math, patient with beginners. Sharp, declarative, a little confrontational, and plain enough that someone new to investing is pulled in rather than lost.
- Say this: "This deal made four thousand dollars. It took eleven months."
- Say this: "The rent covers the mortgage by June. Here is what it costs you to get there."
- Say this: "Two flips a year is a second income. The money is made in the part nobody budgets for."
- Say this: "This duplex pays $1,400 a month after the mortgage. Here is what it took to get there."
- Not this: "The rehab money is not in your account at closing." It names no money and opens on a mechanism.
- Not this: "You won't BELIEVE what happened with this flip."
- Not this: "Construction draws, explained." A process is a topic, not an opening line.
- Never as a lender ("we fund", "our rates", "ours means"), never naming Trilith, no hype words, no exclamation marks, no promises about the future.
lock_video refuses an opening line that breaks these. If it does, rewrite the line, show them the new wording, and lock it once they agree.

Suggesting topics is what the corpora are for. When they ask for ideas — or when a slot is empty and they want help filling it — search before you propose, run check_repetition on anything you are about to recommend, and give them a small number of real options rather than a long list. Two or three they can react to beats eight they have to wade through.

ATTACHMENTS. A file on the message is read once, for this conversation, and then forgotten. If it is a text file that would be worth having permanently — a transcript, a report, research — say so and ask whether to keep it: "want me to keep this in the library?" On a yes, call remember_file. Do not call it without asking, and do not ask about a file that is obviously ephemeral, like a screenshot of a chart. Images and PDFs cannot be kept either way.

Attribution. Three kinds of statement, never to be blurred into each other:
- Something a source says. "In the episode on DSCR you said..." — only when a search returned the passage carrying it, and you can name the document and the timestamp.
- Something the research shows. "The September Fannie Mae outlook projects..." — only with the source and date the tool returned.
- Something you think. "I'd suggest..." — your own recommendation, and it must be visibly yours.
Never present the third as the first or the second. Do not say something came from a transcript unless a transcript search returned it. If a tool result says degraded, semantic search was unavailable and you were shown keyword matches only — say the search was partial rather than concluding that nothing exists.

Retrieve progressively. Do not open by pulling everything you might conceivably need. Start with a search or two, see what comes back, and go deeper only on the thread that turns out to matter. A first pass is three to five sources; developing one specific video is five to ten passages on that video's subject; a final check is two or three. Retrieving a hundred passages up front produces a worse answer than retrieving six good ones, and costs the user more.

Write your own queries. The user's words are a brief, not a search string. "Something about investors" should become searches like "investor qualification", "investor financing objections", "DSCR for first-time investors" — several angles on the goal, not one echo of the phrasing.

Before you recommend an idea, run check_repetition on it. A verdict of duplicate or repetitive means drop it or re-angle it; related means it is worth making if the angle is genuinely different, and you should say what the difference is. Then save what is worth keeping with save_idea, including the source ids the idea was built from.

How to work:
- Search before you propose. An idea you did not ground in either corpus is a guess, and the user can tell.
- Check what Trilith has already published before suggesting a topic. If a post already covers it, say so and propose the angle that is genuinely new — a sharper hook, an update, a contrarian take — rather than pretending the ground is empty.
- When they ask for the evidence, quote competitor copy verbatim, name the advertiser, and link the ad using the ad_library_url the tool returns; link Trilith posts by their url. Otherwise keep the evidence out of the chat and put it in lock_video's evidence and source_ids, where it travels with the video.
- Prefer a few well-evidenced ideas over a long list of thin ones. For each, give a plain one-line title and the opening line written out as it would be spoken — nothing more unless they ask.
- Be direct. Lead with the answer or the ideas. No preamble, no restating the question.

What the evidence cannot support, and you must not imply otherwise:
- Ad count is not ad spend. The Ad Library reports creatives, never budget. A lender running 114 ads is not necessarily outspending one running 33.
- 'started' is when Meta says an ad launched; 'first_seen' is when our sweep first observed it. Only first_seen is ours, and the baseline sweep of 2026-08-15 makes everything look first-seen that day.
- Absence from the ad corpus means we did not observe it on Meta, not that it does not exist. Several large lenders advertise nowhere we can see.
- Only Trilith blog posts have publisher-stated dates. A date whose date_source is 'sitemap-lastmod' came from a file timestamp, not from the publisher — do not present it as a publication date.

Useful context: the biggest lenders by origination volume are mostly quiet on Meta. Kiavi originates roughly $8B a year against ~33 live ads, and its copy is brand-led — it almost never names a loan product. CoreVest has funded $7.8B and runs nothing. Regional shops outspend the giants on creative volume: Capital Fund 1 runs over 100. Trilith itself does not advertise on Meta and is not in the ad corpus.`;


/* Turn an SDK error into something the page can act on.
 *
 * Deliberately not `err instanceof Anthropic.RateLimitError`: those classes are
 * not defined on the bundled default export, so the comparison threw
 * "Right-hand side of 'instanceof' is not an object" *inside the catch block* —
 * which meant no error ever reached the client and the stream just ended. Match
 * on status and name instead, which survive any bundling. */
export function explain(err, fallback) {
  const status = Number(err?.status);
  const text = String(err?.message || '');
  if (status === 401 || status === 403 || /authentication|api[- ]?key/i.test(text)) {
    return 'The API key is missing or invalid on the server.';
  }
  /* Arrives as a plain 400, which reads as "your request was malformed" when
   * the request was fine and the account simply has no credit. */
  if (/credit balance/i.test(text)) {
    return 'The Anthropic account is out of credits. Top up under Plans & Billing at console.anthropic.com.';
  }
  if (status === 429) return 'Rate limited — wait a moment and try again.';
  if (status >= 500) return `Model error (${status}).`;
  if (status >= 400) return `Request rejected by the model (${status}).`;
  if (/connection|network|fetch failed|timeout/i.test(text) || err?.name === 'APIConnectionError') {
    return 'Could not reach the model. Try again.';
  }
  return fallback;
}

async function runTool(env, name, input, ctx = {}) {
  /* Plan tools mutate the session state carried by this request. They are not
   * searches and deliberately return a small acknowledgement rather than rows —
   * the page learns the new state from the plan_state event, not from here. */
  if (PLAN_TOOL_NAMES.has(name)) {
    const { error, result } = applyPlanTool(ctx.plan, name, input);
    if (error) throw new Error(error);
    ctx.planChanged = true;
    return result;
  }

  if (name === REMEMBER_TOOL.name) {
    const { error, result } = await rememberFile(env, ctx.texts, input, ctx.sessionId);
    if (error) throw new Error(error);
    return result;
  }

  if (KB_TOOL_NAMES.has(name)) return runKbTool(env, name, input, ctx);

  if (name === 'list_recordings') {
    const rows = await rpc(env, 'kb_recordings', { p_limit: 100 });
    return (rows || []).map((r) => ({
      id: r.id,
      name: r.name,
      minutes: r.seconds ? Math.round(r.seconds / 60) : null,
      words: r.words,
      status: r.status,
      uploaded: r.created_at,
    }));
  }

  if (name === 'read_recording') {
    const rec = await rpc(env, 'kb_recording_read', { p_id: String(input.id || '') });
    if (!rec) return { error: 'no recording with that id' };
    if (rec.status !== 'ready') {
      return { id: rec.id, name: rec.name, status: rec.status, error: rec.error || 'this recording is still being transcribed' };
    }
    /* Long enough for an hour of talking; a transcript past this is cut with
     * a note rather than silently ending mid-sentence. */
    const LIMIT = 60000;
    const text = String(rec.transcript || '');
    return {
      id: rec.id,
      name: rec.name,
      minutes: rec.seconds ? Math.round(rec.seconds / 60) : null,
      words: rec.words,
      transcript: text.length > LIMIT ? `${text.slice(0, LIMIT)}\n\n[cut here: the rest is searchable with search_transcripts]` : text,
    };
  }

  if (name === 'read_link') {
    const link = await rpc(env, 'kb_link_read', { p_id: String(input.id || '') });
    if (!link) return { error: 'no link with that id' };
    if (link.status !== 'ready') {
      return { id: link.id, url: link.url, status: link.status, error: link.error || 'this link is still being read' };
    }
    const LIMIT = 60000;
    const text = String(link.body || '');
    return {
      id: link.id,
      title: link.title,
      site: link.site,
      url: link.url,
      published: link.published_at,
      kind: link.kind,
      /* Said plainly, because a description reads like a summary of the video
       * and is nothing of the sort. */
      ...(link.partial ? { note: 'YouTube would not give up this video’s captions. What follows is its title, channel and description, not what was said in it.' } : {}),
      text: text.length > LIMIT ? `${text.slice(0, LIMIT)}\n\n[cut here: the rest is searchable with search_research]` : text,
    };
  }

  if (name === 'search_competitor_ads') {
    const rows = await rpc(env, 'adspy_search_ads', {
      q: input.query || null,
      advertiser: input.advertiser || null,
      product: PRODUCTS.includes(input.product) ? input.product : null,
      audience: ['broker', 'borrower'].includes(input.audience) ? input.audience : null,
      started_since: input.started_since || null,
      max_rows: clamp(input.limit, 12, 30),
    });
    return rows.map((r) => ({
      advertiser: r.advertiser_name,
      started: r.started,
      first_seen: r.first_seen,
      products: r.product_lines,
      audience: r.audience_tag,
      ad_library_url: r.ad_library_url,
      /* Long copy adds tokens without adding signal — the hook is at the top. */
      copy: String(r.copy || '').slice(0, 700),
    }));
  }

  if (name === 'search_trilith_content') {
    const rows = await rpc(env, 'content_search', {
      q: input.query || null,
      kind: KINDS.includes(input.kind) ? input.kind : null,
      since: input.since || null,
      max_rows: clamp(input.limit, 8, 20),
    });
    return rows.map((r) => ({
      title: r.title,
      url: r.url,
      kind: r.kind_tag,
      published: r.published,
      date_source: r.date_source,
      heading: r.heading,
      passage: r.passage,
    }));
  }

  if (name === 'count_ads') {
    const rows = await rpc(env, 'adspy_count_ads', {
      q: input.query || null,
      advertiser: input.advertiser || null,
      product: PRODUCTS.includes(input.product) ? input.product : null,
      audience: ['broker', 'borrower'].includes(input.audience) ? input.audience : null,
      started_since: input.started_since || null,
      group_by: ['advertiser', 'product', 'audience', 'month', 'none'].includes(input.group_by)
        ? input.group_by : 'advertiser',
    });
    return rows.map((r) => ({
      bucket: r.bucket,
      ads: r.ads,
      advertisers: r.advertisers,
      earliest: r.earliest,
      latest: r.latest,
      share_percent: r.share_percent,
    }));
  }

  if (name === 'search_hook_patterns') {
    const rows = await rpc(env, 'hook_patterns_search', {
      q: input.query || null,
      insight_type: ['HOOK', 'AD_ANGLE', 'USP'].includes(input.insight_type) ? input.insight_type : null,
      brand: input.brand || null,
      min_total: Number.isFinite(Number(input.min_total)) ? Number(input.min_total) : null,
      max_rows: clamp(input.limit, 15, 40),
    });
    return rows.map((r) => ({
      brand: r.brand_name,
      type: r.type_tag,
      pattern: r.label,
      /* Null on most rows: the REST endpoint reports no usage count, so only
       * patterns seeded from the MCP surface carry one. Null means unknown,
       * never zero — say so rather than reporting a pattern as unused. */
      times_used: r.total,
      /* Weeks the pattern kept appearing. The signal that is present on
       * everything, and the better one for "is this working". */
      weeks_running: r.weeks_active,
      /* Spyglass's own change figure against the previous window. Negative
       * means the brand is leaning on the pattern less than it was. */
      change: r.percent_delta,
      captured: r.captured_at,
    }));
  }

  if (name === 'trilith_coverage') {
    return rpc(env, 'content_coverage', {
      kind: KINDS.includes(input.kind) ? input.kind : null,
    });
  }

  throw new Error(`unknown tool: ${name}`);
}

/* Rebuild an assistant turn using only the fields the API accepts.
 *
 * finalMessage() hands back blocks decorated with SDK-side extras — a text
 * block carries `parsed`, for one — and echoing those straight back is rejected
 * with "messages.1.content.1.text.parsed: Extra inputs are not permitted",
 * which kills round two of every tool loop.
 *
 * Thinking blocks must survive intact, signature included: extended thinking
 * plus tool use requires the original reasoning to come back unmodified, and
 * dropping it is rejected just as hard as sending too much. */
function toApiBlocks(content) {
  return content.map((b) => {
    switch (b.type) {
      case 'text':
        return b.citations
          ? { type: 'text', text: b.text, citations: b.citations }
          : { type: 'text', text: b.text };
      case 'thinking':
        return { type: 'thinking', thinking: b.thinking, signature: b.signature };
      case 'redacted_thinking':
        return { type: 'redacted_thinking', data: b.data };
      case 'tool_use':
        return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      default:
        return b;
    }
  });
}

/* A short human-readable form of what was searched, for the transparency strip
 * in the UI. The model's own arguments, not a paraphrase. */
/* The strip renders "→ N". Only some tools return a bare array: the
 * knowledge-base tools wrap their rows in an object, and reporting
 * Array.isArray(rows) ? rows.length : 0 for those meant a search that found ten
 * passages displayed as one that found none — the transparency strip stating
 * the opposite of what happened.
 *
 * Tools that do not return rows at all get a short outcome instead of a number,
 * because "→ 0" on a call that locked video three is worse than no number. */
function toolOutcome(name, rows) {
  if (Array.isArray(rows)) return { count: rows.length };
  if (rows && Array.isArray(rows.results)) {
    return { count: rows.results.length, degraded: Boolean(rows.degraded) };
  }
  if (!rows || typeof rows !== 'object') return { count: 0 };

  switch (name) {
    case 'check_repetition':
      return {
        summary: rows.assessment
          + (rows.matches?.length ? ` · ${rows.matches.length} prior` : ''),
        degraded: Boolean(rows.note),
      };
    case 'set_video_count':
      return { summary: `${rows.target_count} video${rows.target_count === 1 ? '' : 's'}` };
    case 'lock_video':
      return { summary: rows.complete ? 'locked · plan complete' : `locked · ${rows.remaining} to go` };
    case 'unlock_video':
      return { summary: 'cleared' };
    case 'reject_idea':
      return { summary: 'noted' };
    case 'save_idea':
      return { summary: 'saved' };
    case 'remember_file':
      return { summary: rows.status === 'stored' ? `${rows.chunks} passages` : String(rows.status || 'done') };
    case 'read_link':
      return { summary: rows.text ? `${(rows.text.match(/\S+/g) || []).length} words` : String(rows.status || rows.error || 'not ready') };
    case 'read_recording':
      return { summary: rows.transcript ? `${rows.words || 0} words` : String(rows.status || rows.error || 'not ready') };
    default:
      return { count: Array.isArray(rows) ? rows.length : 0 };
  }
}

function describe(name, input) {
  if (KB_TOOL_NAMES.has(name)) return describeKbTool(name, input);
  if (name === 'list_recordings') return 'the recordings';
  if (name === 'read_recording') return 'reading a recording';
  if (name === 'read_link') return 'reading the link';

  const bits = [];
  if (input.query) bits.push(`"${input.query}"`);
  if (input.advertiser) bits.push(`advertiser: ${input.advertiser}`);
  if (input.product) bits.push(`product: ${input.product}`);
  if (input.audience) bits.push(`audience: ${input.audience}`);
  if (input.kind) bits.push(`kind: ${input.kind}`);
  if (input.since || input.started_since) bits.push(`since ${input.since || input.started_since}`);
  if (input.insight_type) bits.push(`type: ${input.insight_type}`);
  if (input.group_by) bits.push(`by ${input.group_by}`);
  /* Plan tools carry no query, so without these the strip said "everything" —
   * which is exactly wrong for a call that sets the batch to five. */
  if (input.count !== undefined) bits.push(`${input.count} video${input.count === 1 ? '' : 's'}`);
  if (input.slot !== undefined) bits.push(`slot ${input.slot}`);
  if (input.topic) bits.push(`topic: ${input.topic}`);
  if (input.name) bits.push(input.name);
  const label = {
    set_video_count: 'Batch size',
    lock_video: 'Locking a video',
    unlock_video: 'Unlocking a video',
    reject_idea: 'Noting a rejection',
    remember_file: 'Adding to the library',
    search_competitor_ads: 'Competitor ads',
    search_trilith_content: 'Trilith content',
    search_hook_patterns: 'Hook patterns',
    trilith_coverage: 'Trilith coverage',
    count_ads: 'Counting ads',
  }[name] || name;
  return { label, detail: bits.join(' · ') || 'everything' };
}

/* Decoded byte count of a base64 string, without decoding it. A 6MB PDF turned
 * into a Uint8Array purely to measure it would double the memory for nothing,
 * and a Worker has 128MB. */
function decodedSize(b64) {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/* Validate what the page sent and sort it into blocks the API understands.
 *
 * Throws rather than returning a partial set. Silently dropping the one file
 * the question was about produces an answer that reads as if the model looked
 * and found nothing, which is worse than an error — the user cannot tell the
 * difference from the reply.
 *
 * The browser checks the same limits before uploading. This check is the one
 * that counts: the page is static and anyone can POST here directly. */
export function buildAttachments(raw) {
  if (raw == null) return { blocks: [], texts: [] };
  if (!Array.isArray(raw)) throw new Error('attachments must be an array');
  if (raw.length > MAX_ATTACHMENTS) {
    throw new Error(`Too many files — ${MAX_ATTACHMENTS} at a time.`);
  }

  const blocks = [];
  const texts = [];
  let encodedTotal = 0;

  for (const a of raw) {
    if (!a || typeof a !== 'object') throw new Error('each attachment must be an object');
    const name = String(a.name ?? 'file').slice(0, 200);

    if (a.kind === 'text') {
      const text = String(a.text ?? '');
      if (!text.trim()) throw new Error(`${name} is empty.`);
      if (text.length > MAX_TEXT_CHARS) {
        throw new Error(`${name} is too long — text files are capped at ${MAX_TEXT_CHARS.toLocaleString()} characters.`);
      }
      texts.push({ name, text });
      continue;
    }

    const data = String(a.data ?? '');
    /* Base64 with newlines in it is rejected by the API, and the error it
     * returns does not say so. Catch it here where the message can. */
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0 || !data) {
      throw new Error(`${name} did not arrive as valid base64.`);
    }
    const bytes = decodedSize(data);
    encodedTotal += data.length;

    if (a.kind === 'image') {
      if (!IMAGE_TYPES.has(a.mediaType)) {
        throw new Error(`${name}: unsupported image type. Use JPEG, PNG, GIF or WebP.`);
      }
      if (bytes > MAX_IMAGE_BYTES) {
        throw new Error(`${name} is too large — images are capped at ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB.`);
      }
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: a.mediaType, data },
      });
    } else if (a.kind === 'document') {
      if (a.mediaType !== 'application/pdf') {
        throw new Error(`${name}: only PDFs are supported as documents.`);
      }
      if (bytes > MAX_PDF_BYTES) {
        throw new Error(`${name} is too large — PDFs are capped at ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB.`);
      }
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data },
        title: name,
      });
    } else {
      throw new Error(`${name}: unknown attachment kind.`);
    }
  }

  if (encodedTotal > MAX_ENCODED_TOTAL) {
    throw new Error(`Those files are too much at once — keep the batch under ${Math.round(MAX_ENCODED_TOTAL / 1024 / 1024)}MB.`);
  }

  return { blocks, texts };
}

/* Assemble the user turn. Images and PDFs go before the text, which is what the
 * API expects and also how a person reads it: here is the thing, now here is
 * the question about it. Text files are inlined into the prompt rather than
 * sent as documents — a fenced block the model can quote back is more useful
 * than an opaque attachment, and it costs nothing extra.
 *
 * Returns the bare string when nothing is attached, so the common request is
 * byte-identical to what it was before this feature existed. */
export function userContent(brief, attached) {
  const { blocks, texts } = attached;
  if (!blocks.length && !texts.length) return brief;

  const text = texts.length
    ? texts.map((t) => `--- Attached file: ${t.name} ---\n${t.text}`).join('\n\n') + `\n\n${brief}`
    : brief;

  /* Cache the attachments. The agent loop runs up to MAX_ROUNDS turns against
   * the same first message, so without a breakpoint here a PDF is re-sent at
   * full price on every round of a single question. */
  const cached = blocks.length
    ? blocks.map((b, i) => (i === blocks.length - 1
        ? { ...b, cache_control: { type: 'ephemeral' } }
        : b))
    : blocks;

  return [...cached, { type: 'text', text }];
}

export async function handleIdeas(request, env, headers, ctx) {
  /* Name the missing binding rather than both. A secret created with an empty
   * value looks present to `wrangler secret list` and to the version metadata,
   * so "one of these two is unset" sends you looking in the wrong place. */
  const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'].filter((k) => !env[k]);
  if (missing.length) {
    return json({
      error: `Not configured on the Worker: ${missing.join(', ')}.`,
      hint: 'SUPABASE_URL comes from [vars] in wrangler.toml; SUPABASE_ANON_KEY from `npx wrangler secret put SUPABASE_ANON_KEY`.',
    }, 503, headers);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'body must be JSON' }, 400, headers); }

  /* Planning mode asks for a fixed number of concepts and returns them as
   * structure. Capped at 12: past that the batch stops being reviewable, which
   * defeats the point of confirming before locking. */
  const planning = body.mode === 'plan';
  const count = planning
    ? Math.min(Math.max(parseInt(body.count, 10) || 5, 1), 12)
    : 0;

  /* In planning mode the count is the instruction; a free-text focus is
   * optional, so synthesise a brief rather than rejecting an empty one. */
  const brief = String(body.brief ?? '').trim()
    || (planning ? `Plan ${count} videos.` : '');
  if (!brief) return json({ error: 'brief is required' }, 400, headers);
  if (brief.length > MAX_BRIEF_CHARS) {
    return json({ error: `brief must be under ${MAX_BRIEF_CHARS} characters` }, 400, headers);
  }

  const history = Array.isArray(body.history)
    ? body.history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-MAX_HISTORY_TURNS)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }))
    : [];

  /* Session state travels with the request. It is the page's own state coming
   * back, so it is re-normalised rather than trusted. */
  const plan = normalisePlan(body.plan);
  const sessionId = String(body.session_id ?? '').slice(0, 64) || null;

  /* Recordings the person picked on the Plan page. Their names are looked up
   * here rather than trusted from the page, so the model is told what the
   * database actually has. */
  const picked = Array.isArray(body.recordings)
    ? [...new Set(body.recordings.map((r) => String(r)).filter((r) => UUID.test(r)))].slice(0, 5)
    : [];
  let recordingsNote = '';
  if (picked.length) {
    try {
      const chosen = (await rpc(env, 'kb_recordings_by_ids', { p_ids: picked })) || [];
      if (chosen.length) {
        recordingsNote = `\n\nRECORDINGS SELECTED FOR THIS SESSION (read each one in full with read_recording before proposing anything):\n`
          + chosen.map((r) => `- ${r.name} (id ${r.id}${r.status === 'ready' ? '' : `, ${r.status}`})`).join('\n');
      }
    } catch { /* the planner can still list them itself */ }
  }

  /* Links pasted into the box this session. Their titles are read back from
   * the database rather than trusted from the page. */
  const pickedLinks = Array.isArray(body.links)
    ? [...new Set(body.links.map((l) => String(l)).filter((l) => UUID.test(l)))].slice(0, 5)
    : [];
  let linksNote = '';
  if (pickedLinks.length) {
    try {
      const chosen = (await rpc(env, 'kb_links_by_ids', { p_ids: pickedLinks })) || [];
      if (chosen.length) {
        linksNote = `\n\nLINKS PASTED IN THIS SESSION (read each one in full with read_link before proposing anything):\n`
          + chosen.map((r) => `- ${r.title || r.url} (${r.site || r.kind}, id ${r.id}`
            + `${r.status === 'ready' ? '' : `, ${r.status}`}${r.partial ? ', description only — no transcript' : ''})`).join('\n');
      }
    } catch { /* the ids are still in the message; read_link works from them */ }
  }

  /* Spec section 38. Collected across the turn and written once at the end:
   * a round trip per search would add latency to the thing being waited on. */
  const searchLog = [];

  let attached;
  try { attached = buildAttachments(body.attachments); }
  catch (err) { return json({ error: err.message }, 400, headers); }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  /* Write through a TransformStream kept alive by ctx.waitUntil, rather than
   * doing the work inside ReadableStream.start(). Workers tears down pending
   * async work once the handler returns, so the start() form delivered the
   * first event and then closed the connection the moment it awaited the
   * model — a 200 with a truncated body and no exception anywhere. */
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const send = (e, d) => writer.write(enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));

  const work = (async () => {
      const messages = [...history, { role: 'user', content: userContent(brief + recordingsNote + linksNote, attached) }];
      let totals = { input: 0, output: 0, cacheRead: 0, searches: 0 };

      /* Emit immediately. The first round is usually thinking followed by tool
       * calls, which produce no text, so without this the page sits silent for
       * a long time and looks broken — and a silent stream is impossible to
       * tell apart from a stalled one when debugging. */
      send('start', { model: MODEL });

      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const model = client.beta.messages.stream({
            model: MODEL,
            max_tokens: 8000,
            thinking: { type: 'adaptive' },
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            system: [
              {
                type: 'text',
                text: SYSTEM,
                /* The instructions are identical on every turn and every round,
                 * and a session is several rounds deep. 1h TTL because usage is
                 * bursty — a planning session, then nothing for hours. */
                cache_control: { type: 'ephemeral', ttl: '1h' },
              },
              /* After the cache breakpoint, so switching modes does not
               * invalidate the cached prefix. */
              ...(planning
                ? [{ type: 'text', text: `${PLAN_SYSTEM}\n\nProduce exactly ${count} concepts.` }]
                : []),
              /* The session state, rebuilt every round because the model's own
               * tool calls change it mid-turn. Last, so it never invalidates
               * the cached prefix above. */
              { type: 'text', text: planBriefing(plan) },
            ],
            tools: planning ? [...TOOLS, PLAN_TOOL] : TOOLS,
            messages,
          });

          for await (const event of model) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              send('token', event.delta.text);
            }
          }

          const final = await model.finalMessage();

          totals.input += final.usage.input_tokens || 0;
          totals.output += final.usage.output_tokens || 0;
          totals.cacheRead += final.usage.cache_read_input_tokens || 0;

          if (final.stop_reason === 'refusal') {
            send('error', {
              message: 'That request was declined by the safety system. Try rephrasing it.',
            });
            break;
          }

          const calls = final.content.filter((b) => b.type === 'tool_use');
          if (!calls.length) break;

          /* submit_plan ends the run: it is the deliverable, not a search whose
           * result feeds another round. The API has already validated the shape
           * against the schema, so the page can render it directly. */
          const submitted = calls.find((c) => c.name === 'submit_plan');
          if (submitted) {
            const briefs = Array.isArray(submitted.input?.briefs) ? submitted.input.briefs : [];
            if (!briefs.length) {
              send('error', { message: 'The planner returned no concepts. Try again, or ask for fewer.' });
            } else {
              send('plan', {
                requested: count,
                briefs: briefs.slice(0, count).map((b) => ({
                  topic: String(b.topic || '').trim(),
                  hook_form: String(b.hook_form || '').trim(),
                  hook_source: String(b.hook_source || '').trim(),
                  opening_line: String(b.opening_line || '').trim(),
                  evidence: String(b.evidence || '').trim(),
                  product: b.product || null,
                  audience: b.audience || null,
                })),
              });
              /* Say so rather than silently trimming — asking for ten and
               * getting eight is something the reviewer should see. */
              if (briefs.length < count) {
                send('note', { message: `Returned ${briefs.length} of ${count} requested.` });
              }
            }
            break;
          }

          messages.push({ role: 'assistant', content: toApiBlocks(final.content) });

          const results = [];
          for (const call of calls) {
            const { label, detail } = describe(call.name, call.input || {});
            const toolCtx = { plan, texts: attached.texts, sessionId, searchLog };
            try {
              const rows = await runTool(env, call.name, call.input || {}, toolCtx);
              totals.searches += 1;
              send('tool', { label, detail, ...toolOutcome(call.name, rows) });
              /* The page mirrors the plan, so it must learn about a change the
               * moment it happens rather than at the end of the turn — a locked
               * video that appears only after the answer finishes reads as if
               * nothing was recorded. */
              if (toolCtx.planChanged) send('plan_state', plan);
              results.push({
                type: 'tool_result',
                tool_use_id: call.id,
                content: JSON.stringify(rows),
              });
            } catch (err) {
              send('tool', { label, detail, count: 0, failed: true });
              results.push({
                type: 'tool_result',
                tool_use_id: call.id,
                is_error: true,
                content: `Search failed: ${err.message}`,
              });
            }
          }

          messages.push({ role: 'user', content: results });

          /* Out of rounds, and the model was still searching. Rather than
           * ending with an error and nothing to show — which is what a broad
           * question used to produce after thirty-odd searches — take one more
           * turn with the tools removed. It has to answer from what it found. */
          if (round === MAX_ROUNDS - 1) {
            send('note', { message: 'Search budget reached — answering from what was found.' });

            const closing = client.beta.messages.stream({
              model: MODEL,
              max_tokens: 8000,
              thinking: { type: 'adaptive' },
              betas: ['server-side-fallback-2026-07-01'],
              fallbacks: 'default',
              system: [
                { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral', ttl: '1h' } },
                {
                  type: 'text',
                  text: 'You have used your search budget. Answer now from what the searches already returned. Do not ask for more searches. If the evidence is thinner than you would like, say which part is thin rather than withholding the answer.',
                },
                { type: 'text', text: planBriefing(plan) },
              ],
              /* The history is full of tool_use / tool_result blocks, and the
               * API refuses those without the tools they refer to. So the same
               * tools go along — which also keeps the cached prefix — and
               * tool_choice none is what stops it searching. */
              tools: planning ? [...TOOLS, PLAN_TOOL] : TOOLS,
              tool_choice: { type: 'none' },
              messages,
            });

            for await (const event of closing) {
              if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                send('token', event.delta.text);
              }
            }
            const last = await closing.finalMessage();
            totals.input += last.usage.input_tokens || 0;
            totals.output += last.usage.output_tokens || 0;
            totals.cacheRead += last.usage.cache_read_input_tokens || 0;
          }
        }

        /* The authoritative state, sent every turn whether or not it changed.
         * A page that missed a mid-turn plan_state event still ends up correct. */
        send('plan_state', plan);

        /* Persist the plan and the search log. Both are best-effort: a failure
         * here must not turn a good answer into an error the user sees, because
         * the answer has already been streamed and is not coming back. */
        if (sessionId) {
          try {
            await rpc(env, 'kb_plan_save', {
              p_session_id: sessionId,
              payload: {
                brand_slug: 'trilith',
                goal: plan.goal,
                target_count: plan.target_count,
                slots: plan.slots,
                rejected: plan.rejected,
              },
            });
          } catch (err) { console.error('plan save failed:', err?.message); }
        }

        if (searchLog.length) {
          try {
            const brandId = await rpc(env, 'kb_brand_id', { p_slug: 'trilith' });
            await rpc(env, 'kb_log_retrievals', {
              payload: searchLog.map((e) => ({ ...e, brand_id: brandId })),
            });
          } catch (err) { console.error('retrieval log failed:', err?.message); }
        }
        send('done', { model: MODEL, usage: totals, plan_complete: planIsComplete(plan) });
      } catch (err) {
        /* Surfaces in `wrangler tail`. The page gets a sanitised message; the
         * operator needs the real one. */
        console.error('ideas route failed:', err?.name, err?.message);
        send('error', { message: explain(err, 'Something went wrong generating ideas.') });
      } finally {
        await writer.close();
      }
  })();

  ctx.waitUntil(work);

  return new Response(readable, {
    headers: {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...headers, 'content-type': 'application/json' },
  });
}
