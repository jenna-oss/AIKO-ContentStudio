/* ---------------------------------------------------------------------------
 * The arithmetic of an edited clip, kept apart from footage-cut.mjs so it can
 * be tested without ffmpeg or a database.
 *
 * Everything an edit says is in the take's own clock: where the clip starts
 * and ends, the sections cut out of it, and the words fixed. That is what lets
 * a fix made today survive a trim made tomorrow.
 * ------------------------------------------------------------------------ */

/* The parts of [start, end] left once the cut-out sections are removed. */
export function keptSegments(start, end, cuts) {
  const out = [];
  let from = start;
  for (const c of [...cuts].sort((a, b) => a.from - b.from)) {
    if (c.from > from) out.push([from, Math.min(c.from, end)]);
    from = Math.max(from, c.to);
  }
  if (end > from) out.push([from, end]);
  return out.filter(([a, b]) => b - a > 0.05);
}

/* The take's words inside the kept segments, with fixes applied, moved onto
 * the clip's clock: each segment starts where the one before it ended. A fix
 * names a word by when it starts in the take. */
export function wordsFor(takeWords, segments, fixes) {
  const fixAt = (w) => fixes.find((f) => Math.abs(Number(f.at) - Number(w.s)) < 0.06);
  const out = [];
  let offset = 0;
  for (const [a, b] of segments) {
    for (const w of takeWords) {
      const s = Number(w.s), e = Number(w.e);
      if (s < a - 0.02 || s >= b) continue;
      const f = fixAt(w);
      out.push({
        t: f ? f.text : w.t,
        s: Math.round((Math.max(s, a) - a + offset) * 100) / 100,
        e: Math.round((Math.min(e, b) - a + offset) * 100) / 100,
      });
    }
    offset += b - a;
  }
  return out;
}

/* The sentence a clip opens on, which is what its hook card shows. */
export function openingSentence(words) {
  const text = words.map((w) => w.t).join(' ').trim();
  const m = text.match(/^.*?[.?!](?=\s|$)/);
  return (m ? m[0] : text).slice(0, 300);
}
