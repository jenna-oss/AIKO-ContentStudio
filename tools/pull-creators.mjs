/* ---------------------------------------------------------------------------
 * Refresh the educational-creators page: every creator's videos, and the
 * roster itself.
 *
 * The page began as a one-time hand pass on 2026-08-17 and said so. This puts
 * it on the daily schedule the rest of the site runs on.
 *
 * Three things make this harder than the creative wall it is modelled on:
 *
 * 1. ORGANIC, NOT PAID. This is the exact inverse of pull-creatives.mjs. The
 *    page is about what these people post, so an ad must never appear on it.
 *    Paid rows carry an _AD-suffixed enum on platform/type; anything we cannot
 *    read is treated as PAID and dropped, which is the safe direction here and
 *    the opposite of the wall's default.
 *
 * 2. THE CORPUS DRIFTS OFF-THESIS. Spyglass returns a creator's recent posts,
 *    not their real estate posts. Sean Pan's most recent organic video on
 *    2026-09-08 was about tax-free shopping in Japan, followed by index funds
 *    and compound interest. A page premised on residential real estate
 *    investing cannot publish those, and no keyword rule reliably separates
 *    them, so every candidate video is screened by Claude before it lands.
 *
 * 3. HOOKS ARE SOMETIMES NULL. The card shows the hook as its only text, so a
 *    null would publish an empty card. We fall back to the caption's first
 *    line for DISPLAY, but mark it hookSource:'title' so the pattern miner can
 *    exclude it — a caption headline is not a spoken opening, and mining it as
 *    one would quietly corrupt the hook library.
 *
 * Needs SPYGLASS_API_KEY. Skips itself, without failing, when it is absent.
 * Needs ANTHROPIC_API_KEY for the relevance screen; without it the run keeps
 * the existing videos rather than publishing unscreened ones.
 * ------------------------------------------------------------------------ */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeJson, hasKey, MissingKey } from './claude-json.mjs';
import { toCards } from './creator-media.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data', 'education-creators.json');
const BASE = 'https://app.spyglass.so/api/v1';
const TIMEOUT_MS = 25000;
const PAUSE_MS = 400;

/* Credits are billed per row returned. Ask for enough that the organic and
 * relevance filters have something to cut, and no more. */
const FETCH_PER_CREATOR = 12;
const KEEP_PER_CREATOR = 4;
const SCREEN_BATCH = 30;

/* Discovery guardrails. New creators publish without review, so these are the
 * only thing between the corpus and the live page. */
const MIN_FOLLOWERS = 25000;
const MAX_ROSTER = 16;
const MAX_NEW_PER_RUN = 2;
const MIN_ON_THESIS_VIDEOS = 2;

/* Caps candidates EXAMINED, not added. Vetting one costs a 12-row media call
 * whether or not it passes, so without this a day when nothing qualifies is
 * the most expensive day there is: every candidate the search returned gets
 * fetched and screened, and the roster still does not grow. */
const MAX_CANDIDATES_CHECKED = 6;

/* The filter buttons on creators.html are built from these, so an invented
 * value would render as a raw slug chip. */
const PLATFORM_LABELS = { INSTAGRAM: 'Instagram', TIKTOK: 'TikTok', FACEBOOK: 'Facebook' };

const PRODUCT_LINES = ['dscr', 'fix-and-flip', 'bridge', 'ground-up', 'portfolio', 'brrrr', 'multifamily'];

const DISCOVERY_QUERIES = [
  'individual educator teaching residential real estate investing, rental property analysis and financing',
  'creator explaining DSCR loans, BRRRR and fix and flip financing to investors',
];

const KEY = String(process.env.SPYGLASS_API_KEY ?? '').trim();
if (!KEY) {
  console.log('SPYGLASS_API_KEY not set — skipping the creator refresh.');
  process.exit(0);
}

const redact = (s) => String(s).split(KEY).join('[REDACTED]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function spyglass(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${KEY}`,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${redact(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function creatorMedia(brandId) {
  const body = await spyglass(`/brands/${encodeURIComponent(brandId)}/media`, {
    method: 'POST',
    body: JSON.stringify({
      mode: 'structured',
      userRequest: 'most recent organic video posts',
      limit: FETCH_PER_CREATOR,
      /* Required since mid-September 2026: the route 400s with "filters:
       * expected object, received undefined" without it. Organic channels
       * only, newest first — what userRequest already asks for in words. */
      filters: {
        channel: ['INSTAGRAM', 'TIKTOK'],
        sortBy: 'MOST_RECENT',
        limit: FETCH_PER_CREATOR,
      },
    }),
  });
  const list = Array.isArray(body) ? body : (body?.creatives ?? body?.media ?? body?.rows);
  if (!Array.isArray(list)) {
    throw new Error(`unexpected shape: ${JSON.stringify(body).slice(0, 250)}`);
  }
  return list;
}

