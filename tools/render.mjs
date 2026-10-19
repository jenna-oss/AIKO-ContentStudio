/* ---------------------------------------------------------------------------
 * Stage 3 of 3 — write the automated regions of briefing.html.
 *
 * The briefing is hand-written analysis and stays that way. Only the regions
 * between AUTO markers are touched:
 *
 *   AUTO:TOTALS  the corpus size quoted in the long-tail section, which is the
 *                one figure on the page that moves every day
 *   AUTO:FEED    the live-feed section (currently removed from the page)
 *
 * Each region is independent and each is optional. A missing marker is a design
 * decision, not a failure — the job still harvests and commits.
 * ------------------------------------------------------------------------ */

import { readFile, writeFile } from 'node:fs/promises';
import { WALL_BRANDS, TOP_UP_TO, topUpAds } from './wall-brands.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'briefing.html');
const START = '<!-- AUTO:FEED:START -->';
const END = '<!-- AUTO:FEED:END -->';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const corpus = JSON.parse(await readFile(join(ROOT, 'data', 'ads.json'), 'utf8'));
const ads = Object.values(corpus.ads);
if (!ads.length) { console.error('Corpus is empty. Not rendering.'); process.exit(1); }

let html = await readFile(PAGE, 'utf8');

/* Replace the text between a marker pair. Returns the original untouched when
 * the markers are absent or inverted, so a missing region is a no-op. */
function replaceRegion(source, name, body) {
  const open = `<!-- AUTO:${name}:START -->`;
  const close = `<!-- AUTO:${name}:END -->`;
  const i = source.indexOf(open);
  const j = source.indexOf(close);
  if (i === -1 || j === -1 || j < i) return { html: source, wrote: false };
  return {
    html: source.slice(0, i) + open + body + close + source.slice(j + close.length),
    wrote: true,
  };
}

/* The corpus size, quoted mid-sentence in the long-tail section. This is the
 * only number on the page that changes daily, and it was drifting: the page
 * said 774 while the sweep had reached 781. */
const advertiserCount = new Set(ads.map((x) => x.advertiser)).size;
const totals = replaceRegion(
  html, 'TOTALS',
  `${ads.length.toLocaleString()} live ads from ${advertiserCount} advertisers`
);
html = totals.html;
if (totals.wrote) {
  console.log(`Totals: ${ads.length} ads from ${advertiserCount} advertisers.`);
}

/* The date the page speaks as of. A briefing without one invites the reader to
 * assume it is current, which is the failure mode worth designing against. */
const asOf = new Date(corpus.updatedAt);
const asOfText = asOf.toLocaleDateString('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
});
/* The same count on its own, for prose that needs the number without the
 * whole phrase — the page description, and anywhere a sentence already
 * supplies the words. Two TOTALS pairs would not work: replaceRegion matches
 * the first open and close it finds. */
const advertiserRegion = replaceRegion(html, 'ADVERTISERS', String(advertiserCount));
html = advertiserRegion.html;
if (advertiserRegion.wrote) console.log(`Advertisers: ${advertiserCount}.`);

const stamp = replaceRegion(html, 'ASOF', asOfText);
html = stamp.html;
if (stamp.wrote) console.log(`As of: ${asOfText}`);

/* Board cells carry data-ads="<advertiser>" and are filled from the corpus, so
 * the table cannot drift from the long-tail table on the same page. Matching is
 * prefix-based because our corpus records legal names — 'Lima One Capital, LLC'
 * against a column that reads 'Lima One Capital'. */
let filled = 0;
html = html.replace(
  /<(td|span)([^>]*?)data-ads="([^"]+)"([^>]*)>[\s\S]*?<\/\1>/g,
  (_, tag, before, brand, after) => {
    const needle = brand.toLowerCase();
    const n = ads.filter((x) => String(x.advertiser).toLowerCase().startsWith(needle)).length;
    filled += 1;
    /* A table cell carries the whole phrase; an inline span sits inside a
     * sentence that already supplies the words, so it gets the bare number. */
    const body = tag === 'span'
      ? String(n)
      : (n === 0 ? '<span class="absent">no paid ads</span>' : `${n} live ${n === 1 ? 'ad' : 'ads'}`);
    return `<${tag}${before}data-ads="${brand}"${after}>${body}</${tag}>`;
  }
);
if (filled) console.log(`Filled ${filled} figures from the corpus.`);

