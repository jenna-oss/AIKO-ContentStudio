/* ---------------------------------------------------------------------------
 * Replace blank creative thumbnails with a real frame from the video.
 *
 * Spyglass hands back frame zero, and a great many of these ads open on a black
 * or single-colour title card — so the wall was rendering rows of empty grey
 * boxes next to perfectly good copy. RCN's "Skip the Bank's Red Tape" arrived
 * as 984 bytes of solid black; the same ad at 1.5 seconds is the headline.
 *
 * Only blank-looking thumbnails are replaced. A real frame compresses to a few
 * kilobytes at minimum, a flat colour to about one, so byte size separates them
 * cleanly enough — and a false positive costs nothing, because the replacement
 * is a mid-video frame either way.
 *
 * Needs ffmpeg on PATH. Without it the script says so and exits clean, leaving
 * every card exactly as it found it: a wall with dull thumbnails beats a failed
 * run that discards a harvest.
 * ------------------------------------------------------------------------ */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CARDS = join(ROOT, 'data', 'creatives.json');
const OUTDIR = join(ROOT, 'assets', 'thumbs');

/* A flat-colour frame lands around 1KB; anything with real content in it runs
 * to several. 4KB sits in the empty space between the two populations. */
const BLANK_MAX_BYTES = 4000;

/* Far enough in to clear a fade-up or a title card, early enough to still be
 * the hook the viewer actually saw. */
const SEEK_SECONDS = 1.5;
const WIDTH = 480;

async function haveFfmpeg() {
  try {
    await run('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/* Byte size of the thumbnail as served. A fetch that fails counts as blank —
 * an image we cannot read is not one we should be putting on the page. */
async function thumbBytes(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return 0;
    return (await res.arrayBuffer()).byteLength;
  } catch {
    return 0;
  }
}

const corpus = JSON.parse(await readFile(CARDS, 'utf8'));
const cards = corpus.cards ?? [];

if (!(await haveFfmpeg())) {
  console.log('ffmpeg not on PATH — leaving thumbnails as they are.');
  process.exit(0);
}

await mkdir(OUTDIR, { recursive: true });

let replaced = 0;
let kept = 0;
const failures = [];

/* One extraction per distinct video: the same creative runs under several ad
 * ids, and the wall shows the duplicates. */
const done = new Map();

for (const card of cards) {
  if (!card.mediaUrl || !/\.mp4($|\?)/i.test(card.mediaUrl)) continue;
  if (!card.thumbnailUrl) continue;

  const id = card.mediaUrl.split('/').pop().replace(/\.mp4.*$/i, '');

  if (done.has(id)) {
    if (done.get(id)) card.thumbnailUrl = done.get(id);
    continue;
  }

  /* Already-local thumbnails are ours from a previous run; nothing to judge. */
  if (card.thumbnailUrl.startsWith('./assets/')) { done.set(id, card.thumbnailUrl); continue; }

  const bytes = await thumbBytes(card.thumbnailUrl);
  if (bytes > BLANK_MAX_BYTES) {
    kept += 1;
    done.set(id, null);
    continue;
  }

  const rel = `./assets/thumbs/${id}.webp`;
  try {
    await run('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-ss', String(SEEK_SECONDS),
      '-i', card.mediaUrl,
      '-frames:v', '1',
      '-vf', `scale=${WIDTH}:-2`,
      '-q:v', '70',
      join(OUTDIR, `${id}.webp`),
    ], { timeout: 60000 });
    card.thumbnailUrl = rel;
    done.set(id, rel);
    replaced += 1;
    console.log(`  ${card.brand.padEnd(20)} ${bytes}b blank → frame at ${SEEK_SECONDS}s`);
  } catch (err) {
    failures.push({ id, why: String(err.message).slice(0, 120) });
    done.set(id, null);
    console.log(`  ${card.brand.padEnd(20)} extraction failed, keeping the original`);
  }
}

if (replaced) {
  await writeFile(CARDS, JSON.stringify(corpus, null, 2));
}

console.log(`\n${replaced} thumbnail${replaced === 1 ? '' : 's'} replaced, ${kept} kept as served.`);
if (failures.length) console.log(`${failures.length} failed:`, failures);
