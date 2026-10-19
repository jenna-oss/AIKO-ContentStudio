/* ---------------------------------------------------------------------------
 * /scripts/* — scripts for solo talking-head videos.
 *
 * A planned slot can go two ways: Render, which has the pipeline make a video
 * and speak over it, or this, which writes what you say to camera. The words
 * are the whole product here, so they go through the same two checks the
 * pipeline's Script stage runs — the brand-voice lint and the beginner
 * listener — and what those say is kept on the script for the page to show.
 *
 * Writing to camera is not narration with a face on it. Narration is read over
 * pictures that carry half the meaning; here there are no pictures, so the
 * lines carry all of it, they are shorter, and they sound like someone talking
 * rather than someone reading. The prompt below is the only place that
 * difference lives.
 *
 * Only a signed-in person on the app's list reaches any of this: index.js
 * gates every route.
 * ------------------------------------------------------------------------ */

import Anthropic from '@anthropic-ai/sdk';
import { rpc } from './db.js';
import { checkScript, lintLine, MAX_LINE_CHARS } from './script-check.js';

const MODEL = 'claude-sonnet-5';

/* Forty-five to sixty seconds at the pace someone actually talks. */
const TARGET_WORDS = [130, 170];
const MAX_SCRIPT_LINES = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (obj, status, headers) => new Response(JSON.stringify(obj), {
  status, headers: { ...headers, 'content-type': 'application/json' },
});

const wordCount = (lines) => lines.join(' ').split(/\s+/).filter(Boolean).length;
const str = (v, max) => String(v ?? '').trim().slice(0, max);

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

const SCRIPT_TOOL = {
  name: 'script',
  description: 'The finished script, one line per beat, in the order they are said.',
  input_schema: {
    type: 'object',
    required: ['lines'],
    properties: {
      lines: {
        type: 'array',
        description: 'Each line is one breath: what is said, as it is said. No stage directions, no speaker labels, no beat numbers.',
        items: { type: 'string' },
      },
    },
  },
};

function writePrompt(brief) {
  const bits = [
    brief.topic && `Topic: ${brief.topic}`,
    brief.angle && `What it argues: ${brief.angle}`,
    brief.product && `Loan type: ${brief.product}`,
    brief.audience && `Who it is for: ${brief.audience}`,
    brief.evidence && `What we know: ${brief.evidence}`,
  ].filter(Boolean).join('\n');

  return `Write the script for one short video for The Buy Box (@thebuyboxre), a channel about investing in
real estate. One person, talking straight to camera, no narration and no b-roll: the words are all there is.

${bits}

${(brief.opening_line || brief.hook)
    ? `The first line is already decided and you must use it exactly as it is, as line 1:

"${brief.opening_line || brief.hook}"`
    : 'Write the first line yourself. It is the one people decide to stay on, so make it a short, concrete opener that names the money.'}

HOW THIS CHANNEL TALKS

The channel is about what owning property does to someone's life — the income that arrives whether or not
they worked that month, the job they could leave, the house their family lives in. Every video leads with
that and explains the mechanics only as far as needed to make the life believable. It is never a lesson.

- Name the money in the first line, every time. A figure, a rent, a monthly number: something countable.
- Lead with the life the money buys, then how it was done. Never the other way round.
- Every idea has to support the same thing: that buying property is how the money grows.
- Say it the way you would to a friend who has never bought a property. No acronym, no term of art, and no
  figure goes by without plain words next to it, in the same breath.
- Short lines. Eight to fourteen words is the shape. Never more than eighteen — at twenty-two a line is read
  at twice the pace of a short one, and the whole thing sounds uneven.
- Confident, not excited. No exclamation marks, no hype words, nothing certain about the future, no
  guarantees. Never say Trilith; the channel is The Buy Box.
- ${TARGET_WORDS[0]} to ${TARGET_WORDS[1]} words in total, across at most ${MAX_SCRIPT_LINES} lines. That is
  about a minute of talking.
- The last line asks the viewer to follow. Say follow, in those words.

TO CAMERA, NOT OVER PICTURES

There is nothing on screen but a person. So:
- Every line has to stand up spoken aloud. Read each one in your head; if it only works written down, rewrite it.
- No line may describe something the viewer would have to see. Nothing is being shown.
- Contractions, plain verbs, and the odd sentence fragment. Written-down grammar sounds stiff out loud.
- One thought per line. Someone reading this to camera takes a breath between them.

Return the script with the script tool, one line per beat.`;
}

/* Write it, check it, keep it. The checks are advice recorded beside the
 * script, not a gate: a flagged line is a thing to look at before filming. */
async function write(env, brief, email) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 60000, maxRetries: 1 });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    tools: [SCRIPT_TOOL],
    tool_choice: { type: 'tool', name: 'script' },
    messages: [{ role: 'user', content: writePrompt(brief) }],
  });

  const out = (res.content || []).find((c) => c.type === 'tool_use')?.input;
  let lines = (out?.lines || [])
    .map((l) => str(l, MAX_LINE_CHARS))
    .filter(Boolean)
    .slice(0, MAX_SCRIPT_LINES);
  if (lines.length < 3) throw new Error('the script came back too short to film');

  /* The opening line was agreed when the plan was locked. It is not the
   * writer's to improve on. */
  const opening = str(brief.opening_line || brief.hook, MAX_LINE_CHARS);
  if (opening) lines[0] = opening;

  const { flags, learned } = await checkScript(env, lines, lines.map((_, i) => i + 1));
  const words = wordCount(lines);

  const id = await rpc(env, 'kb_script_save', {
    p_session: brief.session_id,
    p_slot: brief.slot,
    p_topic: brief.topic,
    p_angle: brief.angle,
    p_hook: opening || lines[0],
    p_lines: lines,
    p_words: words,
    p_flags: flags,
    p_email: email || null,
  });

  return { id, lines, words, flags, learned };
}

