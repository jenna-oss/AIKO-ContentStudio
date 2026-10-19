/* ---------------------------------------------------------------------------
 * Harvest the creative wall — the actual ads the board lenders are running,
 * with their media, from the Spyglass API.
 *
 * The wall used to be hand-built cards with frozen day counts under a heading
 * that says "right now". This makes the claim true: daysRun comes from the API
 * on every refresh, and an ad that stopped running drops out.
 *
 * Paid only. Spyglass returns organic posts through the same endpoint, and a
 * section about what lenders are *buying* must not quietly include what they
 * merely posted.
 *
 * How "paid" is read has already changed once: `isOrganic` disappeared from the
 * response in early September 2026 and every row silently failed the filter,
 * which emptied the wall and failed this job for two weeks. isPaid() therefore
 * reads whichever signal the response actually carries, and the run logs one
 * whole row so the next such change is one log line to diagnose rather than a
 * fortnight of red.
 *
 * Needs SPYGLASS_API_KEY. Skips itself, without failing, when it is absent.
 * ------------------------------------------------------------------------ */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LENDERS } from './lenders.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://app.spyglass.so/api/v1';
const TIMEOUT_MS = 25000;
const PAUSE_MS = 400;

/* Credits are billed per row returned, so ask for a little more than we intend
 * to show and let the paid-only filter take its cut. */
const FETCH_PER_BRAND = 12;
const KEEP_PER_BRAND = 5;

/* Same nine as the board, and the slug matches the filter buttons. Shared with
 * pull-reach.mjs, which wants the organic side of the same companies. */
const BRANDS = LENDERS;

const KEY = String(process.env.SPYGLASS_API_KEY ?? '').trim();
if (!KEY) {
  console.log('SPYGLASS_API_KEY not set — skipping the creative refresh.');
  process.exit(0);
}

const redact = (s) => String(s).split(KEY).join('[REDACTED]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      userRequest: 'currently running paid ads',
      limit: FETCH_PER_BRAND,
      /* Required since mid-September 2026: the route 400s with "filters:
       * expected object, received undefined" without it. Paid and still
       * running, longest-running first — what the wall sorts by anyway. */
      filters: {
        channel: ['META_AD'],
        status: 'ACTIVE',
        sortBy: 'LONGEST_RUN',
        limit: FETCH_PER_BRAND,
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${redact(await res.text()).slice(0, 300)}`);
  return res.json();
}

/* One line of ad copy for the card. Prefer the hook, which is the opening line
 * as it ran; fall back to the title, stripped of the hashtag tail that carries
 * no meaning at card size. */
function line(c) {
  const raw = (c.hook || c.title || '').replace(/\s+/g, ' ').trim();
  const noTags = raw.replace(/(\s#[^\s#]+)+\s*$/, '').trim();
  const text = noTags || raw;
  return text.length > 150 ? `${text.slice(0, 147).trimEnd()}…` : text;
}

/* Paid rows are marked by an _AD-suffixed enum — META_AD, TIKTOK_AD — on
 * whichever of the platform/type fields the surface happens to expose (REST
 * sends `type` and `platforms`, the MCP surface sends `platform`). Prefer the
 * old boolean while any response still carries it, and treat a row we cannot
 * read as organic: wrongly dropping a paid ad costs one card, wrongly keeping
 * an organic post puts a thing nobody bought on a wall about ad spend. */
const AD_ENUM = /(^|_)AD$/i;

function tags(c) {
  return [c.platform, c.type, ...(Array.isArray(c.platforms) ? c.platforms : [])];
}

function isPaid(c) {
  if (typeof c.isOrganic === 'boolean') return c.isOrganic === false;
  return tags(c).some((t) => typeof t === 'string' && AD_ENUM.test(t.trim()));
}

const cards = [];
const failures = [];
let loggedShape = false;

for (const brand of BRANDS) {
  try {
    const body = await media(brand.id);
    /* REST calls it `media`; the MCP surface called it `creatives`. Accept both
     * rather than assume, and report the shape when it is neither. */
    const list = Array.isArray(body) ? body : (body?.media ?? body?.creatives ?? body?.rows);
    if (!Array.isArray(list)) {
      throw new Error(`unexpected shape: ${JSON.stringify(body).slice(0, 250)}`);
    }
    if (!loggedShape && list.length) {
      console.log(`  creative fields: ${Object.keys(list[0]).join(', ')}`);
      console.log(`  first row: ${JSON.stringify(list[0]).slice(0, 900)}`);
      loggedShape = true;
    }

    const paid = list
      .filter(isPaid)
      .filter((c) => c.mediaUrl && c.thumbnailUrl)
      .filter((c) => line(c))
      .sort((a, b) => (b.daysRun ?? 0) - (a.daysRun ?? 0))
      .slice(0, KEEP_PER_BRAND);

    for (const c of paid) {
      cards.push({
        slug: brand.slug,
        brand: brand.name,
        category: (c.categories && c.categories[0]) || null,
        line: line(c),
        mediaType: c.mediaType || null,
        mediaUrl: c.mediaUrl,
        thumbnailUrl: c.thumbnailUrl,
        platform: tags(c).find((t) => typeof t === 'string' && AD_ENUM.test(t.trim())) || null,
        daysRun: Number.isFinite(Number(c.daysRun)) ? Number(c.daysRun) : null,
        startAt: c.startAt ? String(c.startAt).slice(0, 10) : null,
      });
    }
    console.log(`  ${brand.name.padEnd(20)} ${list.length} returned, ${paid.length} paid kept`);
  } catch (err) {
    failures.push({ brand: brand.name, why: err.message });
    console.log(`  ${brand.name.padEnd(20)} FAILED — ${err.message}`);
  }
  await sleep(PAUSE_MS);
}

/* A wall with nothing on it would publish a section headed "what they are
 * running right now" showing nothing at all. Keep yesterday's instead. */
if (!cards.length) {
  console.error('No paid creatives returned. Not writing.');
  if (failures.length) console.error(failures);
  process.exit(1);
}

await mkdir(join(ROOT, 'data'), { recursive: true });
await writeFile(
  join(ROOT, 'data', 'creatives.json'),
  JSON.stringify({ fetchedAt: new Date().toISOString(), cards, failures }, null, 2)
);

const byBrand = cards.reduce((m, c) => { m[c.brand] = (m[c.brand] || 0) + 1; return m; }, {});
console.log(`\n${cards.length} paid creatives across ${Object.keys(byBrand).length} brands`);
if (failures.length) console.log(`${failures.length} brands failed:`, failures);
