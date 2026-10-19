/* ---------------------------------------------------------------------------
 * Which seconds of a take are not him.
 *
 *   node video/footage-slides.mjs <take-file> > slides.json
 *
 * Long-form videos cut to full-frame title cards, and a 16:9 card
 * centre-cropped to 9:16 is an unreadable fragment of a word. The clips are
 * meant to be him talking, so the picker needs to know which stretches to stay
 * out of.
 *
 * Telling them apart is easy once measured: a card is flat and even, while a
 * room with a person in it never is. On the first real take the cards came back
 * at an average luma of 229 with a spread of 0 to 2, and the shots of him at 16
 * to 158 with spreads up to 86 — two populations that do not touch. Flatness is
 * the test rather than brightness, so it also catches the fades to black
 * between them, which are no better to open on.
 * ------------------------------------------------------------------------ */

import { execFileSync } from 'node:child_process';

/* Below this much variation between the dark and light ends of a frame, there
 * is nothing in it but a background and some text. */
const FLAT = 20;
/* A single flat second is a cut, not a card. */
const MIN_RUN = 2;
/* A second either side, so a clip never opens on the frame before a card. */
const PAD = 1;

const [, , takeFile] = process.argv;
if (!takeFile) {
  console.error('usage: footage-slides.mjs <take-file>');
  process.exit(2);
}

/* Through ffmpeg with an ordinary -i rather than ffprobe's movie= filter: a
 * filtergraph has its own escaping and a Windows path with a drive letter does
 * not survive it. */
const out = execFileSync('ffmpeg', [
  '-nostdin', '-hide_banner', '-v', 'error',
  '-i', takeFile,
  '-vf', 'fps=1,signalstats,metadata=print:file=-',
  '-f', 'null', '-',
], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });

/* metadata=print writes a block per frame: a line naming the frame, then a
 * line per tag. */
const flat = [];
let second = -1;
let low = null;
let high = null;

const close = () => {
  if (second >= 0 && low !== null && high !== null && high - low < FLAT) flat.push(second);
};

for (const line of out.split('\n')) {
  const text = line.trim();
  if (text.startsWith('frame:')) {
    close();
    second += 1;
    low = null;
    high = null;
    continue;
  }
  const at = text.indexOf('=');
  if (at < 0) continue;
  const tag = text.slice(0, at);
  const value = Number(text.slice(at + 1));
  if (tag === 'lavfi.signalstats.YLOW') low = value;
  if (tag === 'lavfi.signalstats.YHIGH') high = value;
}
close();

const seconds = second + 1;

/* Runs of flat seconds, padded, merged where the padding makes them touch. */
const runs = [];
for (const s of flat) {
  const last = runs[runs.length - 1];
  if (last && s <= last.to + 1) last.to = s;
  else runs.push({ from: s, to: s });
}

const slides = [];
for (const r of runs) {
  if (r.to - r.from + 1 < MIN_RUN) continue;
  const from = Math.max(0, r.from - PAD);
  const to = r.to + 1 + PAD;
  const last = slides[slides.length - 1];
  if (last && from <= last.to) last.to = Math.max(last.to, to);
  else slides.push({ from, to });
}

const covered = slides.reduce((n, s) => n + (s.to - s.from), 0);
console.error(`${slides.length} stretch(es) that are not him, ${covered}s of ${seconds}s`);
process.stdout.write(JSON.stringify(slides));
