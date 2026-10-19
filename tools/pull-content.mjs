/* ---------------------------------------------------------------------------
 * Harvest Trilith's own written content — blog posts, funded-deal writeups,
 * product pages, FAQ — into data/content.json.
 *
 * The site is server-rendered, so a plain fetch is enough; no browser needed.
 * Metadata comes from the JSON-LD block where the page has one, because that is
 * the publisher's own statement of title, date and author rather than our guess
 * at which heading was the title.
 *
 * The Spanish mirror under /es is skipped: it is a translation of the same
 * posts, and loading it would double every retrieval result with a duplicate.
 * ------------------------------------------------------------------------ */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITEMAP = 'https://trilithfunding.com/sitemap.xml';
const UA = 'Mozilla/5.0 (compatible; TrilithContentBot/1.0; +https://trilithfunding.com)';
const PAUSE_MS = 400;

/* Chunk sizes are tuned for retrieval, not for reading. A chunk should be big
 * enough to answer a question on its own and small enough that returning three
 * of them is still cheaper than returning the article. */
const MAX_CHUNK = 1400;
const MIN_CHUNK = 450;
const OVERLAP = 160;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Carry the tail of the previous chunk into the next one so a sentence sitting
 * on the seam is retrievable from both sides. Snap to a sentence boundary, or
 * failing that a word boundary — an overlap starting mid-word reads as garbage
 * and matches nothing. */
function overlapTail(s) {
  const tail = s.slice(-OVERLAP);
  const sentence = tail.match(/[.!?]\s+([\s\S]*)$/);
  return (sentence ? sentence[1] : tail.replace(/^\S*\s+/, '')).trim();
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…', middot: '·',
};

function decode(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/* Keep the heading structure. Retrieval is much better when a chunk can say
 * which section of the article it came from, and headings are how these posts
 * signal their arguments. */
function htmlToText(html) {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(nav|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) =>
        `\n\n${'#'.repeat(Number(lvl))} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`)
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) =>
        `\n- ${inner.replace(/<[^>]+>/g, '').trim()}`)
      .replace(/<\/(p|div|tr|section|blockquote)>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* The publisher's own metadata beats anything we could infer. Several pages
 * carry more than one JSON-LD block (Organization, Breadcrumb, Article); take
 * the one that actually describes an article. */
function fromJsonLd(html) {
  const out = {};
  const blocks = [...html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )];
  for (const [, body] of blocks) {
    let parsed;
    try { parsed = JSON.parse(decode(body.trim())); } catch { continue; }
    for (const node of [parsed, ...(parsed['@graph'] || [])].flat()) {
      if (!node || typeof node !== 'object') continue;
      const type = [node['@type']].flat().join(' ');
      if (!/Article|BlogPosting|WebPage/i.test(type)) continue;
      out.title ||= node.headline || node.name;
      out.summary ||= node.description;
      out.published ||= node.datePublished;
      out.updated ||= node.dateModified;
      /* author is sometimes a plain string, sometimes a Person/Organization
       * node, and sometimes an @id reference carrying no name at all. Only
       * take a real name — stringifying the rest yields '[object Object]'. */
      out.author ||= [node.author].flat()
        .map((a) => (typeof a === 'string' ? a : a?.name))
        .filter((a) => typeof a === 'string' && a.trim())
        .join(', ') || null;
    }
  }
  return out;
}

function classify(url) {
  const p = new URL(url).pathname;
  if (p.startsWith('/blog/')) return 'blog';
  if (p.startsWith('/just-funded/')) return 'case-study';
  if (p.startsWith('/products/')) return 'product';
  if (p === '/faq') return 'faq';
  return 'page';
}

/* Headings mark where an argument turns, so they are the right seam — but
 * splitting on every one of them yields fragments like a lone "Apply" button.
 * So: split on headings, hard-split anything oversized on paragraph boundaries
 * with a little overlap, then pack neighbours back together until each chunk is
 * substantial enough to answer a question on its own. */
