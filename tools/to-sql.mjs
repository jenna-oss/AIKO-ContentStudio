/* ---------------------------------------------------------------------------
 * Turns data/ads.json into a load-ready payload for adspy.ads.
 *
 *   data/ads-load.json  one row per ad, already shaped for the table
 *   data/sql/*.sql      the same rows as batched upserts (gitignored)
 *
 * Emits UPSERTs rather than inserts so it is safe to re-run: re-loading the
 * same corpus refreshes copy and last_seen without duplicating rows or
 * resetting first_seen, which is the one field we cannot recompute.
 * ------------------------------------------------------------------------ */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BATCH = 120;

/* Ad copy is full of styled unicode and emoji, and some of it arrives with a
 * surrogate half missing where Meta truncated the text mid-character. Postgres
 * rejects a lone surrogate outright, so drop the orphans (and NULs) while
 * letting matched pairs through untouched — the styled glyphs survive. */
function clean(s) {
  const src = String(s ?? '');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 0) continue;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = src.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += src[i] + src[i + 1];
        i++;
      }
      continue; // orphaned high surrogate
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue; // orphaned low surrogate
    out += src[i];
  }
  return out;
}

/* The category comes from the sweep that found the ad (tools/pull.mjs). The
 * lending-era product_lines and audience columns stay on the table, empty. */
const CATEGORIES = new Set(['ai-video', 'ai-writing', 'scheduling', 'repurposing', 'all-in-one', 'agency']);
const category = (a) => (CATEGORIES.has(a.category) ? a.category : null);

/* Meta writes dates as prose ('Started running on Aug 1, 2025'). Anything Date
 * cannot parse becomes null rather than a bogus day. */
const isoDay = (s) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const q = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const arr = (a) => (a.length ? `ARRAY[${a.map(q).join(',')}]::text[]` : `'{}'::text[]`);
const dt = (s) => (isoDay(s) ? `'${isoDay(s)}'::date` : 'null');

const corpus = JSON.parse(await readFile(join(ROOT, 'data', 'ads.json'), 'utf8'));
const ads = Object.values(corpus.ads);

const rowsForLoad = ads.map((a) => {
  const copy = clean(a.copy);
  return {
    library_id: a.libraryId,
    advertiser_name: clean(a.advertiser),
    copy,
    started: isoDay(a.started),
    first_seen: a.firstSeen,
    last_seen: a.lastSeen || a.firstSeen,
    seen_count: a.seenCount || 1,
    source: a.source,
    product_lines: [],
    audience: 'unknown',
    category: category(a),
  };
});

/* Load-ready payload: same shape the table wants, so Postgres only has to
 * unpack JSON. Derivation stays here rather than being re-implemented in SQL. */
await writeFile(join(ROOT, 'data', 'ads-load.json'), JSON.stringify(rowsForLoad));

const rows = rowsForLoad.map((r) => `(${[
  q(r.library_id), q(r.advertiser_name), q(r.copy), dt(r.started),
  q(r.first_seen), q(r.last_seen), r.seen_count, q(r.source),
  arr(r.product_lines), q(r.audience), q(r.category),
].join(',')})`);

await mkdir(join(ROOT, 'data', 'sql'), { recursive: true });

const batches = [];
for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));

for (const [i, batch] of batches.entries()) {
  const sql = `insert into adspy.ads
  (library_id, advertiser_name, copy, started, first_seen, last_seen, seen_count, source, product_lines, audience, category)
values
${batch.join(',\n')}
on conflict (library_id) do update set
  copy          = excluded.copy,
  last_seen     = greatest(adspy.ads.last_seen, excluded.last_seen),
  seen_count    = excluded.seen_count,
  category      = coalesce(excluded.category, adspy.ads.category),
  updated_at    = now();`;
  await writeFile(join(ROOT, 'data', 'sql', `ads-${String(i + 1).padStart(2, '0')}.sql`), sql);
}

const byCategory = rowsForLoad.reduce((m, r) => { const k = r.category || '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {});
const scrubbed = ads.filter((a) => clean(a.copy) !== String(a.copy ?? '')).length;

console.log(`${ads.length} ads → ${batches.length} batches in data/sql/`);
console.log('by category:', byCategory);
console.log(`copy scrubbed of stray surrogates on ${scrubbed} ads`);
