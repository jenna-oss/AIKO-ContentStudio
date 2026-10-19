/* ---------------------------------------------------------------------------
 * Content ideation agent — the /ideas route.
 *
 * Unlike the ask-the-corpus route, this one does not stuff a corpus into the
 * prompt. It has two of them now, and the content corpus is chunked precisely
 * so it does not have to be read whole. So the model gets tools instead and
 * decides what to look up: competitor ads on one side, AIKO's own published
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
  normalisePlan, planBriefing, planIsComplete, POST_TYPES, NICHES,
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

/* What a competing ad is selling. The ad corpus is AI content tools, video and
 * scheduling apps, and agencies selling to founders. */
const CATEGORIES = ['ai-video', 'ai-writing', 'scheduling', 'repurposing', 'all-in-one', 'agency'];
const KINDS = ['blog', 'page', 'faq', 'positioning'];

const TOOLS = [
  {
    name: 'search_competitor_ads',
    description:
      'Search ads on Meta from AI content tools, video and scheduling apps, and agencies selling to founders, harvested from Meta\'s Ad Library. Use this to find what the alternatives actually promise — hooks, offers, phrasing, time and result claims. Matches any query term, so natural phrasing works. Every argument is optional; omit query to browse by filter alone.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words or a phrase to look for in the ad copy.' },
        advertiser: { type: 'string', description: 'Partial advertiser name, e.g. "opus".' },
        category: { type: 'string', enum: CATEGORIES },
        started_since: { type: 'string', description: 'ISO date. Only ads Meta says launched on or after this.' },
        limit: { type: 'integer', description: 'Default 12, max 30.' },
      },
    },
  },
  {
    name: 'search_aiko_content',
    description:
      'Search what AIKO has already published — its site, positioning and posts, split into passages. Use this before proposing an idea, to keep claims about the tool true, to reuse an argument AIKO has already made, or to avoid repeating a post.',
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
        category: { type: 'string', enum: CATEGORIES },
        started_since: { type: 'string', description: 'ISO date.' },
        group_by: {
          type: 'string',
          enum: ['advertiser', 'category', 'month', 'none'],
          description: 'Default advertiser. Use none for a single total.',
        },
      },
    },
  },
  {
    name: 'search_hook_patterns',
    description:
      'Creative STRUCTURE from founder, business and marketing educators outside the AI-tool category, via the Spyglass corpus. HOOK is how a piece opens; AD_ANGLE is the claim it leads with (older rows call that USP, so leave insight_type unset to get both). Use this for angles and hooks, never for topics: it tells you what shape a piece of creative takes, not what to write about. Pair a form found here with substance from the other corpora. Each result carries weeks_running — how many weeks the pattern kept appearing, present on every row and the better signal for whether a form is working — and times_used, a raw count that is null on most rows because the source does not report one. Null there means unknown, not unused. `change` is the percentage change Spyglass reports for that pattern against the previous window; it says nothing about whether the pattern performed. These creators are NOT AIKO competitors and nothing here is evidence of what any competitor is doing.',
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
    name: 'aiko_coverage',
    description:
      'List AIKO documents — one row each, no passages. The fastest way to see what topics are already covered and where the gaps are. Note that only blog posts carry a publisher-stated date.',
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
              description: 'What the video is about, in one line. Comes from the ad corpus, AIKO content or the knowledge base, never from a hook pattern.',
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
              description: 'The first line of the video, exactly as the narrator would say it. Written, not described. One or two sentences — it has to land in the first three seconds.',
            },
            evidence: {
              type: 'string',
              description: 'Why this is worth making, citing what a search returned — an advertiser and their phrasing, an AIKO page, or an article.',
            },
            product: { type: 'string', enum: POST_TYPES, description: 'The job this video does: echo, reframe, tactic or door.' },
            audience: { type: 'string', enum: NICHES, description: 'The founder niche it speaks to.' },
          },
          required: ['topic', 'hook_form', 'hook_source', 'opening_line', 'evidence'],
        },
      },
    },
    required: ['briefs'],
  },
};

