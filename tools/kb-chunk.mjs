/* ---------------------------------------------------------------------------
 * Chunking, with no dependencies on anything.
 *
 * Split out of kb-lib.mjs so the Cloudflare Worker can chunk an uploaded file
 * the same way the ingestion pipeline does. Nothing here touches node:crypto,
 * the filesystem or fetch, so it runs unchanged in both places — which matters
 * more than it sounds: a document uploaded through the page and the same
 * document dropped in kb/files/ must produce identical chunks, or retrieval
 * would return two subtly different versions of one source.
 *
 * kb-lib.mjs re-exports all of it, so existing callers are unaffected.
 * ------------------------------------------------------------------------ */

/* --- tokens -------------------------------------------------------------- */

/* Four characters per token. Voyage does not publish a tokenizer for local use
 * and the number is only ever used to size a chunk and to spend a context
 * budget, both of which tolerate a rough figure. It is an estimate everywhere
 * it appears, and named as one. */
export const estimateTokens = (s) => Math.ceil(String(s ?? '').length / 4);
/* --- prose chunking (research, articles, reports) ------------------------ */

/* Spec section 13: chunk on section and heading boundaries, and do not break a
 * finding or a table across chunks unnecessarily. Sizes are the spec's 300-800
 * token band expressed in characters at four-to-one. */
const MAX_CHARS = 3200;   // ~800 tokens
const MIN_CHARS = 1200;   // ~300 tokens
const OVERLAP = 200;

function overlapTail(s) {
  const tail = s.slice(-OVERLAP);
  const sentence = tail.match(/[.!?]\s+([\s\S]*)$/);
  return (sentence ? sentence[1] : tail.replace(/^\S*\s+/, '')).trim();
}

export function chunkProse(text) {
  const sections = [];
  let heading = null;
  let buf = [];

  const flush = () => {
    const body = buf.join('\n').trim();
    if (body || heading) sections.push({ heading, body });
    buf = [];
  };

  for (const line of String(text).split('\n')) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { flush(); heading = h[1].trim(); continue; }
    buf.push(line);
  }
  flush();

  const pieces = [];
  for (const s of sections) {
    const full = [s.heading, s.body].filter(Boolean).join('\n');
    if (full.length <= MAX_CHARS) {
      if (full.trim()) pieces.push({ heading: s.heading, text: full });
      continue;
    }
    /* Oversized section: split on paragraphs, never mid-paragraph, so a table
     * or a numbered finding stays whole unless it alone exceeds the cap. */
    const paras = s.body.split(/\n{2,}/);
    let cur = s.heading ? `${s.heading}\n` : '';
    for (const p of paras) {
      if (cur.trim() && cur.length + p.length + 2 > MAX_CHARS) {
        pieces.push({ heading: s.heading, text: cur.trim() });
        cur = `${overlapTail(cur)}\n\n${p}`;
      } else {
        cur = cur ? `${cur}\n\n${p}` : p;
      }
    }
    if (cur.trim()) pieces.push({ heading: s.heading, text: cur.trim() });
  }

  /* Pack neighbours until each chunk is substantial enough to answer a question
   * on its own — spec section 14 wants one coherent thought per chunk, and a
   * two-line fragment is not one.
   *
   * Two reasons to merge, not one: the previous chunk is undersized, OR this
   * piece is. The second case matters because a short section is often the most
   * quotable thing in a report — "Conclusion: rates ease into Q4" — and
   * dropping it for being brief loses a finding rather than trimming debris. */
  const TINY = 120;
  const packed = [];
  for (const p of pieces) {
    const last = packed[packed.length - 1];
    const undersized = last && (last.text.length < MIN_CHARS || p.text.length < TINY);
    if (undersized && last.text.length + p.text.length + 2 <= MAX_CHARS) {
      last.text = `${last.text}\n\n${p.text}`;
      last.heading ||= p.heading;
    } else {
      packed.push({ ...p });
    }
  }

  /* Whatever is still tiny after packing had no neighbour to join, so it is
   * either navigation debris or the entire document. Keep it only in the
   * second case — a one-line document is still a document. */
  const kept = packed.filter((p) => p.text.length >= TINY);
  return kept.length ? kept : packed.filter((p) => p.text.trim());
}

/* --- transcript parsing -------------------------------------------------- */

const tsToSeconds = (t) => {
  const m = String(t).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return Number(h || 0) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms || 0) / 1000;
};

/* WebVTT and SRT differ only in the header and the millisecond separator, so
 * one parser handles both rather than two that can disagree. */
