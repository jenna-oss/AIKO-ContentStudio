/* ---------------------------------------------------------------------------
 * Artwork for the wall's Ad Library cards.
 *
 * Spyglass only indexes paid creative for some of these lenders, so render.mjs
 * tops the rest up from our own Ad Library sweep. Those records carry copy and
 * a launch date but no image — data/ads.json has never stored one — and the
 * cards rendered as a date plate where every neighbouring card has a picture.
 *
 * The Ad Library does show the creative; it just does not hand it to a plain
 * HTTP client, so this drives the same headless browser the sweep does. The
 * image is bound to its Library ID by walking up from the element that carries
 * that exact id: a permalink renders four or five related ads alongside the one
 * asked for, and taking the first image on the page picks a neighbour's.
 *
 * Meta's CDN urls are signed and expire within days, so the bytes are saved
 * locally rather than linked. Results are cached in data/adlib-thumbs.json and
 * an ad already in there is never fetched twice.
 *
 * Every failure is soft. A card with no artwork falls back to the date plate,
 * which is what it did before this file existed.
 * ------------------------------------------------------------------------ */

import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WALL_BRANDS, TOP_UP_TO, topUpAds } from './wall-brands.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTDIR = join(ROOT, 'assets', 'thumbs');
const MAP = join(ROOT, 'data', 'adlib-thumbs.json');

const NAV_TIMEOUT = 60000;
const RENDER_TIMEOUT = 20000;
const SETTLE_MS = 3500;
/* Meta rate-limits a browser that walks permalinks back to back. */
const PAUSE_MS = 1500;
const MIN_ASSET_BYTES = 12000;

/* Runs inside the page. Finds the smallest element whose text carries this
 * Library ID, then climbs until it finds artwork — the picture lives a few
 * levels above the id line, and the climb stops before it reaches a container
 * wide enough to hold the next ad. */
function artFor(wantId) {
  const marker = 'Library ID: ' + wantId;
  const holders = [...document.querySelectorAll('div')].filter(
    (d) => d.innerText && d.innerText.includes(marker)
  );
  if (!holders.length) return null;
  holders.sort((a, b) => a.innerText.length - b.innerText.length);

  let node = holders[0];
  for (let i = 0; i < 8 && node; i++) {
    const art = [...node.querySelectorAll('img, video')]
      .map((e) => ({
        src: e.tagName === 'VIDEO' ? (e.poster || e.src) : e.src,
        w: e.naturalWidth || e.videoWidth || 0,
        h: e.naturalHeight || e.videoHeight || 0,
      }))
      /* Profile pictures and platform icons are small; creative is not. */
      .filter((e) => e.src && e.w >= 150 && e.h >= 150);
    if (art.length) return art[0].src;
    node = node.parentElement;
  }
  return null;
}

const corpus = JSON.parse(await readFile(join(ROOT, 'data', 'ads.json'), 'utf8'));
const ads = Object.values(corpus.ads);

let creatives = { cards: [] };
try {
  creatives = JSON.parse(await readFile(join(ROOT, 'data', 'creatives.json'), 'utf8'));
} catch { /* no Spyglass harvest yet — then every brand needs topping up */ }

let map = {};
try {
  map = JSON.parse(await readFile(MAP, 'utf8')).thumbs ?? {};
} catch { /* first run */ }

/* Exactly the ads render.mjs will turn into cards, and no others. */
const wanted = [];
for (const brand of WALL_BRANDS) {
  const have = creatives.cards.filter((c) => c.slug === brand.slug).length;
  if (have >= TOP_UP_TO) continue;
  for (const ad of topUpAds(ads, brand, TOP_UP_TO - have)) {
    wanted.push({ ...ad, brand: brand.label });
  }
}

const todo = wanted.filter((a) => !map[a.libraryId]);
console.log(`${wanted.length} Ad Library cards on the wall, ${todo.length} without artwork.`);
if (!todo.length) process.exit(0);

await mkdir(OUTDIR, { recursive: true });

/* Locally the cached browser build often lags the npm package; point
 * PW_CHROMIUM_PATH at an existing chrome.exe to reuse it, as pull.mjs does. */
const browser = await chromium.launch(
  process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}
);
const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
const page = await context.newPage();

let saved = 0;
const failures = [];

for (const ad of todo) {
  const url = `https://www.facebook.com/ads/library/?id=${ad.libraryId}`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    for (const label of ['Allow all cookies', 'Decline optional cookies', 'Only allow essential cookies']) {
      const btn = page.getByRole('button', { name: label });
      if (await btn.count().catch(() => 0)) { await btn.first().click().catch(() => {}); break; }
    }

    await page.waitForFunction(
      () => /Library ID:/i.test(document.body.innerText), null, { timeout: RENDER_TIMEOUT }
    ).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);

    const src = await page.evaluate(artFor, ad.libraryId);
    if (!src) throw new Error('no artwork bound to that Library ID');

    /* Through the page's own request context, so the signed url is fetched with
     * the cookies and referer it was issued for. */
    const res = await context.request.get(src, { timeout: 30000 });
    if (!res.ok()) throw new Error(`asset fetch ${res.status()}`);
    const body = await res.body();
    /* A blank plate compresses to about 4KB at this size and a real creative to
     * thirty or more, so the floor sits between them. Temple View's first fetch
     * came back a solid white 4,080 bytes — the same failure the video
     * thumbnails had, in a different format. Rejecting it costs nothing: the
     * card falls back to the date plate, which is where it started. */
    if (body.length < MIN_ASSET_BYTES) throw new Error(`blank asset — only ${body.length} bytes`);

    const rel = `./assets/thumbs/adlib-${ad.libraryId}.jpg`;
    await writeFile(join(OUTDIR, `adlib-${ad.libraryId}.jpg`), body);
    map[ad.libraryId] = rel;
    saved += 1;
    console.log(`  ${ad.brand.padEnd(12)} ${ad.libraryId}  ${(body.length / 1024).toFixed(0)}KB`);
  } catch (err) {
    failures.push({ libraryId: ad.libraryId, brand: ad.brand, why: String(err.message).slice(0, 100) });
    console.log(`  ${ad.brand.padEnd(12)} ${ad.libraryId}  failed — ${String(err.message).slice(0, 70)}`);
  }
  await page.waitForTimeout(PAUSE_MS);
}

await browser.close();

if (saved) {
  await writeFile(MAP, JSON.stringify({ updatedAt: corpus.updatedAt, thumbs: map }, null, 2));
}

console.log(`\n${saved} of ${todo.length} fetched.`);
if (failures.length) console.log(`${failures.length} failed:`, failures);