export async function handleScripts(path, request, env, headers, ctx, user) {
  if (path === '/scripts/list') {
    try {
      const rows = await rpc(env, 'kb_scripts', { p_limit: 100 });
      return json({ scripts: rows || [] }, 200, headers);
    } catch {
      return json({ error: 'could not load the scripts' }, 502, headers);
    }
  }

  const body = await readBody(request);
  if (!body) return json({ error: 'body must be JSON' }, 400, headers);

  if (path === '/scripts/write') {
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'Writing scripts needs the Worker’s Anthropic key.' }, 503, headers);
    }
    const slot = Number(body.slot);
    const brief = {
      session_id: str(body.session_id, 64),
      slot: Number.isInteger(slot) && slot >= 1 && slot <= 50 ? slot : null,
      topic: str(body.topic, 400),
      angle: str(body.angle, 600),
      hook: str(body.hook, 400),
      opening_line: str(body.opening_line, 400),
      product: str(body.product, 80),
      audience: str(body.audience, 120),
      /* A script started from Film myself has no plan behind it, only what
       * was typed and attached, so it is allowed more to go on. */
      evidence: str(body.evidence, body.session_id ? 1200 : 4000),
    };
    /* From a planned idea it belongs to that slot, and its opening line was
     * agreed with the plan. From Film myself it is its own one-video plan,
     * and the writer writes the first line too. */
    if (!brief.session_id || !brief.slot) {
      if (body.session_id) return json({ error: 'a script from a plan needs its slot' }, 400, headers);
      brief.session_id = 'film-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      brief.slot = 1;
    }
    if (!brief.topic) return json({ error: 'Say what the video is about first.' }, 400, headers);
    if (body.session_id && !brief.opening_line && !brief.hook) return json({ error: 'that slot has no opening line' }, 400, headers);

    try {
      return json(await write(env, brief, user?.email), 200, headers);
    } catch (err) {
      console.error('writing a script failed:', err?.message);
      return json({ error: 'Couldn’t write that script. Try again.' }, 502, headers);
    }
  }

  const id = str(body.id, 64);
  if (!UUID.test(id)) return json({ error: 'id must be a script id' }, 400, headers);

  if (path === '/scripts/read') {
    try {
      const script = await rpc(env, 'kb_script_read', { p_id: id });
      if (!script) return json({ error: 'no script with that id' }, 404, headers);
      return json({ script }, 200, headers);
    } catch {
      return json({ error: 'could not load that script' }, 502, headers);
    }
  }

  /* Lines rewritten on the Scripts page. Checked again on the way in, so what
   * is stored and what was flagged always describe each other. */
  if (path === '/scripts/lines') {
    const lines = (Array.isArray(body.lines) ? body.lines : [])
      .map((l) => str(l, MAX_LINE_CHARS))
      .filter(Boolean)
      .slice(0, MAX_SCRIPT_LINES);
    if (lines.length < 3) return json({ error: 'a script needs more than a couple of lines' }, 400, headers);

    /* The lint is local and instant; the listener costs a call, so it only
     * runs when there is a key for it. */
    const flags = env.ANTHROPIC_API_KEY
      ? (await checkScript(env, lines, lines.map((_, i) => i + 1))).flags
      : lines.map((line, i) => ({ line: i + 1, issues: lintLine(line) })).filter((f) => f.issues.length);

    try {
      const ok = await rpc(env, 'kb_script_lines', {
        p_id: id, p_lines: lines, p_words: wordCount(lines), p_flags: flags,
      });
      if (!ok) return json({ error: 'no script with that id' }, 404, headers);
      return json({ lines, words: wordCount(lines), flags }, 200, headers);
    } catch {
      return json({ error: 'could not save those lines' }, 502, headers);
    }
  }

  if (path === '/scripts/status') {
    const status = str(body.status, 16);
    if (status !== 'written' && status !== 'filmed') {
      return json({ error: 'a script is written or filmed' }, 400, headers);
    }
    try {
      const ok = await rpc(env, 'kb_script_status', { p_id: id, p_status: status });
      if (!ok) return json({ error: 'no script with that id' }, 404, headers);
      return json({ status }, 200, headers);
    } catch {
      return json({ error: 'could not save that' }, 502, headers);
    }
  }

  if (path === '/scripts/delete') {
    try {
      const ok = await rpc(env, 'kb_script_delete', { p_id: id });
      if (!ok) return json({ error: 'no script with that id' }, 404, headers);
      return json({ deleted: true }, 200, headers);
    } catch {
      return json({ error: 'could not delete that script' }, 502, headers);
    }
  }

  return json({ error: 'unknown scripts route' }, 404, headers);
}