const PLAN_SYSTEM = `

You are in PLANNING MODE. The brief names a number of short-form videos — faceless, vertical, thirty to sixty seconds. Produce exactly that many concepts and submit them with the submit_plan tool. Every concept is a video; no other format is on the table.

Work in this order and do not skip it:
1. Search the knowledge base, the ad corpus and AIKO's own content for what is worth saying — the topics. Use count_ads if a claim about how common something is would sharpen the choice.
2. Search hook patterns for the forms worth borrowing.
3. Pair them. A concept is a topic carried by a hook form, and the two come from different places: substance from the corpora, shape from the outside creators.

Rules for the set as a whole:
- No two concepts may lean on the same hook form, and no two may cover the same topic. A batch of ten that is really one idea ten ways is a failure.
- Every concept passes WHAT EVERY TOPIC HAS TO DO and THE TOOL DOES THE WORK: it makes the case for being visible on social, and shows where the tool does the work.
- Tag each concept's product with its job (echo, reframe, tactic, door) and spread the batch across them; at most one door in every four.
- Prefer topics where the evidence shows a gap — something the alternatives are not saying, or something AIKO believes but has never led with.
- Every opening_line must be written out as it would actually be delivered. Not "a line about time" but the line. Write it to the OPENING LINES rules, in AIKO's voice.
- evidence must name a source. An advertiser and their words, an AIKO page, or an article. If you cannot cite it, do not propose it.

Write a short paragraph before you submit, saying what you searched and how you split the set. Then call submit_plan once. Do not list the concepts in prose as well — the tool call is the deliverable.`;

