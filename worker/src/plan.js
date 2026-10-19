/* ---------------------------------------------------------------------------
 * The planning session — what turns /ideas from question-and-answer into a
 * conversation that arrives somewhere.
 *
 * Spec section 4D: session context is the current weekly goal, the number of
 * videos, what is locked, what has been rejected. It belongs in the planning
 * session and NOT in the retrieval corpus — nobody should ever retrieve
 * "5 videos, DSCR locked in slot 2" as though it were source material.
 *
 * So the state is carried, not stored: the page sends it, the model mutates it
 * through tools, the Worker sends it back. The Worker stays stateless, which is
 * what lets two people open the same plan and neither of them be wrong.
 *
 * Everything arriving from the page is untrusted and re-normalised here. It is
 * the client's own state coming back, but it has been through a browser.
 * ------------------------------------------------------------------------ */

import { rpc } from './db.js';
import {
  estimateTokens, chunkProse, parseCues, parsePlainTranscript, chunkTranscript,
} from '../../tools/kb-chunk.mjs';

const MAX_VIDEOS = 12;
const MAX_REJECTED = 40;
const MAX_TEXT = 4000;
const PRODUCTS = ['dscr', 'fix-and-flip', 'bridge', 'ground-up', 'portfolio', 'brrrr', 'multifamily'];

const str = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : null);

/* The opening line is used word for word as the video's first line, so it is
 * checked here, before it can be locked, rather than only flagged later by the
 * video pipeline. The pipeline's voice rules, plus the ways a lender's voice
 * slips in: plans were first written for Trilith, and a locked "Ours means..."
 * went straight into a video. */