function chunk(text) {
  const sections = [];
  let heading = null;
  let buf = [];

  const flush = () => {
    const body = buf.join('\n').trim();
    if (body || heading) sections.push({ heading, body });
    buf = [];
  };

  for (const line of text.split('\n')) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { flush(); heading = h[1].trim(); continue; }
    buf.push(line);
  }
  flush();

  /* The heading rides inside the chunk text. A chunk retrieved on its own
   * should read as prose that says what it is about. */
  const pieces = [];
  for (const s of sections) {
    const full = [s.heading, s.body].filter(Boolean).join('\n');
    if (full.length <= MAX_CHUNK) {
      if (full.trim()) pieces.push({ heading: s.heading, text: full });
      continue;
    }
    const paras = s.body.split(/\n{2,}/);
    let cur = s.heading ? `${s.heading}\n` : '';
    for (const p of paras) {
      if (cur.trim() && cur.length + p.length + 2 > MAX_CHUNK) {
        pieces.push({ heading: s.heading, text: cur.trim() });
        cur = `${overlapTail(cur)}\n\n${p}`;
      } else {
        cur = cur ? `${cur}\n\n${p}` : p;
      }
    }
    if (cur.trim()) pieces.push({ heading: s.heading, text: cur.trim() });
  }

  const packed = [];
  for (const p of pieces) {
    const last = packed[packed.length - 1];
    if (last && last.text.length < MIN_CHUNK && last.text.length + p.text.length + 2 <= MAX_CHUNK) {
      last.text = `${last.text}\n\n${p.text}`;
      last.heading ||= p.heading;
    } else {
      packed.push({ ...p });
    }
  }

  /* Whatever is still tiny after packing is navigation debris, not content. */
  return packed.filter((p) => p.text.length >= 80);
}

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

/* --- run ---------------------------------------------------------------- */

const sitemap = await get(SITEMAP);

const entries = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
  url: decode(m[1].match(/<loc>([^<]+)<\/loc>/)?.[1] || '').trim(),
  lastmod: m[1].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]?.trim() || null,
}));

/* Every static page shares one lastmod: the site build stamp. That is not a
 * publication date and must not be presented as one. The dated content —
 * posts, funded deals — carries its own distinct value, so treat the single
 * most common timestamp as the build stamp and ignore it. */
const tally = {};
for (const e of entries) if (e.lastmod) tally[e.lastmod] = (tally[e.lastmod] || 0) + 1;
const buildStamp = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
const IGNORE_LASTMOD = buildStamp && buildStamp[1] > 2 ? buildStamp[0] : null;

const lastmodFor = new Map(
  entries
    .filter((e) => e.lastmod && e.lastmod !== IGNORE_LASTMOD)
    .map((e) => [e.url, e.lastmod.slice(0, 10)])
);

const urls = entries
  .map((e) => e.url)
  .filter(Boolean)
  .filter((u) => !/\/es(\/|$)/.test(u))
  .filter((u) => !/\/privacy$/.test(u));

console.log(`${urls.length} English URLs in the sitemap`);
if (IGNORE_LASTMOD) console.log(`Ignoring build stamp ${IGNORE_LASTMOD} on ${buildStamp[1]} pages`);

const docs = [];
const failures = [];

for (const url of urls) {
  try {
    const html = await get(url);
    const meta = fromJsonLd(html);

    /* Prefer the article body. Falling back to <main> keeps product and FAQ
     * pages in, which are not articles but are still the brand's own words. */
    const scope =
      html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
      html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
      html;

    const text = htmlToText(scope);
    const title = meta.title
      || decode(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, '') || '').trim()
      || url;

    if (text.length < 200) {
      failures.push({ url, why: `only ${text.length} chars of text` });
      continue;
    }

    const pieces = chunk(text);
    docs.push({
      url,
      kind: classify(url),
      title: title.trim(),
      summary: meta.summary?.trim() || null,
      author: meta.author || null,
      published: meta.published?.slice(0, 10) || lastmodFor.get(url) || null,
      /* Where the date came from, so nobody later mistakes a sitemap
       * timestamp for the publisher saying when it ran. */
      date_source: meta.published ? 'json-ld' : (lastmodFor.has(url) ? 'sitemap-lastmod' : null),
      updated: meta.updated?.slice(0, 10) || null,
      word_count: text.split(/\s+/).length,
      body: text,
      chunks: pieces.map((c, i) => ({ ordinal: i, heading: c.heading, text: c.text })),
    });

    console.log(`  ${classify(url).padEnd(10)} ${pieces.length.toString().padStart(2)} chunks  ${title.slice(0, 60)}`);
  } catch (err) {
    failures.push({ url, why: err.message });
    console.log(`  FAILED     ${url} — ${err.message}`);
  }
  await sleep(PAUSE_MS);
}

if (!docs.length) {
  console.error('Harvested nothing. Not writing.');
  process.exit(1);
}

await mkdir(join(ROOT, 'data'), { recursive: true });
await writeFile(
  join(ROOT, 'data', 'content.json'),
  JSON.stringify({
    site: 'trilithfunding.com',
    fetchedAt: new Date().toISOString(),
    docs,
    failures,
  }, null, 2)
);

const byKind = docs.reduce((m, d) => { m[d.kind] = (m[d.kind] || 0) + 1; return m; }, {});
const chunks = docs.reduce((n, d) => n + d.chunks.length, 0);

console.log(`\n${docs.length} documents · ${chunks} chunks · ${docs.reduce((n, d) => n + d.word_count, 0)} words`);
console.log('by kind:', byKind);
if (failures.length) console.log(`${failures.length} failed:`, failures);
