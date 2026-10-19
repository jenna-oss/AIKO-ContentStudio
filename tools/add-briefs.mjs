/* ---------------------------------------------------------------------------
 * Merge a locked batch from the Ask & brainstorm page into data/video-briefs.json.
 *
 *   node tools/add-briefs.mjs ~/Downloads/video-briefs-2026-08-16.json
 *
 * The page cannot write to git, so locking downloads a file and this puts it in
 * the repo. Append-only: a batch is a record of what was decided on a day, and
 * rewriting history would leave downstream automation unable to tell what it
 * has already acted on.
 * ------------------------------------------------------------------------ */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'data', 'video-briefs.json');

const input = process.argv[2];
if (!input) {
  console.error('Usage: node tools/add-briefs.mjs <downloaded batch.json>');
  process.exit(1);
}

let batch;
try {
  batch = JSON.parse(await readFile(resolve(input), 'utf8'));
} catch (err) {
  console.error(`Could not read ${input}: ${err.message}`);
  process.exit(1);
}

const briefs = Array.isArray(batch.briefs) ? batch.briefs : [];
if (!briefs.length) {
  console.error('That file contains no briefs.');
  process.exit(1);
}

/* Every brief needs the three fields downstream actually consumes. A batch
 * that half-validates is worse than one that fails here. */
const REQUIRED = ['topic', 'hook_form', 'opening_line'];
const bad = briefs
  .map((b, i) => ({ i, missing: REQUIRED.filter((k) => !String(b[k] || '').trim()) }))
  .filter((x) => x.missing.length);
if (bad.length) {
  for (const b of bad) console.error(`Brief ${b.i + 1} is missing: ${b.missing.join(', ')}`);
  process.exit(1);
}

let store = { batches: [] };
try {
  store = JSON.parse(await readFile(STORE, 'utf8'));
  if (!Array.isArray(store.batches)) store.batches = [];
} catch { /* first batch */ }

/* Locking twice from the same screen would otherwise land the same set twice.
 * Identify a batch by its contents, not its timestamp. */
const id = createHash('sha1')
  .update(JSON.stringify(briefs.map((b) => [b.topic, b.opening_line])))
  .digest('hex')
  .slice(0, 12);

if (store.batches.some((b) => b.id === id)) {
  console.log(`Batch ${id} is already in the store — nothing to do.`);
  process.exit(0);
}

store.batches.push({
  id,
  lockedAt: batch.lockedAt || new Date().toISOString(),
  requested: batch.requested ?? briefs.length,
  /* Downstream sets this to 'done' as it consumes them; nothing here writes it. */
  status: 'pending',
  briefs,
});

store.updatedAt = new Date().toISOString();

await mkdir(join(ROOT, 'data'), { recursive: true });
await writeFile(STORE, `${JSON.stringify(store, null, 2)}\n`);

const total = store.batches.reduce((n, b) => n + b.briefs.length, 0);
console.log(`Added batch ${id} with ${briefs.length} briefs.`);
console.log(`data/video-briefs.json now holds ${store.batches.length} batches, ${total} briefs.`);
console.log('Commit it to publish:  git add data/video-briefs.json && git commit');