export function parseCues(text) {
  const body = String(text).replace(/\r/g, '');
  const blocks = body.split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    if (/^WEBVTT/.test(lines[0])) continue;

    const timeIdx = lines.findIndex((l) => /-->/.test(l));
    if (timeIdx === -1) continue;

    const [rawStart, rawEnd] = lines[timeIdx].split('-->').map((s) => s.trim().split(/\s+/)[0]);
    const start = tsToSeconds(rawStart);
    const end = tsToSeconds(rawEnd);
    if (start === null) continue;

    let speaker = null;
    const said = lines
      .slice(timeIdx + 1)
      .map((l) => {
        /* Both conventions appear in the wild: <v Speaker> from WebVTT, and a
         * bare "Name:" prefix from most human transcription services. */
        const v = l.match(/^<v\s+([^>]+)>\s*(.*)$/);
        if (v) { speaker ||= v[1].trim(); return v[2]; }
        const named = l.match(/^([A-Z][\w .'-]{1,30}):\s+(.*)$/);
        if (named) { speaker ||= named[1].trim(); return named[2]; }
        return l;
      })
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (said) cues.push({ start, end, speaker, text: said });
  }
  return cues;
}

/* A transcript with no timestamps at all — a pasted interview, say. Speaker
 * turns are the only structure available, so they become the cue boundaries
 * and the timestamps stay null rather than being invented. */
export function parsePlainTranscript(text) {
  const cues = [];
  let speaker = null;
  let buf = [];

  const flush = () => {
    const said = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (said) cues.push({ start: null, end: null, speaker, text: said });
    buf = [];
  };

  for (const line of String(text).split('\n')) {
    const named = line.match(/^\s*([A-Z][\w .'-]{1,30}):\s*(.*)$/);
    if (named) { flush(); speaker = named[1].trim(); buf.push(named[2]); continue; }
    buf.push(line);
  }
  flush();
  return cues;
}

/* A single cue larger than a chunk is split at sentence ends, or at word
 * boundaries when there are none (auto-captions are often unpunctuated).
 * Without this, a transcript with no speaker labels and no timestamps arrives
 * as one cue, and the cap below — checked only between cues — never fires: an
 * uploaded YouTube transcript went in as one 2,374-token chunk. Timestamps are
 * not invented for the pieces: the first keeps the cue's start, the last its
 * end, and the ones between carry neither. */
function splitCue(cue, maxTokens) {
  if (estimateTokens(cue.text) <= maxTokens) return [cue];

  const maxChars = maxTokens * 4;
  const sentences = cue.text.match(/[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g) || [cue.text];
  const units = sentences.flatMap((s) => {
    if (s.length <= maxChars) return [s];
    const words = s.split(/(\s+)/);
    const parts = [];
    let cur = '';
    for (const w of words) {
      if (cur.length + w.length > maxChars && cur.trim()) { parts.push(cur); cur = ''; }
      cur += w;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
  });

  /* Pieces aim for the middle of the band rather than its ceiling, so the
   * grouping below still has room to stop at a natural seam. */
  const target = Math.floor(maxChars / 2);
  const pieces = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + u.length > target) { pieces.push(cur.trim()); cur = ''; }
    cur += u;
  }
  if (cur.trim()) pieces.push(cur.trim());

  return pieces.map((text, i) => ({
    speaker: cue.speaker,
    text,
    start: i === 0 ? cue.start : null,
    end: i === pieces.length - 1 ? cue.end : null,
  }));
}

/* Group cues into chunks inside the spec's 300-800 token band, preferring to
 * break where the conversation already breaks: a speaker change, or a pause
 * long enough to be a change of subject. A chunk that ends mid-thought is the
 * failure mode section 14 is about. */
export function chunkTranscript(rawCues, { minTokens = 300, maxTokens = 800, pauseSeconds = 2.5 } = {}) {
  const cues = rawCues.flatMap((c) => splitCue(c, maxTokens));
  const chunks = [];
  let cur = [];

  const size = (arr) => estimateTokens(arr.map((c) => c.text).join(' '));

  const emit = () => {
    if (!cur.length) return;
    const speakers = [...new Set(cur.map((c) => c.speaker).filter(Boolean))];
    const starts = cur.map((c) => c.start).filter((n) => n !== null);
    const ends = cur.map((c) => c.end).filter((n) => n !== null);
    const text = cur
      .map((c) => (speakers.length > 1 && c.speaker ? `${c.speaker}: ${c.text}` : c.text))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    chunks.push({
      text,
      speaker: speakers.length === 1 ? speakers[0] : null,
      speakers,
      start: starts.length ? Math.round(Math.min(...starts)) : null,
      end: ends.length ? Math.round(Math.max(...ends)) : null,
    });
    cur = [];
  };

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const prev = cues[i - 1];
    const tokens = size(cur);

    const gap = prev && prev.end !== null && cue.start !== null ? cue.start - prev.end : 0;
    const speakerChanged = prev && cue.speaker && prev.speaker && cue.speaker !== prev.speaker;
    const longPause = gap >= pauseSeconds;

    /* A handover plus a real silence is a change of subject, not a change of
     * turn. Treating it as an ordinary seam meant a short transcript came back
     * as one chunk covering two unrelated arguments — exactly the failure
     * spec section 14 describes — because the token floor outranked the
     * strongest signal in the file. So a strong seam breaks at a third of the
     * floor, and an ordinary one still waits for it. */
    const strongSeam = (speakerChanged && longPause) || gap >= pauseSeconds * 3;

    if (cur.length && tokens >= minTokens && (speakerChanged || longPause)) emit();
    else if (cur.length && tokens >= minTokens / 3 && strongSeam) emit();
    /* Checked against the size it would become, not the size it is, so adding
     * one more cue cannot carry a chunk past the cap. */
    else if (cur.length && tokens + estimateTokens(cue.text) > maxTokens) emit();

    cur.push(cue);
  }
  emit();

  /* A trailing scrap is folded back into its predecessor rather than published
   * as a chunk that says nothing on its own.
   *
   * The threshold is absolute, not a fraction of the floor. Tying it to
   * minTokens meant a closing argument of eighty tokens counted as a scrap and
   * was merged back into the chunk it had just been split from, undoing the
   * split. A scrap is a dangling sign-off or half a sentence; anything that
   * states something is a chunk, however short. */
  const SCRAP_TOKENS = 50;
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    if (estimateTokens(last.text) < SCRAP_TOKENS) {
      const prev = chunks[chunks.length - 2];
      prev.text = `${prev.text} ${last.text}`.trim();
      prev.end = last.end ?? prev.end;
      chunks.pop();
    }
  }

  return chunks;
}