/* ------------------------------------------------------------ discovery ---- */

/* searchBrands is documented on the MCP surface, which is tied to a Claude
 * account and unreachable from CI. The REST equivalent is not documented
 * anywhere we have, so try the plausible spellings and report which one
 * answered — one log line makes this a five-minute fix instead of a guess.
 * Discovery failing is survivable; the roster simply does not grow today. */
/* Confirmed live on 2026-09-09: /brands/search is the route. It answered with
 * a field-level validation error while the alternatives 404'd, which is how we
 * found it. The fallbacks stay as a cheap hedge if the path ever moves. */
const SEARCH_ROUTES = [
  { path: '/brands/search', method: 'POST' },
  { path: '/search/brands', method: 'POST' },
];

function searchBody(query) {
  return JSON.stringify({
    mode: 'smart',
    type: 'CREATOR',
    query,
    count: 20,
    minFollowers: MIN_FOLLOWERS,
    /* No sortBy: the API rejects it for mode "smart" — "results are ordered by
     * relevance". That 400 is also how we learned this route is the real one;
     * the other two spellings 404. */
  });
}

async function searchCreators(query) {
  const errors = [];
  for (const route of SEARCH_ROUTES) {
    try {
      const body = await spyglass(route.path, { method: route.method, body: searchBody(query) });
      const list = Array.isArray(body) ? body : (body?.brands ?? body?.results ?? body?.rows);
      if (!Array.isArray(list)) {
        errors.push(`${route.path} -> unexpected shape ${JSON.stringify(body).slice(0, 120)}`);
        continue;
      }
      console.log(`  discovery route ${route.method} ${route.path} answered with ${list.length} rows`);
      if (list.length) console.log(`  search fields: ${Object.keys(list[0]).join(', ')}`);
      return list;
    } catch (err) {
      errors.push(`${route.path} -> ${err.message}`);
    }
    await sleep(PAUSE_MS);
  }
  throw new Error(`no discovery route answered: ${errors.join(' | ')}`);
}

/* The search surface and the media surface disagree about shape. The MCP
 * search returns followers:[{platform, handle, count}]; the REST route that
 * actually answers returns flat igFollowers / igUsername / tiktokFollowers /
 * tiktokUsername instead. Reading only the MCP shape scored every candidate at
 * zero followers, so all 50 failed the follower gate and the roster could
 * never grow -- the run looked healthy and did nothing. Read both. */