const HOOK_RULES = [
  [/\btrilith\b/i, 'it names Trilith'],
  [/\bwe(?:'ll|'ve|'re)?\s+(?:fund|lend|financ|approv|close|offer)\w*|\bour\s+(?:rates?|loans?|programs?|terms|products?|lending|funding|money)\b|\bours\b/i, 'it speaks as a lender'],
  [/\b(?:incredible|unbelievable|insane|crazy|mind-?blowing|game-?changer|jaw-?dropping)\b/i, 'it uses hype'],
  [/\byou won'?t believe\b/i, 'it is clickbait'],
  [/\b(?:obviously|everyone knows|as we all know)\b/i, 'it talks down'],
  [/\b(?:guarantee[ds]?|risk-?free|can'?t lose|will definitely|sure thing)\b/i, 'it promises the future'],
  [/!/, 'it has an exclamation mark'],
];

/* The first line has to name the money: a figure the viewer can picture, in
 * digits or in words. A hook that opens on a mechanism makes the video's
 * first job a rescue, which is not what this channel is for. */
const MONEY = /[$£€]|\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)\b[\s\w-]{0,24}\b(?:percent|dollars?|points?|grand|figures|rent|income|deposit|equity|profit|cash|months?|weeks?|years?|deals?|flips?|doors?|units?)\b/i;

export const hookProblems = (line) => {
  const problems = HOOK_RULES.filter(([re]) => re.test(line)).map(([, why]) => why);
  if (!MONEY.test(String(line || ''))) problems.push('it does not name the money');
  return problems;
};

/* A source id was capped at 64 because chunk ids are UUIDs and 36 characters.
 * The agent cites URLs, which are longer, so every Trilith link in the first
 * exported plan was silently cut mid-slug — including one that still looked
 * like a whole URL, which is the worse failure: a dead link that reads as a
 * live one. Long enough for any real URL, and still bounded. */
const SOURCE_ID_MAX = 500;

export const emptyPlan = () => ({
  goal: null,
  target_count: null,
  slots: [],
  rejected: [],
});

const emptySlot = () => ({
  status: 'empty',
  topic: null, angle: null, hook: null, opening_line: null,
  evidence: null, product: null, audience: null, source_ids: [],
});

/* The page holds this between turns, so it arrives as whatever localStorage had
 * in it. Rebuild it field by field rather than trusting the shape. */
export function normalisePlan(input) {
  const plan = emptyPlan();
  if (!input || typeof input !== 'object') return plan;

  plan.goal = str(input.goal, 300);

  const n = Number(input.target_count);
  plan.target_count = Number.isInteger(n) && n >= 1 && n <= MAX_VIDEOS ? n : null;

  const slots = Array.isArray(input.slots) ? input.slots.slice(0, MAX_VIDEOS) : [];
  plan.slots = slots.map((s) => {
    const slot = emptySlot();
    if (!s || typeof s !== 'object') return slot;
    slot.topic = str(s.topic, 200);
    slot.angle = str(s.angle, 400);
    slot.hook = str(s.hook, 400);
    slot.opening_line = str(s.opening_line, 400);
    slot.evidence = str(s.evidence, 800);
    slot.product = PRODUCTS.includes(s.product) ? s.product : null;
    slot.audience = ['broker', 'borrower'].includes(s.audience) ? s.audience : null;
    slot.source_ids = Array.isArray(s.source_ids)
      ? s.source_ids.map((id) => str(id, SOURCE_ID_MAX)).filter(Boolean).slice(0, 12) : [];
    slot.status = slot.topic ? 'locked' : 'empty';
    return slot;
  });

  /* The count is the authority on how many slots exist. A plan that says five
   * with three slots is a plan the page and the model would each read
   * differently. */
  if (plan.target_count !== null) resize(plan, plan.target_count);

  plan.rejected = (Array.isArray(input.rejected) ? input.rejected : [])
    .slice(0, MAX_REJECTED)
    .map((r) => ({ topic: str(r?.topic, 200), reason: str(r?.reason, 300) }))
    .filter((r) => r.topic);

  return plan;
}

function resize(plan, count) {
  while (plan.slots.length < count) plan.slots.push(emptySlot());
  /* Shrinking drops from the end, but never silently drops a locked video —
   * losing agreed work to a typed number would be infuriating. Locked slots are
   * compacted forward instead. */
  if (plan.slots.length > count) {
    const locked = plan.slots.filter((s) => s.status === 'locked');
    const kept = locked.slice(0, count);
    plan.slots = kept.concat(
      Array.from({ length: Math.max(0, count - kept.length) }, emptySlot)
    );
  }
}

export const planIsComplete = (plan) =>
  plan.target_count !== null
  && plan.slots.length === plan.target_count
  && plan.slots.every((s) => s.status === 'locked');

/* --- the tools ----------------------------------------------------------- */

export const PLAN_TOOLS = [
  {
    name: 'set_video_count',
    description:
      'Record how many videos this batch will contain, once the person has agreed a number. Call this as soon as the number is settled and before locking any topic — the slots do not exist until you do. Call it again if they change their mind; locked videos are kept and moved forward.',
    input_schema: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: `How many videos. 1 to ${MAX_VIDEOS}.` },
        goal: { type: 'string', description: 'The stated aim for the batch, if they gave one. e.g. "build authority on DSCR".' },
      },
      required: ['count'],
    },
  },
  {
    name: 'lock_video',
    description:
      'Fix the topic for one video, once the person has actually agreed to it. Do not call this on your own suggestion — only when they have said yes to it. Include the source_ids of whatever the idea was built from, so the claim behind it stays checkable.',
    input_schema: {
      type: 'object',
      properties: {
        slot: { type: 'integer', description: 'Which video, counting from 1.' },
        topic: { type: 'string', description: 'What the video is about, in one line.' },
        angle: { type: 'string', description: 'The specific argument it makes about that topic.' },
        hook: { type: 'string', description: 'The opening line as it would be spoken, if it is settled. In the channel voice (The Buy Box): never as a lender, never naming Trilith, no hype.' },
        evidence: { type: 'string', description: 'Why it is worth making, citing what a search returned.' },
        product: { type: 'string', enum: PRODUCTS },
        audience: { type: 'string', enum: ['broker', 'borrower'] },
        source_ids: {
          type: 'array', items: { type: 'string' },
          description: 'chunk_id or document_id values from search results supporting this.',
        },
      },
      required: ['slot', 'topic'],
    },
  },
  {
    name: 'unlock_video',
    description: 'Clear a slot when the person changes their mind about a topic they had agreed.',
    input_schema: {
      type: 'object',
      properties: { slot: { type: 'integer', description: 'Which video, counting from 1.' } },
      required: ['slot'],
    },
  },
  {
    name: 'reject_idea',
    description:
      'Record that an idea was considered and turned down, with the reason. Rejected ideas are shown back to you on later turns so you do not re-propose something already dismissed.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        reason: { type: 'string', description: 'Why they passed on it. Brief.' },
      },
      required: ['topic'],
    },
  },
];

export const PLAN_TOOL_NAMES = new Set(PLAN_TOOLS.map((t) => t.name));