/* The creative wall. Cards and filter buttons are both generated, so a lender
 * whose ads all stopped loses its button rather than leaving a filter that
 * selects nothing. Absent data leaves the hand-built wall in place. */
let creatives = null;
try {
  creatives = JSON.parse(await readFile(join(ROOT, 'data', 'creatives.json'), 'utf8'));
} catch { /* not harvested yet */ }

/* Artwork for the Ad Library top-ups, harvested separately by
 * tools/adlib-thumbs.mjs. Absent until that has run, and absent for any ad it
 * could not reach — both cases fall back to the date plate. */
let adlibThumbs = {};
try {
  adlibThumbs = JSON.parse(await readFile(join(ROOT, 'data', 'adlib-thumbs.json'), 'utf8')).thumbs ?? {};
} catch { /* not harvested yet */ }

if (creatives?.cards?.length) {
  const cards = [...creatives.cards];

  /* Spyglass only carries paid creative for some of these lenders — three of
   * nine on the first run — but our own Ad Library sweep has copy for the rest.
   * Top those up with text-only cards so the wall covers everyone who is
   * actually in market, rather than only whoever Spyglass indexes. Same design
   * the hand-built wall had, which mixed both sources. */
  for (const b of WALL_BRANDS) {
    const have = cards.filter((c) => c.slug === b.slug).length;
    if (have >= TOP_UP_TO) continue;

    const mine = topUpAds(ads, b, TOP_UP_TO - have);

    for (const ad of mine) {
      cards.push({
        slug: b.slug,
        brand: b.label,
        category: null,
        line: ad.copy.replace(/\s+/g, ' ').trim().slice(0, 150),
        mediaType: 'AD LIBRARY',
        mediaUrl: `https://www.facebook.com/ads/library/?id=${ad.libraryId}`,
        thumbnailUrl: adlibThumbs[ad.libraryId] ?? null,
        daysRun: null,
        started: ad.started || null,
      });
    }
  }

  const order = WALL_BRANDS.map((b) => b.slug);
  cards.sort((x, y) => order.indexOf(x.slug) - order.indexOf(y.slug));
  const present = order.filter((slug) => cards.some((c) => c.slug === slug));

  const labels = new Map(WALL_BRANDS.map((b) => [b.slug, b.label]));
  for (const c of cards) if (!labels.has(c.slug)) labels.set(c.slug, c.brand);

  const buttons = [
    '      <button type="button" data-f="all" aria-pressed="true">All</button>',
    ...present.map((slug) =>
      `      <button type="button" data-f="${slug}" aria-pressed="false">${esc(labels.get(slug))}</button>`),
  ].join('\n');

  const wall = cards.map((c) => {
    const chip = esc(c.mediaType || 'AD');
    /* daysRun is the API's own figure, so the wall cannot claim a duration it
     * has not checked. Omit it rather than print a zero. */
    const age = c.daysRun ? ` ${c.daysRun}d` : '';
    const who = c.category ? `${c.brand} · ${c.category}` : c.brand;

    /* Ad Library cards have no artwork — Meta does not hand it over. Use the
     * launch date in the thumbnail slot, as the removed live-feed section did,
     * rather than a broken image. */
    const thumb = c.thumbnailUrl
      ? `<img class="thumb" loading="lazy" decoding="async" alt="${esc(c.brand)} ad still" src="${esc(c.thumbnailUrl)}">`
      : `<span class="thumb-none">${esc(String(c.started || '').replace(/,.*/, '').toUpperCase())}</span>`;

    return `
      <a class="creative" data-b="${esc(c.slug)}" href="${esc(c.mediaUrl)}">
        ${thumb}
        <span class="body">
          <span class="who">${esc(who)}</span>
          <span class="line">${esc(c.line)}</span>
          <span class="meta"><span class="chip">${chip}</span>${age} <span class="view">View →</span></span>
        </span>
      </a>`;
  }).join('\n');

  const longest = Math.max(0, ...cards.map((c) => c.daysRun || 0));

  const filters = replaceRegion(html, 'FILTERS', `\n${buttons}\n    `);
  html = filters.html;
  const wallRegion = replaceRegion(html, 'WALL', `${wall}\n    `);
  html = wallRegion.html;
  const longestRegion = replaceRegion(html, 'LONGEST', String(longest));
  html = longestRegion.html;

  if (wallRegion.wrote) {
    console.log(`Wall: ${cards.length} creatives, longest running ${longest}d.`);
  }
}

