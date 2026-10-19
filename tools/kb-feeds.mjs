/* ---------------------------------------------------------------------------
 * Feeds: blogs, newsletters and release pages that keep publishing.
 *
 * kb/sources.json fetches one page once. A feed in kb/feeds.json is read on
 * every run and its newest posts are fetched as articles, so the library keeps
 * up with a source rather than holding a snapshot of it.
 *
 * Bounded twice per feed — posts newer than max_age_days, and at most max_items
 * of them — so a feed with 250 posts in it (BiggerPockets) costs the same as
 * one with ten. A post already in the library comes back "unchanged" by its
 * content hash and is not re-chunked or re-embedded.
 *
 * Each post is read from its own page, the same way a URL in sources.json is.
 * When that fails — a page that renders in JavaScript, or one that turns bots
 * away — the full text many feeds carry in content:encoded is used instead.
 * ------------------------------------------------------------------------ */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { decode, htmlToText, isoOrNull, fetchArticle } from './kb-web.mjs';

const UA = 'Mozilla/5.0 (compatible; AikoKnowledgeBot/1.0)';
const TIMEOUT_MS = 20000;
const DEFAULT_MAX_ITEMS = 5;
const DEFAULT_MAX_AGE_DAYS = 30;

export async function readFeedSources(root) {
  let list;
  try {
    list = JSON.parse(await readFile(join(root, 'kb', 'feeds.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e && typeof e.feed === 'string' && !e.disabled);
}

/* Feeds wrap values in CDATA freely — the Fed puts its links in it. */
const unwrap = (s) => decode(String(s ?? '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim());

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? unwrap(m[1]) : null;
};

/* RSS puts the link in <link>…</link>; Atom in <link rel="alternate" href>. */
function itemLink(xml) {
  const rss = tag(xml, 'link');
  if (rss && /^https?:\/\//.test(rss)) return rss;
  return (
    xml.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)/i)?.[1] ||
    xml.match(/<link(?![^>]*rel=["'](?:self|replies|edit)["'])[^>]*href=["']([^"']+)/i)?.[1] ||
    null
  );
}

export function parseFeed(xml) {
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  return blocks
    .map((b) => ({
      url: itemLink(b),
      title: tag(b, 'title'),
      published_at: isoOrNull(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'dc:date') || tag(b, 'updated')),
      html: tag(b, 'content:encoded') || tag(b, 'content') || null,
    }))
    .filter((i) => i.url);
}

/* The newest posts inside the age window. A post with no date is kept only if
 * the feed gives no dates at all, since then there is nothing to window on. */
export function pickItems(items, entry, now = Date.now()) {
  const maxItems = entry.max_items || DEFAULT_MAX_ITEMS;
  const cutoff = now - (entry.max_age_days || DEFAULT_MAX_AGE_DAYS) * 86400000;
  const dated = items.some((i) => i.published_at);
  return items
    .filter((i) => (dated ? i.published_at && Date.parse(i.published_at) >= cutoff : true))
    .sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''))
    .slice(0, maxItems);
}

export async function fetchFeed(entry) {
  const res = await fetch(entry.feed, {
    headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const items = parseFeed(await res.text());
  if (!items.length) throw new Error('no posts found — not an RSS or Atom feed?');
  return items;
}

/* One post as a document: its page first, the feed's own copy as the fallback. */
export async function fetchFeedItem(entry, item) {
  const base = {
    url: item.url,
    title: item.title || undefined,
    published_at: item.published_at || undefined,
    document_type: entry.document_type || 'article',
    source: entry.source || entry.name,
    topics: entry.topics,
  };

  let doc;
  try {
    doc = await fetchArticle(base);
  } catch (err) {
    const text = item.html ? htmlToText(item.html) : '';
    if (text.length < 200) throw err;
    doc = {
      document_type: base.document_type,
      title: item.title || item.url,
      source: base.source || new URL(item.url).hostname.replace(/^www\./, ''),
      source_url: item.url,
      published_at: item.published_at,
      source_key: `url:${item.url}`,
      raw_content: text,
      metadata: { ...(entry.topics ? { topics: entry.topics } : {}), body_from: 'feed' },
    };
  }

  doc.metadata = { ...doc.metadata, ingest_route: 'feed', feed: entry.name || entry.feed };
  return doc;
}