export function applyPlanTool(plan, name, input) {
  if (name === 'set_video_count') {
    const count = Number(input.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_VIDEOS) {
      return { error: `count must be a whole number from 1 to ${MAX_VIDEOS}.` };
    }
    plan.target_count = count;
    if (input.goal) plan.goal = str(input.goal, 300);
    resize(plan, count);
    const locked = plan.slots.filter((s) => s.status === 'locked').length;
    return {
      result: {
        target_count: count,
        locked,
        remaining: count - locked,
        note: locked ? `${locked} already-locked video(s) kept.` : undefined,
      },
    };
  }

  if (name === 'lock_video') {
    if (plan.target_count === null) {
      return { error: 'Set the number of videos first — there are no slots to lock into yet.' };
    }
    const slot = Number(input.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > plan.slots.length) {
      return { error: `slot must be between 1 and ${plan.slots.length}.` };
    }
    const topic = str(input.topic, 200);
    if (!topic) return { error: 'topic is required.' };

    const hook = str(input.hook, 400);
    const problems = hook ? hookProblems(hook) : [];
    if (problems.length) {
      return {
        error: `That opening line can't be locked as written: ${problems.join('; ')}. Rewrite it in The Buy Box's voice, show them the new wording, and lock it once they agree.`,
      };
    }

    plan.slots[slot - 1] = {
      status: 'locked',
      topic,
      angle: str(input.angle, 400),
      hook: str(input.hook, 400),
      opening_line: str(input.hook, 400),
      evidence: str(input.evidence, 800),
      product: PRODUCTS.includes(input.product) ? input.product : null,
      audience: ['broker', 'borrower'].includes(input.audience) ? input.audience : null,
      source_ids: Array.isArray(input.source_ids)
        ? input.source_ids.map((id) => str(id, SOURCE_ID_MAX)).filter(Boolean).slice(0, 12) : [],
    };

    const locked = plan.slots.filter((s) => s.status === 'locked').length;
    return {
      result: {
        slot, locked, remaining: plan.target_count - locked,
        complete: planIsComplete(plan),
        empty_slots: plan.slots
          .map((s, i) => (s.status === 'empty' ? i + 1 : null)).filter(Boolean),
      },
    };
  }

  if (name === 'unlock_video') {
    const slot = Number(input.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > plan.slots.length) {
      return { error: `slot must be between 1 and ${plan.slots.length}.` };
    }
    plan.slots[slot - 1] = emptySlot();
    return { result: { slot, locked: plan.slots.filter((s) => s.status === 'locked').length } };
  }

  if (name === 'reject_idea') {
    const topic = str(input.topic, 200);
    if (!topic) return { error: 'topic is required.' };
    if (!plan.rejected.some((r) => r.topic.toLowerCase() === topic.toLowerCase())) {
      plan.rejected.push({ topic, reason: str(input.reason, 300) });
      if (plan.rejected.length > MAX_REJECTED) plan.rejected.shift();
    }
    return { result: { rejected: plan.rejected.length } };
  }

  return { error: `unknown plan tool: ${name}` };
}

/* --- the plan, as the model sees it at the top of each turn --------------- */

export function planBriefing(plan) {
  if (plan.target_count === null && !plan.slots.length && !plan.rejected.length) {
    return 'PLANNING STATE: nothing agreed yet. No number of videos, no topics. Establishing the number is the first thing to settle.';
  }

  const lines = ['PLANNING STATE (carried from earlier in this session):'];
  lines.push(plan.goal ? `Goal: ${plan.goal}` : 'Goal: not stated.');
  lines.push(
    plan.target_count === null
      ? 'Number of videos: not yet agreed.'
      : `Number of videos: ${plan.target_count}.`
  );

  if (plan.slots.length) {
    lines.push('Slots:');
    plan.slots.forEach((s, i) => {
      lines.push(s.status === 'locked'
        ? `  ${i + 1}. LOCKED — ${s.topic}${s.angle ? ` (${s.angle})` : ''}`
        : `  ${i + 1}. empty`);
    });
  }

  if (plan.rejected.length) {
    lines.push('Already rejected — do not propose these again:');
    for (const r of plan.rejected) lines.push(`  - ${r.topic}${r.reason ? ` (${r.reason})` : ''}`);
  }

  if (planIsComplete(plan)) {
    lines.push('Every slot is locked. The plan is complete; say so and stop proposing.');
  }

  return lines.join('\n');
}

/* --- remembering an uploaded file ---------------------------------------- */

/* The file is already in the request as an attachment, being read for this
 * conversation. This puts the same text into the knowledge base so the next
 * session can retrieve it, and is called only when the person has said yes. */