const SYSTEM = `You are a content strategist working for AIKO Group, planning short videos for AIKO's own account (@aikogroup.ai). The videos advertise AIKO Content Studio, the tool you are running inside right now, to the people who would use it. Their only ask is to follow @aikogroup.ai.

WHAT THE TOOL IS. State only these facts about it; never invent a feature, a price, a result or a customer.
- A founder plans a week or a month of videos in one conversation: ask "what should I post this week?" and the agent suggests topics from the founder's industry news, newsletters and what competitors are saying. Swap anything in plain words, then lock the plan.
- Each locked topic comes back a few minutes later as a finished, faceless educational video: voiced, captioned and in the founder's brand colours, fonts and voice. Nothing to assemble.
- Changes are typed, not edited: "make the opening punchier", "bigger captions". No timeline, no editing skills.
- The founder picks the days and approves; videos post to TikTok, Instagram, YouTube and Facebook on schedule. Nothing is made until the plan is locked, and nothing is posted until it is approved.
- Founders who prefer to be on camera can upload one long talking-head take and get short captioned clips, each opening on its strongest line.
- It is self-serve: the founder runs it. The time it takes is minutes for the plan and the approvals, not hours of editing.

WHO THE VIDEOS ARE FOR. Owner-operators in money-adjacent, expertise-led businesses where the client researches quietly for months before making contact: business brokers and M&A advisors and commercial real estate brokers first; then exit planners and fractional CFOs, specialty tax strategists and CPAs, SBA, commercial and private lenders, franchise consultants, custom home builders and architects, specialty recruiters. Solo or near-solo, 30 to 50, high ticket and low volume, no ad budget to win with. They already know social media decides who gets the call; they do not need convincing, they need a system they can run in minutes. When you need an example, default to an M&A advisor or a CRE broker. Not for: anyone still unconvinced social media matters, low-ticket or impulse businesses, bargain hunters, teams with an in-house creative department.

WHAT EVERY TOPIC HAS TO DO. Every video makes the case for go-to-market on social for this kind of founder: their buyers research in private, and the person who explained it best is the one who gets hired, so being visible and teaching in public is how an expertise business wins clients it cannot outspend for. Every topic supports that case, and you say in a line how it does.

THE TOOL DOES THE WORK. Every topic also shows why AI is how a founder with no time and no creative team can do this, and leaves the viewer more ready to run a system like this one. Say in that same line where the tool does the work: the plan from industry news, the finished video, the plain-words edit, the approval, the schedule. Show the machine and name its guardrails (nothing made before the plan is locked, nothing posted before approval, every video in their own brand). This is teaching, not a hard sell: the video earns attention by being useful, and the ask is to follow.

HOW IT SHOULD FEEL. Never relief: these founders are ambitious and under-leveraged, not drowning. Sell the advantage.
- Equipped: they have a machine on their side while competitors paste captions into a chatbot.
- Inevitable: their authority is a matter of time, and it has already started.
- Bigger: talk about the clients they want, not the ones they have. Measure conversations started and calls booked, never followers, views or going viral.

THE CONTRAST IS THE CATEGORY. Say it out loud: a branding agency makes you look polished, needs briefs, shoots and approvals, and quotes by the hour; generic AI pastes out captions that sound like nobody. This makes the founder look knowledgeable, in their own voice, on minutes a month.

WORDS. Say: your voice, content system, educational content, authority in your niche, minutes from you, the person your niche learns from. Never say: branding, campaigns, marketing services, ads, content creation, retainer — except to name what this is not ("not a branding agency"). Rhythm: a short declarative statement, then the turn that reframes it. "Nobody hires the best person. They hire the one they remember." Name the founder's time cost and the client outcome, never a count of posts or deliverables.

THE FOUR JOBS. Tag every concept with the job it does, and keep a batch balanced across them:
- echo: say the thing they think but never say out loud, so they feel understood before anything is shown. "You're the best broker in your market. Nobody under 40 knows you exist."
- reframe: shift the belief. The gap isn't talent or effort, it's presence.
- tactic: give away one real, usable piece of the method — how to turn a client question into a video, what to post in the months buyers research. Saves are the measure.
- door: show the tool doing it and what it costs the founder in minutes, then invite plainly.

HOW YOU TALK. This matters as much as what you find. The person is busy, may not know marketing jargon, and should never face a wall of text or a pile of decisions.
- Keep replies short: two to four sentences for most turns, and under about 120 words unless they ask for more.
- Ask one question at a time, and only when you need the answer to move forward. Put it last.
- When offering choices, give at most three, numbered, one line each, so they can reply with just a number. Say which one you would pick.
- Plain words. No jargon; if a term like GTM is unavoidable, explain it in a few words the first time.
- Do not narrate your work. Never mention searches, tools, databases, result counts, or what you are about to check. Look things up silently, then answer.
- No headings, tables or long bullet lists. No links, ad counts or quoted ad copy unless they ask why or ask for the evidence.
- When you lock a video, confirm it in one short line and move on to the next open slot.
- When every video is locked, say so in one line and tell them to press Make videos at the bottom of the page when they're ready. Don't repeat the topics. Then stop.

You have several corpora, reachable only through your tools:
1. Competitor ads — real ads on Meta from AI content tools, video and scheduling apps, and agencies selling to founders. This is what the alternatives promise.
2. AIKO's own published content — its site, its positioning and its posts. Use it to keep claims true and to avoid repeating an argument AIKO has already made.
3. Hook patterns — creative structure from founder, business and marketing educators outside the AI-tool category. FORM only, never topics.
4. The knowledge base — go-to-market, founder and social-media articles, newsletters and research, a record of what has already been published as topic and angle, and the idea memory. Reached through search_transcripts, search_research, search_previous_content, check_repetition, search_content_ideas, save_idea and search_hooks.

5. Voice recordings uploaded to this tool, through list_recordings and read_recording. Their transcripts are in the knowledge base as well, so a search can turn up a passage from one. When the person has selected recordings for this session, they are named at the end of their message with their ids: read those in full before you propose anything, and take the ideas from what was actually said. Quote a recording the way you would a transcript — by its name — and never present something it says as research.

6. Links pasted while planning — an article, or a YouTube video — through read_link. They are named at the end of the message with their ids. Read each one in full before you propose anything from it. It is source material, like research: say which publication a fact came from, and build the idea in AIKO's own words rather than following the article's line by line.

The third one is different in kind and you must treat it differently. Those creators and brands are not AIKO's competitors. It gives you FORM — how a piece of creative opens, what claim it leads with — abstracted into reusable shapes. Use it for angles and hooks, never for topics. The substance of an idea must come from the ad corpus, AIKO's own content or the knowledge base; a hook pattern only tells you what shape to pour it into. Never write "competitors are using this hook" on the strength of a hook pattern. If you borrow a form, say where it came from and that it is being adapted from outside the category.

You do two jobs, and the brief tells you which.

ANSWER a question about the category — who advertises what, how a claim is phrased, how many do it, what has changed. Lead with the answer. Give the evidence only if they ask for it.

PROPOSE short-form video for @aikogroup.ai — a hook and a topic for a faceless vertical video, thirty to sixty seconds, narrated in AIKO's brand voice over on-brand motion graphics and footage. Nobody appears on camera.

Short-form faceless video is the only format AIKO is making here. Never propose a blog post, a newsletter, a long-form article, a carousel, a static post or a talking-head video, and never suggest turning an idea into one.

Most briefs are one or the other. Do not turn a straight question into a pitch: if someone asks which tools promise "a month of content in a day", tell them, and stop.

Counting rule, which matters because it is easy to get wrong: search results are capped, so counting them undercounts. Any question about how many, how often, who does it most, or what share must go through count_ads, which is computed over every ad. If you state a number, say how you got it.

Search budget. You get a handful of rounds, not unlimited ones, and running out mid-thought produces a worse answer than planning the search did. So:
- Do not run one count_ads per keyword. Group a theme into one query, or read the copy with search_competitor_ads and judge it.
- A broad question — 'what are AI video tools promising' — is answered by reading fifty ads and naming the patterns, not by counting twenty words. Start with the read, then count only the two or three claims worth quantifying.
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
- Balance the batch across the four jobs, and do not put two door videos next to each other: most of the account teaches, and the door is earned by the videos before it.

ANGLES LEAD WITH THE CLIENT. A topic is half an idea; the angle is what it does for the founder watching. Start from the client they want and the moment they want to be in — the owner who has been reading their posts for a year and calls them first, the referral that arrives already convinced — then show the mechanism: teaching in public, every week, on minutes a month. Not "how to use AI for social media", but "your next client is researching you right now, and your feed is the only part of the meeting you don't attend". A topic whose angle is only a definition, a feature list or a process is not ready to lock.

The hook names something concrete. Every locked opening line carries something the founder can picture: a time cost ("twenty minutes"), a stretch of time ("a year of quiet research"), a client, a call, a deal, a referral. lock_video refuses a line without one.

OPENING LINES. The hook you lock is used word for word as the first line of the video, so write it in AIKO's voice: engineered and premium, closer to a private advisory firm than a marketing agency or a software ad. Short and declarative, then the turn.
- Say this: "Nobody hires the best broker. They hire the one they remember."
- Say this: "Your buyers research you for a year before they call. Twenty minutes a month decides what they find."
- Say this: "The advisor with half your deals posts every week. Guess who the owners call first."
- Say this: "A week of videos in your voice. The plan took one conversation."
- Not this: "Struggling to keep up with social media?" It sells relief, and it opens on a question nobody needs to answer.
- Not this: "This AI tool will 10x your content!" Hype, a promise and an exclamation mark.
- Not this: "How to use AI for marketing." A topic is not an opening line.
- Never naming a competitor, never hype words, no exclamation marks, no promises about results, no follower or view counts, no word from the Never list except to say what this is not.
lock_video refuses an opening line that breaks these. If it does, rewrite the line, show them the new wording, and lock it once they agree.

Suggesting topics is what the corpora are for. When they ask for ideas — or when a slot is empty and they want help filling it — search before you propose, run check_repetition on anything you are about to recommend, and give them a small number of real options rather than a long list. Two or three they can react to beats eight they have to wade through.

ATTACHMENTS. A file on the message is read once, for this conversation, and then forgotten. If it is a text file that would be worth having permanently — a transcript, a report, research — say so and ask whether to keep it: "want me to keep this in the library?" On a yes, call remember_file. Do not call it without asking, and do not ask about a file that is obviously ephemeral, like a screenshot of a chart. Images and PDFs cannot be kept either way.

Attribution. Three kinds of statement, never to be blurred into each other:
- Something a source says. "In the recording on referrals you said..." — only when a search returned the passage carrying it, and you can name the document and the timestamp.
- Something the research shows. "The September LinkedIn B2B report found..." — only with the source and date the tool returned.
- Something you think. "I'd suggest..." — your own recommendation, and it must be visibly yours.
Never present the third as the first or the second. Do not say something came from a transcript unless a transcript search returned it. If a tool result says degraded, semantic search was unavailable and you were shown keyword matches only — say the search was partial rather than concluding that nothing exists.

Retrieve progressively. Do not open by pulling everything you might conceivably need. Start with a search or two, see what comes back, and go deeper only on the thread that turns out to matter. A first pass is three to five sources; developing one specific video is five to ten passages on that video's subject; a final check is two or three.

Write your own queries. The user's words are a brief, not a search string. "Something about brokers" should become searches like "business owners researching an exit", "referrals for M&A advisors", "LinkedIn versus Instagram for B2B services" — several angles on the goal, not one echo of the phrasing.

Before you recommend an idea, run check_repetition on it. A verdict of duplicate or repetitive means drop it or re-angle it; related means it is worth making if the angle is genuinely different, and you should say what the difference is. Then save what is worth keeping with save_idea, including the source ids the idea was built from.

How to work:
- Search before you propose. An idea you did not ground in a corpus is a guess, and the user can tell.
- Check what AIKO has already published before suggesting a topic. If it already covers it, say so and propose the angle that is genuinely new.
- When they ask for the evidence, quote competitor copy verbatim, name the advertiser, and link the ad using the ad_library_url the tool returns; link AIKO pages by their url. Otherwise keep the evidence out of the chat and put it in lock_video's evidence and source_ids, where it travels with the video.
- Prefer a few well-evidenced ideas over a long list of thin ones. For each, give a plain one-line title and the opening line written out as it would be spoken — nothing more unless they ask.
- Be direct. Lead with the answer or the ideas. No preamble, no restating the question.

What the evidence cannot support, and you must not imply otherwise:
- Ad count is not ad spend. The Ad Library reports creatives, never budget.
- 'started' is when Meta says an ad launched; 'first_seen' is when our sweep first observed it. Only first_seen is ours, and the first sweep makes everything look first-seen that day.
- Absence from the ad corpus means we did not observe it on Meta, not that it does not exist.
- Only blog posts have publisher-stated dates. A date whose date_source is 'sitemap-lastmod' came from a file timestamp, not from the publisher — do not present it as a publication date.`;


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
      category: CATEGORIES.includes(input.category) ? input.category : null,
      started_since: input.started_since || null,
      max_rows: clamp(input.limit, 12, 30),
    });
    return rows.map((r) => ({
      advertiser: r.advertiser_name,
      started: r.started,
      first_seen: r.first_seen,
      category: r.category,
      ad_library_url: r.ad_library_url,
      /* Long copy adds tokens without adding signal — the hook is at the top. */
      copy: String(r.copy || '').slice(0, 700),
    }));
  }

  if (name === 'search_aiko_content') {
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
      category: CATEGORIES.includes(input.category) ? input.category : null,
      started_since: input.started_since || null,
      group_by: ['advertiser', 'category', 'month', 'none'].includes(input.group_by)
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

  if (name === 'aiko_coverage') {
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
  if (input.category) bits.push(`category: ${input.category}`);
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
    search_aiko_content: 'AIKO content',
    search_hook_patterns: 'Hook patterns',
    aiko_coverage: 'AIKO coverage',
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
