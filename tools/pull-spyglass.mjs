/* ---------------------------------------------------------------------------
 * Refresh the hook-pattern corpus from the Spyglass API.
 *
 * Spyglass bills credits per row returned, so this is deliberately narrow: a
 * fixed brand list, two insight types, one call each. It is not wired into the
 * agent at request time for the same reason — a live tool call would spend
 * credits on every question asked. The agent reads the Postgres copy; this
 * refreshes that copy on a schedule.
 *
 * Needs SPYGLASS_API_KEY. Skips itself, without failing, when it is absent.
 * ------------------------------------------------------------------------ */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://app.spyglass.so/api/v1';
const TIMEOUT_MS = 20000;
const PAUSE_MS = 400;

/* HOOK is how a piece opens, AD_ANGLE is the claim it leads with. AD_ANGLE
 * replaced USP, which the API dropped in September 2026; the USP rows already
 * stored are kept but no longer refresh. TARGET_PERSONA and MEDIA_MIX are
 * available but not pulled — they answer a different question and every row
 * costs credits. */
const TYPES = ['HOOK', 'AD_ANGLE'];

/* Resolved once and pinned. Re-searching by name on every run would spend
 * credits to rediscover ids that do not change, and risks silently latching
 * onto a different brand when a name is ambiguous. */
const BRANDS = [
  { id: '108521893501',    name: 'NerdWallet',      category: 'Finance' },
  { id: '84763399274',     name: 'LendingTree',     category: 'Finance' },
  { id: '246223015551168', name: 'Chime',           category: 'Finance' },
  { id: '633318986770616', name: 'Rocket Money',    category: 'Finance' },
  { id: '33416011787',     name: 'Robert Kiyosaki', category: 'Finance' },
  { id: '7129388593',      name: 'Zillow',          category: 'Real Estate' },
  { id: '116482854782233', name: 'Alex Hormozi',    category: 'Education' },
];

const KEY = String(process.env.SPYGLASS_API_KEY ?? '').trim();
if (!KEY) {
  console.log('SPYGLASS_API_KEY not set — skipping the hook-pattern refresh.');
  process.exit(0);
}

const redact = (s) => String(s).split(KEY).join('[REDACTED]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function insights(brandId, type) {
  const url = `${BASE}/brands/${encodeURIComponent(brandId)}/insights?type=${type}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${KEY}`, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${redact(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

/* The REST response is bucketed by week — {type, count, buckets:[{year, week,
 * clusters:[{id, label, rawDelta, percentDelta}]}]} — where the MCP surface
 * handed back a flat list with a usage count per pattern.
 *
 * REST carries no per-pattern volume: a cluster is only {id, label, rawDelta,
 * percentDelta}, and the top-level `count` is the number of clusters. So total
 * is left null rather than guessed, and the upsert coalesces it so a refresh
 * never overwrites a volume the MCP already established.
 *
 * What REST can tell us is persistence: how many weeks of the window a pattern
 * appeared in. A hook used every week for two months is a different signal from
 * one that spiked once, and that distinction survives here. */
const VOLUME_KEYS = ['total', 'count', 'size', 'volume', 'mediaCount', 'adCount'];
let loggedShape = false;

function flatten(body) {
  /* Flat form, in case the API ever grows one. */
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.rows)) return body.rows;
  if (!Array.isArray(body?.buckets)) return null;

  const buckets = [...body.buckets].sort(
    (a, b) => (a.year - b.year) || (a.week - b.week)
  );

  const byLabel = new Map();

  for (const bucket of buckets) {
    for (const c of bucket.clusters ?? []) {
      const label = String(c.label ?? '').trim();
      if (!label) continue;

      if (!loggedShape) {
        console.log(`  cluster fields: ${Object.keys(c).join(', ')}`);
        loggedShape = true;
      }

      const prev = byLabel.get(label)
        ?? { label, total: null, weeksActive: 0, rawDelta: null, percentDelta: null };

      prev.weeksActive += 1;

      /* If a volume field ever appears, use it — but never invent a zero. */
      const key = VOLUME_KEYS.find((k) => Number.isFinite(Number(c[k])));
      if (key) prev.total = (prev.total ?? 0) + Number(c[key]);

      /* Buckets are ascending, so the last non-null wins: the most recent week
       * that had something to compare against. */
      if (c.rawDelta !== null && c.rawDelta !== undefined) prev.rawDelta = c.rawDelta;
      if (c.percentDelta !== null && c.percentDelta !== undefined) prev.percentDelta = c.percentDelta;

      byLabel.set(label, prev);
    }
  }

  return [...byLabel.values()].sort((a, b) => b.weeksActive - a.weeksActive);
}

const rows = [];
const failures = [];

for (const brand of BRANDS) {
  for (const type of TYPES) {
    try {
      const body = await insights(brand.id, type);

      const list = flatten(body);
      if (!Array.isArray(list)) {
        throw new Error(`unexpected shape: ${JSON.stringify(body).slice(0, 300)}`);
      }

      for (const r of list) {
        rows.push({
          brand_id: brand.id,
          brand_name: brand.name,
          category: brand.category,
          insight_type: type,
          label: r.label,
          /* Null, not zero — the upsert coalesces, so an unknown volume leaves
           * an established one alone. */
          total: r.total ?? null,
          weeks_active: r.weeksActive ?? null,
          raw_delta: r.rawDelta ?? null,
          percent_delta: r.percentDelta ?? null,
        });
      }
      console.log(`  ${brand.name.padEnd(16)} ${type.padEnd(8)} ${list.length} patterns`);
    } catch (err) {
      failures.push({ brand: brand.name, type, why: err.message });
      console.log(`  ${brand.name.padEnd(16)} ${type.padEnd(8)} FAILED — ${err.message}`);
    }
    await sleep(PAUSE_MS);
  }
}

/* A partial refresh is fine — the upsert leaves untouched rows alone. An empty
 * one means something is systematically wrong and should not be written. */
const deadTypes = TYPES.filter(
  (type) => failures.filter((f) => f.type === type).length === BRANDS.length
);
if (!rows.length) {
  console.error('Spyglass returned no patterns at all. Not writing.');
  if (failures.length) console.error(failures);
  process.exit(1);
}

/* A pattern present in no weekly bucket is a parsing failure, not a finding. */
if (rows.every((r) => !r.weeks_active)) {
  console.error('Every pattern has weeks_active 0 — the bucket parsing is wrong. Not writing.');
  process.exit(1);
}

await mkdir(join(ROOT, 'data'), { recursive: true });
await writeFile(
  join(ROOT, 'data', 'hook-patterns.json'),
  JSON.stringify({ fetchedAt: new Date().toISOString(), rows, failures }, null, 2)
);

console.log(`\n${rows.length} patterns across ${BRANDS.length} brands`);
if (failures.length) console.log(`${failures.length} calls failed:`, failures);

/* Every brand failing on one insight type is the API changing under us, not a
 * blip. What did come back is written above, but the run must go red. */
if (deadTypes.length) {
  console.error(`Every call failed for ${deadTypes.join(', ')} — the API has likely changed.`);
  process.exit(1);
}