const a = html.indexOf(START);
const b = html.indexOf(END);

/* The live-feed section was removed from the page. Absent markers are a design
 * decision, not a failure — write whatever else changed and exit cleanly rather
 * than going red every morning. */
if (a === -1 || b === -1 || b < a) {
  if (totals.wrote || stamp.wrote || filled || creatives?.cards?.length) {
    await writeFile(PAGE, html);
    console.log('Wrote the automated regions. No AUTO:FEED region — skipping the feed.');
  } else {
    console.log('No AUTO regions in briefing.html — nothing to render.');
  }
  process.exit(0);
}

const byFirstSeen = [...ads].sort((x, y) =>
  (y.firstSeen || '').localeCompare(x.firstSeen || '') ||
  Date.parse(y.started || 0) - Date.parse(x.started || 0));

const newest = byFirstSeen.slice(0, 12);
const advertisers = new Set(ads.map((x) => x.advertiser));

/* Exclude the baseline sweep: those ads were first *observed* on day one but
 * are not new to the market, and counting them would overstate the feed for a
 * week after setup. */
const cutoff = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
const thisWeek = ads.filter(
  (x) => x.firstSeen >= cutoff && x.firstSeen !== corpus.baselineDay
);

const updated = new Date(corpus.updatedAt);
const stale = (Date.now() - updated.getTime()) > 3 * 864e5;

const cards = newest.map((x) => `
      <div class="creative">
        <span class="thumb-none">${esc((x.started || '').replace(/,.*/, '').toUpperCase())}</span>
        <span class="body">
          <span class="who">${esc(x.advertiser)}</span>
          <span class="line">${esc(x.copy.slice(0, 190))}</span>
          <span class="meta"><span class="chip">FIRST SEEN ${esc(x.firstSeen)}</span></span>
        </span>
      </div>`).join('\n');

const summary = corpus.baselineRun
  ? `<p><strong>Baseline sweep.</strong> The first run records the category as it
       stands, so nothing is marked new yet — ${ads.length} ads across
       ${advertisers.size} advertisers. From here on this section reports only
       creative that was not there the day before.</p>`
  : `<p><strong>${thisWeek.length} ${thisWeek.length === 1 ? 'ad' : 'ads'} newly observed in the
       last seven days</strong>, against a tracked corpus of ${ads.length} ads across
       ${advertisers.size} advertisers. The baseline sweep of
       ${esc(corpus.baselineDay || 'setup')} is excluded — those were first seen by us
       that day but were already running.</p>`;

const staleNote = stale
  ? `<p class="dark-list">⚠ Last successful run was ${esc(corpus.updatedAt.slice(0, 10))} —
       more than three days ago. The scheduled job may be blocked or broken.</p>`
  : '';

const block = `${START}
    <div class="method">
      <h3>Feed status</h3>
      ${summary}
      ${staleNote}
      <p class="dark-list">Run ${corpus.runs} · last updated ${esc(corpus.updatedAt.slice(0, 16).replace('T', ' '))} UTC · tracking ${ads.length} ads</p>
    </div>

    <div class="wall" style="margin-top:var(--s4)">${cards}
    </div>
    ${END}`;

const out = html.slice(0, a) + block + html.slice(b + END.length);

/* Guard: never shrink the page dramatically — that would mean we clobbered
 * something outside the markers. */
if (out.length < html.length * 0.6) {
  console.error('Rendered page is suspiciously smaller than the original. Not writing.');
  process.exit(1);
}

await writeFile(PAGE, out);
console.log(`Rendered ${newest.length} cards · ${thisWeek.length} new this week · run ${corpus.runs}`);