function parseCount(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  const n = /k$/i.test(s) ? parseFloat(s) * 1e3
    : /m$/i.test(s) ? parseFloat(s) * 1e6
      : parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

const compact = (n) => (n >= 1e6
  ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K` : String(n));

function followerCount(b) {
  const rows = [];

  /* MCP shape. */
  for (const f of Array.isArray(b.followers) ? b.followers : []) {
    rows.push({ n: parseCount(f.count), handle: f.handle ?? null, platform: f.platform ?? null, label: String(f.count ?? '').trim() || null });
  }
  /* REST shape. */
  if (b.igFollowers !== undefined || b.igUsername) {
    const n = parseCount(b.igFollowers);
    if (n) rows.push({ n, handle: b.igUsername ?? null, platform: 'INSTAGRAM', label: compact(n) });
  }
  if (b.tiktokFollowers !== undefined || b.tiktokUsername) {
    const n = parseCount(b.tiktokFollowers);
    if (n) rows.push({ n, handle: b.tiktokUsername ?? null, platform: 'TIKTOK', label: compact(n) });
  }

  const best = rows.sort((x, y) => y.n - x.n)[0];
  return best
    ? { count: best.n, label: best.label, handle: best.handle, platform: best.platform }
    : { count: 0, label: null, handle: null, platform: null };
}

/* ------------------------------------------------------- relevance screen -- */

const SCREEN_SYSTEM = `You screen short-form videos for an internal reference page about RESIDENTIAL REAL ESTATE INVESTING education.

KEEP a video only if it teaches something about residential real estate investing or its financing: buying, financing, renting, renovating, or analysing residential investment property; loan programs such as DSCR, bridge, fix-and-flip, BRRRR, ground-up, portfolio or multifamily; deal numbers, cash flow, or qualification.

DROP everything else, however popular: general personal finance, index funds, stocks, crypto, budgeting, travel, lifestyle, motivation, business coaching, commercial-only or land-only investing, and pure promotion of a course or a giveaway with no teaching in it.

Judge the video itself, not the creator's usual subject. Be strict: a video that merely mentions real estate in passing while teaching something else is a DROP.

Reply with JSON only: {"decisions":[{"id":"<id>","keep":true|false,"why":"<8 words max>"}]}. Include every id you were given, exactly once.`;

async function screen(items) {
  if (!items.length) return new Map();
  const decisions = new Map();

  for (let i = 0; i < items.length; i += SCREEN_BATCH) {
    const batch = items.slice(i, i + SCREEN_BATCH);
    const user = `Screen these ${batch.length} videos.\n\n${batch
      .map((v) => `id: ${v.id}\ncreator: ${v.creator}\nhook: ${v.hook}\ncaption: ${String(v.title ?? '').replace(/\s+/g, ' ').slice(0, 220)}`)
      .join('\n\n')}`;

    const out = await claudeJson({ system: SCREEN_SYSTEM, user, maxTokens: 4096 });
    for (const d of out.decisions ?? []) {
      if (d && d.id) decisions.set(String(d.id), { keep: d.keep === true, why: d.why ?? '' });
    }
  }
  return decisions;
}

/* ------------------------------------------------------------------ run ---- */

const existing = JSON.parse(await readFile(DATA, 'utf8'));
const roster = existing.creators ?? [];

const missingIds = roster.filter((c) => !c.spyglassId);
if (missingIds.length) {
  console.error(`These creators have no spyglassId and cannot be refreshed: ${missingIds.map((c) => c.name).join(', ')}`);
  console.error('Resolve them once via the Spyglass creator search and pin the ids into data/education-creators.json.');
  process.exit(1);
}

const screenReady = hasKey();
if (!screenReady) {
  console.log('ANTHROPIC_API_KEY not set — cannot screen for relevance, so videos will not be replaced.');
}

/* --- 1. harvest the pinned roster --- */

const harvest = new Map();
const failures = [];
let loggedShape = false;

for (const c of roster) {
  try {
    const list = await creatorMedia(c.spyglassId);
    if (!loggedShape && list.length) {
      console.log(`  creative fields: ${Object.keys(list[0]).join(', ')}`);
      loggedShape = true;
    }
    const organic = toCards(list);

    harvest.set(c.slug, organic);
    console.log(`  ${c.name.padEnd(18)} ${list.length} returned, ${organic.length} organic video`);
  } catch (err) {
    failures.push({ creator: c.name, why: err.message });
    console.log(`  ${c.name.padEnd(18)} FAILED — ${err.message}`);
  }
  await sleep(PAUSE_MS);
}

if (!harvest.size) {
  console.error('Spyglass returned nothing for any creator. Keeping the existing page.');
  console.error(failures);
  process.exit(1);
}

/* --- 2. screen it --- */

let screened = new Map();
if (screenReady) {
  const flat = [];
  for (const c of roster) {
    for (const v of harvest.get(c.slug) ?? []) flat.push({ ...v, creator: c.name, slug: c.slug });
  }
  try {
    screened = await screen(flat);
    const kept = [...screened.values()].filter((d) => d.keep).length;
    console.log(`\n  relevance screen: ${kept}/${flat.length} videos on-thesis`);
  } catch (err) {
    if (err instanceof MissingKey) {
      console.log('  no Anthropic key — keeping existing videos.');
    } else {
      console.log(`  relevance screen FAILED — ${err.message}`);
      console.log('  keeping existing videos rather than publishing unscreened ones.');
    }
    screened = new Map();
  }
}

/* --- 3. rebuild each creator's card --- */

const updated = roster.map((c) => {
  const fresh = harvest.get(c.slug);
  /* No harvest, or nothing survived screening, means keep what is already
   * published. A creator card with no clips is worse than a stale one. */
  if (!fresh || !screened.size) return c;

  const keep = fresh
    .filter((v) => screened.get(String(v.id))?.keep)
    .sort((a, b) => String(b.postedAt ?? '').localeCompare(String(a.postedAt ?? '')))
    .slice(0, KEEP_PER_CREATOR)
    .map(({ title, ...v }) => v);

  if (keep.length < 2) {
    console.log(`  ${c.name}: only ${keep.length} on-thesis video this run — keeping the previous clips.`);
    return c;
  }
  return { ...c, videos: keep };
});

/* --- 4. discovery --- */

const added = [];
if (screenReady && updated.length < MAX_ROSTER) {
  try {
    const seen = new Set(updated.map((c) => String(c.spyglassId)));
    const candidates = [];
    for (const q of DISCOVERY_QUERIES) {
      for (const b of await searchCreators(q)) {
        if (!b?.id || seen.has(String(b.id))) continue;
        if (candidates.some((x) => String(x.id) === String(b.id))) continue;
        if (b.category && !/creator/i.test(String(b.category))) continue;
        const f = followerCount(b);
        if (f.count < MIN_FOLLOWERS) continue;
        candidates.push({ ...b, _followers: f });
      }
      await sleep(PAUSE_MS);
    }
    const shortlist = candidates.slice(0, MAX_CANDIDATES_CHECKED);
    console.log(`
  ${candidates.length} candidates past the guardrails; vetting ${shortlist.length}`);
    if (candidates.length > shortlist.length) {
      console.log(`  ${candidates.length - shortlist.length} left unvetted — they are reconsidered tomorrow.`);
    }

    for (const cand of shortlist) {
      if (added.length >= MAX_NEW_PER_RUN || updated.length + added.length >= MAX_ROSTER) break;
      try {
        const list = await creatorMedia(cand.id);
        const organic = toCards(list);

        const flat = organic.map((v) => ({ ...v, creator: cand.name }));
        const verdicts = await screen(flat);
        const keep = flat
          .filter((v) => verdicts.get(String(v.id))?.keep)
          .sort((a, b) => String(b.postedAt ?? '').localeCompare(String(a.postedAt ?? '')))
          .slice(0, KEEP_PER_CREATOR);

        if (keep.length < MIN_ON_THESIS_VIDEOS) {
          console.log(`  ${cand.name}: ${keep.length} on-thesis video — not adding.`);
          await sleep(PAUSE_MS);
          continue;
        }

        /* The editorial fields the hand pass wrote. A new card without them
         * would render an empty angle and no product chips. */
        const profile = await claudeJson({
          system: `You describe a real estate education creator for an internal reference page.

Reply with JSON only:
{"angle":"<one sentence, max 40 words, on what this person teaches and how their content is distinctive>",
 "productLines":["<from: ${PRODUCT_LINES.join(', ')}>"],
 "audience":"borrower"|"investor"|"agent",
 "onThesis":true|false}

productLines: only values from that list, only ones the videos actually evidence, at most three.
onThesis: false if this person is not primarily a residential real estate investing educator.`,
          user: `Creator: ${cand.name}\nFollowers: ${cand._followers.label ?? cand._followers.count}\n\nRecent on-thesis videos:\n${keep.map((v) => `- ${v.hook}`).join('\n')}`,
          maxTokens: 1024,
        });

        if (profile.onThesis === false) {
          console.log(`  ${cand.name}: judged off-thesis on profile — not adding.`);
          await sleep(PAUSE_MS);
          continue;
        }

        const lines = (profile.productLines ?? []).filter((l) => PRODUCT_LINES.includes(l)).slice(0, 3);
        const handle = cand._followers.handle;
        added.push({
          slug: slugify(cand.name),
          spyglassId: String(cand.id),
          name: cand.name,
          handle: handle ? `@${handle}` : null,
          avatarUrl: cand.logoUrl ?? cand.thumbnailUrl ?? null,
          platform: PLATFORM_LABELS[cand._followers.platform] ?? 'Instagram',
          profileUrl: handle
            ? (cand._followers.platform === 'TIKTOK'
              ? `https://tiktok.com/@${handle}`
              : `https://instagram.com/${handle}`)
            : null,
          followers: cand._followers.label,
          angle: profile.angle ?? '',
          productLines: lines.length ? lines : ['dscr'],
          audience: profile.audience ?? 'investor',
          addedBy: 'auto',
          addedOn: new Date().toISOString().slice(0, 10),
          videos: keep.map(({ title, creator, ...v }) => v),
        });
        console.log(`  + added ${cand.name} (${keep.length} clips)`);
      } catch (err) {
        console.log(`  ${cand.name}: candidate check failed — ${err.message}`);
      }
      await sleep(PAUSE_MS);
    }
  } catch (err) {
    console.log(`\n  discovery skipped — ${err.message}`);
    console.log('  the roster still refreshed; only growth is affected.');
  }
}

/* --- 5. write --- */

const creators = [...updated, ...added];
const totalVideos = creators.reduce((n, c) => n + (c.videos?.length ?? 0), 0);

if (!totalVideos) {
  console.error('No videos on any card. Not writing.');
  process.exit(1);
}

await mkdir(join(ROOT, 'data'), { recursive: true });
await writeFile(DATA, `${JSON.stringify({
  fetchedAt: new Date().toISOString(),
  note: 'Refreshed daily by .github/workflows/daily-creator-pull.yml. Videos are organic posts from the Spyglass corpus, screened for residential real estate relevance before publishing.',
  creators,
  failures,
}, null, 2)}\n`);

console.log(`\n${creators.length} creators, ${totalVideos} videos${added.length ? `, ${added.length} newly added` : ''}`);
if (failures.length) console.log(`${failures.length} creators failed:`, failures);
