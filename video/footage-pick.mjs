/* ---------------------------------------------------------------------------
 * Which parts of a take are worth cutting out.
 *
 *   node video/footage-pick.mjs <footage-id> [slides.json]
 *
 * A short lives or dies on its first sentence, so this only keeps passages
 * that OPEN on something worth opening on — judged against the brand guide's
 * own standard for a hook: sharp, declarative, a little confrontational, with
 * a number in it where there is one. "This deal made four thousand dollars. It
 * took eleven months." Not "You won't BELIEVE what happened."
 *
 * It is allowed to come back with nothing. Most takes have two or three
 * moments like that in them and a pile of perfectly good talking that does not
 * open anything, and forcing five clips out of a take that holds two is how
 * you end up posting the weak three.
 *
 * The model picks whole sentences by number rather than timestamps, so a cut
 * always lands on a sentence boundary that really exists in the take.
 *
 * It also only sees the stretches where he is actually on camera. A long-form
 * video cuts to full-frame title cards, and a 16:9 card centre-cropped to 9:16
 * is an unreadable fragment of a word — on the first real take, two of three
 * clips opened on one. A clip must live entirely inside one on-camera stretch,
 * which is enforced here rather than asked for.
 * ------------------------------------------------------------------------ */

import { readFileSync } from 'node:fs';

const MODEL = 'claude-sonnet-5';
const API = 'https://api.anthropic.com/v1/messages';

/* A short that works: long enough to say something, short enough to watch. */
const MIN_S = 18;
const MAX_S = 70;
const MOST_CLIPS = 8;
/* A breath before the first word, and a beat after the last. */
const LEAD = 0.25;
const TAIL = 0.35;
/* Never let one clip's tail run into the next clip's lead. */
const APART = 0.1;
/* Daylight to leave between a clip's edge and the neighbouring word, so a
 * lead or a tail can never clip the sound of one. */
const GAP = 0.06;
/* Less of a gap than this after a sentence is not a pause, it is a breath —
 * ending there sounds like an interruption rather than a finish. */
const PAUSE = 0.3;

const [, , footageId, slidesFile] = process.argv;
if (!footageId) {
  console.error('usage: footage-pick.mjs <footage-id> [slides.json]');
  process.exit(2);
}