export const REMEMBER_TOOL = {
  name: 'remember_file',
  description:
    'Add a text file the person attached to this message into the knowledge base permanently, so future sessions can retrieve it. Ask before calling it — "want me to keep this in the library?" — and call it only on a yes. Attachments are otherwise read once and forgotten. Only text files can be kept; images and PDFs cannot.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The filename exactly as it was attached.' },
      document_type: {
        type: 'string',
        enum: ['transcript', 'research', 'article', 'report', 'interview', 'other'],
        description: 'What kind of source this is. A podcast or interview transcript is "transcript".',
      },
      title: { type: 'string', description: 'A readable title, if the filename is not one.' },
      topics: { type: 'array', items: { type: 'string' }, description: 'Up to 6 subjects it covers.' },
    },
    required: ['name', 'document_type'],
  },
};

const TRANSCRIPT_TYPES = new Set(['transcript', 'interview', 'recording']);

/* `texts` is buildAttachments()'s text list: [{ name, text }]. Images and PDFs
 * are deliberately not in it — neither can be turned into passages here. */
export async function rememberFile(env, texts, input, sessionId) {
  const name = String(input.name || '');
  const file = (texts || []).find((a) => a.name === name);

  if (!file) {
    const available = (texts || []).map((a) => a.name);
    return {
      error: available.length
        ? `No text attachment named "${name}". Attached text files: ${available.join(', ')}.`
        : 'There are no text attachments on this message. Images and PDFs cannot be kept in the library.',
    };
  }

  const topics = Array.isArray(input.topics)
    ? input.topics.map((t) => str(t, 80)).filter(Boolean).slice(0, 6) : [];
  const documentType = input.document_type || 'other';

  let created;
  try {
    created = await rpc(env, 'kb_upload_document', {
      payload: {
        brand_slug: 'trilith',
        document_type: documentType,
        title: str(input.title, 300) || name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '),
        source_key: name,
        raw_content: file.text,
        metadata: {
          original_filename: name,
          /* Tagged so anything added this way is findable and reversible in one
           * query. A document nobody remembers adding is the failure mode of
           * embedding from a chat turn. */
          provenance: 'chat',
          session_id: sessionId || null,
          ...(topics.length ? { topics } : {}),
        },
      },
    });
  } catch (err) {
    return { error: `Could not store it: ${String(err.message)}` };
  }

  if (!created.changed) {
    return { result: { status: 'already_known', message: `${name} is already in the library, unchanged.` } };
  }

  let chunks;
  if (TRANSCRIPT_TYPES.has(documentType)) {
    let cues = parseCues(file.text);
    if (cues.length < 2) cues = parsePlainTranscript(file.text);
    chunks = cues.length
      ? chunkTranscript(cues).map((c, i) => ({
        chunk_index: i,
        heading: null,
        content: c.text,
        token_count: estimateTokens(c.text),
        metadata: {
          ...(c.speaker ? { speaker: c.speaker } : {}),
          ...(c.start !== null ? { start_time: c.start } : {}),
          ...(c.end !== null ? { end_time: c.end } : {}),
          ...(topics.length ? { topics } : {}),
        },
      }))
      : null;
  }
  if (!chunks) {
    chunks = chunkProse(file.text).map((p, i) => ({
      chunk_index: i,
      heading: p.heading || null,
      content: p.text,
      token_count: estimateTokens(p.text),
      metadata: { ...(topics.length ? { topics } : {}) },
    }));
  }

  if (!chunks.length) return { error: `${name} produced no usable chunks.` };
  if (chunks.length > 400) return { error: `${name} is too large — ${chunks.length} chunks, limit 400.` };

  if (env.VOYAGE_API_KEY) {
    try {
      const cfg = await rpc(env, 'kb_embedding_config', {});
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.VOYAGE_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          input: chunks.map((c) => [c.heading, c.content].filter(Boolean).join('\n')),
          model: cfg.model, input_type: 'document', output_dimension: cfg.dimensions, truncation: true,
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (res.ok) {
        const json = await res.json();
        const vectors = json.data.sort((a, b) => a.index - b.index).map((d) => `[${d.embedding.join(',')}]`);
        if (vectors.length === chunks.length) chunks.forEach((c, i) => { c.embedding = vectors[i]; });
      }
    } catch { /* stored unembedded; the pipeline backfills it */ }
  }

  try {
    const n = await rpc(env, 'kb_upload_chunks', { p_document_id: created.id, payload: chunks });
    return {
      result: {
        status: 'stored',
        document_id: created.id,
        chunks: n,
        embedded: Boolean(env.VOYAGE_API_KEY),
        message: `${name} is in the library — ${n} passages, searchable from now on.`,
      },
    };
  } catch (err) {
    return { error: `Stored the document but could not save its chunks: ${String(err.message)}` };
  }
}
