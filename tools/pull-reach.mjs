/* ---------------------------------------------------------------------------
 * The reach comparison on creators.html: best organic post, creators against
 * the lenders they compete with for the same attention.
 *
 * The section was hand-built and frozen -- twelve rows of hardcoded names,
 * view counts and bar widths, under a heading making a live claim about who
 * this audience watches. Kiavi's 5.7K was accurate when someone typed it and
 * has no way of staying accurate. This harvests both halves instead.
 *
 * The creator half comes from data/education-creators.json, already screened
 * for relevance by pull-creators.mjs, so this must run after it.
 *
 * The lender half is the one that costs credits: nine brands, organic only.
 * Their PAID ads are already harvested by pull-creatives.mjs for the creative
 * wall; this is the opposite filter against the same nine ids, which is why
 * the list lives in lenders.mjs rather than in either script.
 *
 * Needs SPYGLASS_API_KEY. Skips itself, without failing, when it is absent --
 * the page keeps the previous comparison.
 * ------------------------------------------------------------------------ */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LENDERS } from './lenders.mjs';
import { isOrganic, views as readViews } from './creator-media.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CREATORS = join(ROOT, 'data', 'education-creators.json');
const OUT = join(ROOT, 'data', 'reach.json');
const BASE = 'https://app.spyglass.so/api/v1';
const TIMEOUT_MS = 25000;
const PAUSE_MS = 400;

const FETCH_PER_LENDER = 10;

/* Seven and five is what the hand-built section showed, and the split matters
 * more than the total: the point of the chart is the gap between the two
 * groups, so both have to be on it. Ranking the pooled list and taking the top
 * twelve would return twelve creators and no lenders, which would delete the
 * comparison while looking like it worked. */
const TOP_CREATORS = 7;
const TOP_LENDERS = 5;

const KEY = String(process.env.SPYGLASS_API_KEY ?? '').trim();
if (!KEY) {
  console.log('SPYGLASS_API_KEY not set — skipping the reach refresh.');
  process.exit(0);
}

const redact = (s) => String(s).split(KEY).join('[REDACTED]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* "98.1K" and "1.2M" have to sort as numbers or the chart orders itself
 * alphabetically and every bar is wrong. */
function toNumber(label) {
  const s = String(label ?? '').trim();
  if (!s) return 0;
  const n = /k$/i.test(s) ? parseFloat(s) * 1e3
    : /m$/i.test(s) ? parseFloat(s) * 1e6
      : parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/* Harvested views arrive both ways: older rows carry "226K" from the MCP
 * capture, the REST surface returns a raw 211040. Printed side by side on the
 * same chart one of them looks like a bug, so every label is rebuilt from the
 * number rather than trusted as-is. */
function compact(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

/* The row label. The hand-built version had editorial notes -- "a lender's
 * $25M loss" -- which nothing can regenerate, so this uses the creator's own
 * opening line instead: shorter, less quotable, and always true. */
function note(hook) {
  const s = String(hook ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > 52 ? `${s.slice(0, 51).trimEnd()}…` : s;
}

async function media(brandId) {
  const res = await fetch(`${BASE}/brands/${encodeURIComponent(brandId)}/media`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      mode: 'structured',
      userRequest: 'best performing organic posts by views',
      limit: FETCH_PER_LENDER,
      /* Required since mid-September 2026: the route 400s with "filters:
       * expected object, received undefined" without it. Organic channels
       * only, ranked by views — what userRequest already asks for in words. */
      filters: {
        channel: ['INSTAGRAM', 'TIKTOK'],
        sortBy: 'MOST_VIEWS',
        limit: FETCH_PER_LENDER,
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${redact(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : (body?.creatives ?? body?.media ?? body?.rows);
  if (!Array.isArray(list)) throw new Error(`unexpected shape: ${JSON.stringify(body).slice(0, 200)}`);
  return list;
}

/* --- creators, from what the screened harvest already published --- */

const creatorData = JSON.parse(await readFile(CREATORS, 'utf8'));
const creatorRows = [];

for (const c of creatorData.creators ?? []) {
  for (const v of c.videos ?? []) {
    const n = toNumber(v.views);
    if (!n) continue;
    creatorRows.push({ kind: 'creator', name: c.name, note: note(v.hook), views: n, viewsLabel: compact(n) });
  }
}
creatorRows.sort((a, b) => b.views - a.views);

/* One row per creator, their best post -- which is what the lender half has
 * always been. Ranking posts instead let a single prolific creator take two or
 * three of the seven rows, which reads as a duplicate rather than as a point
 * about that creator, and spends the chart's limited space on fewer people. */
const seenCreators = new Set();
const topCreators = creatorRows
  .filter((r) => {
    if (seenCreators.has(r.name)) return false;
    seenCreators.add(r.name);
    return true;
  })
  .slice(0, TOP_CREATORS);
console.log(`${creatorRows.length} creator posts with views; keeping top ${topCreators.length}`);

/* --- lenders, harvested here --- */

const lenderRows = [];
const failures = [];
let loggedShape = false;

for (const lender of LENDERS) {
  try {
    const list = await media(lender.id);
    if (!loggedShape && list.length) {
      console.log(`  fields: ${Object.keys(list[0]).join(', ')}`);
      loggedShape = true;
    }

    /* Organic only. A lender's paid ads outrun their posts by a wide margin,
     * and quietly folding one in would answer "who does this audience follow"
     * with something the lender bought. */
    const organic = list
      .filter(isOrganic)
      .map((m) => ({ label: readViews(m), n: toNumber(readViews(m)) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n);

    if (!organic.length) {
      console.log(`  ${lender.name.padEnd(20)} no organic post with views`);
      continue;
    }
    lenderRows.push({
      kind: 'lender',
      name: lender.name,
      note: 'best post',
      views: organic[0].n,
      viewsLabel: compact(organic[0].n),
    });
    console.log(`  ${lender.name.padEnd(20)} ${list.length} returned, best organic ${organic[0].label}`);
  } catch (err) {
    failures.push({ lender: lender.name, why: err.message });
    console.log(`  ${lender.name.padEnd(20)} FAILED — ${err.message}`);
  }
  await sleep(PAUSE_MS);
}

lenderRows.sort((a, b) => b.views - a.views);
const topLenders = lenderRows.slice(0, TOP_LENDERS);

/* --- write --- */

/* One half alone is not a comparison. Publishing creators with no lender to
 * measure them against would leave the heading claiming a gap that the chart
 * no longer shows, so keep the previous section instead. */
if (!topCreators.length || !topLenders.length) {
  console.error(`Need both halves: ${topCreators.length} creator rows, ${topLenders.length} lender rows. Not writing.`);
  if (failures.length) console.error(failures);
  process.exit(1);
}

const rows = [...topCreators, ...topLenders].sort((a, b) => b.views - a.views);

await mkdir(join(ROOT, 'data'), { recursive: true });
await writeFile(OUT, `${JSON.stringify({
  fetchedAt: new Date().toISOString(),
  note: 'Best-performing ORGANIC post per row. Creators come from the screened roster in education-creators.json; lenders are harvested from the same nine brand ids the creative wall uses. Paid ads are excluded from both halves.',
  rows,
  failures,
}, null, 2)}\n`);

console.log(`\n${rows.length} rows: ${topCreators.length} creator, ${topLenders.length} lender`);
console.log(`top: ${rows[0].name} ${rows[0].viewsLabel} — bottom: ${rows[rows.length - 1].name} ${rows[rows.length - 1].viewsLabel}`);
if (failures.length) console.log(`${failures.length} lenders failed:`, failures);