const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const anthropic = process.env.ANTHROPIC_API_KEY || '';
if (!base || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
if (!anthropic) throw new Error('ANTHROPIC_API_KEY is not set');

async function rpc(fn, args) {
  const res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${fn} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* Words into sentences, so a cut lands where someone stopped talking rather
 * than mid-clause. A long gap counts as a full stop even without one. */
function sentences(words) {
  const out = [];
  let cur = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    cur.push(w);
    const next = words[i + 1];
    const ended = /[.?!]$/.test(w.t);
    const gap = next ? next.s - w.e : Infinity;
    if (ended || gap > 0.9 || cur.length > 60) {
      out.push({ text: cur.map((x) => x.t).join(' '), s: cur[0].s, e: w.e });
      cur = [];
    }
  }
  if (cur.length) out.push({ text: cur.map((x) => x.t).join(' '), s: cur[0].s, e: cur[cur.length - 1].e });
  return out.filter((s) => s.text.trim());
}

/* The gaps between the slides: where he is on camera. */
function onCamera(slides, duration) {
  const out = [];
  let at = 0;
  for (const s of [...slides].sort((a, b) => a.from - b.from)) {
    if (s.from > at) out.push({ from: at, to: Math.min(s.from, duration) });
    at = Math.max(at, s.to);
  }
  if (at < duration) out.push({ from: at, to: duration });
  return out.filter((r) => r.to - r.from >= MIN_S);
}

const PICK_TOOL = {
  name: 'clips',
  description: 'The passages worth cutting out of this take, each one opening on a sentence that works as a hook.',
  input_schema: {
    type: 'object',
    required: ['clips'],
    properties: {
      clips: {
        type: 'array',
        items: {
          type: 'object',
          required: ['from', 'to', 'why'],
          properties: {
            from: { type: 'number', description: 'the number of the sentence the clip opens on — this is the hook' },
            to: { type: 'number', description: 'the number of the sentence it ends on, inclusive' },
            why: { type: 'string', description: 'in one line, what makes the opening sentence worth opening on' },
          },
        },
      },
    },
  },
};

function prompt(lines, parts) {
  return `Below is everything said in one long take to camera, one sentence per line, numbered, with how
long each lasts. It is a real estate investor talking about lending and deals, for The Buy Box
(@thebuyboxre), a channel for people who want to own property.

Your job is to find the passages worth cutting out as short videos. A short is watched or skipped on its
first sentence, so a passage only counts if the sentence it OPENS on works as a hook on its own.

What that channel's hook sounds like — sharp, declarative, a little confrontational, and specific:
  Yes: "This deal made four thousand dollars. It took eleven months."
  Yes: "185 purchase, 60 rehab, comps at 340."
  No:  "You won't believe what happened with this flip."
  No:  "So anyway, as I was saying about points..."
  No:  "Obviously you'll want to weigh points against rate."

A good opening sentence names something countable, or states a position plainly enough that someone would
stay to hear why. A bad one depends on what came before it, is hype, talks down, or is certain about the
future.

It must also SAY something rather than promise something. A sentence that only announces that a point is
coming is not a hook, however confident it sounds:
  No:  "The mistake that costs investors is this."
  No:  "Here's the thing nobody tells you."
  Yes: "Most investors price a bridge loan off the Fed, and the Fed has nothing to do with it."
If you cannot tell what the claim is from the opening sentence alone, it is not an opening sentence.

Each clip also has to stand on its own: a whole thought, beginning to end, not a fragment of an argument
that only makes sense with the rest of the take around it. It should last between ${MIN_S} and ${MAX_S}
seconds.

${parts}

Take as many as the take really holds and no more. Most takes hold two or three. If this one holds
nothing — nobody opens anything cleanly — come back with an empty list and say so. An empty list is a
perfectly good answer and much better than a weak clip.

Clips must not overlap.

${lines}

Report with the clips tool: the sentence it opens on, the sentence it ends on, and one line on what makes
that opening worth opening on.`;
}

try {
  const take = await rpc('kb_footage_read', { p_id: footageId });
  if (!take) throw new Error('no take with that id');
  const words = Array.isArray(take.words) ? take.words : [];
  if (!words.length) throw new Error('that take has no word timings, so there is nothing to cut on');

  /* The neighbours of a cut: where the previous word finished, and where the
   * next one starts. Words come back in order, so a walk is enough. */
  const lastEndBefore = (t) => {
    let out = -Infinity;
    for (const w of words) {
      if (w.e > t + 0.001) break;
      out = w.e;
    }
    return out;
  };
  const firstStartAfter = (t) => {
    for (const w of words) if (w.s >= t - 0.001) return w.s;
    return Infinity;
  };

  const duration = Number(take.seconds) || words[words.length - 1].e;
  let slides = [];
  if (slidesFile) {
    try { slides = JSON.parse(readFileSync(slidesFile, 'utf8')); }
    catch { slides = []; }
  }
  const stretches = onCamera(slides, duration);
  console.log(`${slides.length} stretch(es) are not him; ${stretches.length} usable run(s) of ${MIN_S}s or more`);

  /* Only sentences inside a usable run, grouped by which run they are in. */
  const said = sentences(words);
  const kept = [];
  said.forEach((s) => {
    const mid = (s.s + s.e) / 2;
    const run = stretches.findIndex((r) => mid >= r.from && mid <= r.to);
    if (run >= 0 && s.s >= stretches[run].from - 0.5 && s.e <= stretches[run].to + 0.5) {
      kept.push({ ...s, run });
    }
  });
  if (!kept.length) throw new Error('none of this take is him talking for long enough to cut from');

  let lines = '';
  let lastRun = -1;
  kept.forEach((s, i) => {
    if (s.run !== lastRun) {
      lines += `${lines ? '\n' : ''}--- he is on camera from ${stretches[s.run].from}s to ${stretches[s.run].to}s ---\n`;
      lastRun = s.run;
    }
    lines += `${i + 1}. [${s.s.toFixed(1)}s–${s.e.toFixed(1)}s] ${s.text}\n`;
  });

  const parts = stretches.length > 1
    ? `The take cuts away to full-frame title cards, which cannot be used. Only the stretches below are him on\ncamera, and they are marked. A clip must sit entirely inside ONE of them — never spanning a gap between\nthem, because the gap is a title card.`
    : '';

  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'x-api-key': anthropic,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      tools: [PICK_TOOL],
      tool_choice: { type: 'tool', name: 'clips' },
      messages: [{ role: 'user', content: prompt(lines, parts) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic answered ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const body = await res.json();
  const picked = (body.content || []).find((c) => c.type === 'tool_use')?.input?.clips || [];
  console.log(`the model picked ${picked.length}`);

  /* Everything it says is checked against the take rather than trusted: a
   * sentence number that does not exist, a clip that runs backwards, one that
   * crosses a title card, one outside the length, or one overlapping a clip
   * already taken. */
  const clips = [];
  let last = -1;
  let endOfLast = -Infinity;
  for (const c of picked) {
    const from = Number(c.from);
    const to = Number(c.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
    if (from < 1 || to > kept.length || to < from) continue;
    if (from <= last) continue;

    const opens = kept[from - 1];
    const closes = kept[to - 1];
    if (opens.run !== closes.run) {
      console.log(`  skipping ${from}–${to}: it would cut across a title card`);
      continue;
    }

    const run = stretches[opens.run];

    /* The lead and the tail assume silence either side, and he does not leave
     * any: after one sentence ended, the next began 0.12s later, so a 0.35s
     * tail ran into it and the clip stopped halfway through a word. Both are
     * clamped to the actual gap. */
    const before = lastEndBefore(opens.s);
    const after = firstStartAfter(closes.e);
    const start = Math.max(run.from, endOfLast + APART, Math.min(opens.s, Math.max(opens.s - LEAD, before + GAP)));
    let end = Math.min(run.to, Math.max(closes.e, Math.min(closes.e + TAIL, after - GAP)));

    /* Ending on a full stop he talks straight through still sounds like an
     * interruption. If there is no real pause there, carry on to the next
     * place he actually stops, while it still fits. */
    let ends = to;
    if (after - closes.e < PAUSE) {
      for (let j = to; j < kept.length && kept[j].run === opens.run; j += 1) {
        const settles = firstStartAfter(kept[j].e);
        const longer = Math.min(run.to, Math.max(kept[j].e, Math.min(kept[j].e + TAIL, settles - GAP)));
        if (longer - start > MAX_S) break;
        end = longer;
        ends = j + 1;
        if (settles - kept[j].e >= PAUSE) break;
      }
    }

    const seconds = end - start;
    if (seconds < MIN_S || seconds > MAX_S) {
      console.log(`  skipping ${from}–${to}: ${seconds.toFixed(1)}s is outside ${MIN_S}–${MAX_S}`);
      continue;
    }

    clips.push({
      start,
      end,
      hook: opens.text,
      why: String(c.why || '').slice(0, 600),
      /* The words inside this clip, on the clip's own clock. */
      words: words
        .filter((w) => w.s >= start && w.e <= end)
        .map((w) => ({ t: w.t, s: Number((w.s - start).toFixed(3)), e: Number((w.e - start).toFixed(3)) })),
    });
    last = ends;
    endOfLast = end;
    if (clips.length >= MOST_CLIPS) break;
  }

  if (!clips.length) {
    console.log('nothing in this take opens cleanly enough to cut');
    await rpc('kb_footage_state', {
      p_id: footageId, p_status: 'ready',
      p_error: 'Nothing in this take opened cleanly enough to make a short. The transcript is kept.',
    });
    console.log('CLIPS=0');
    process.exit(0);
  }

  for (let i = 0; i < clips.length; i += 1) {
    const c = clips[i];
    const id = await rpc('kb_clip_create', {
      p_footage: footageId,
      p_idx: i + 1,
      p_start: Number(c.start.toFixed(2)),
      p_end: Number(c.end.toFixed(2)),
      p_hook: c.hook,
      p_why: c.why,
      p_words: c.words,
    });
    console.log(`  ${i + 1}. ${c.start.toFixed(1)}s–${c.end.toFixed(1)}s (${(c.end - c.start).toFixed(0)}s) ${id}`);
    console.log(`     "${c.hook.slice(0, 90)}"`);
  }
  console.log(`CLIPS=${clips.length}`);
} catch (err) {
  const why = String(err?.message || err).slice(0, 400);
  console.error('picking failed:', why);
  await rpc('kb_footage_state', { p_id: footageId, p_status: 'failed', p_error: why }).catch(() => {});
  process.exit(1);
}
