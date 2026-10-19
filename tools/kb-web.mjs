/* ---------------------------------------------------------------------------
 * Reading a web page: the HTML-to-text helpers, and the two fetchers that use
 * them — an article and a YouTube caption track.
 *
 * This file is deliberately free of Node builtins. The daily ingest imports it
 * through kb-lib/kb-sources, and the Worker imports it directly to read a link
 * pasted on the Plan page, and both have to behave identically: a link read on
 * demand and the same link read by the nightly run should produce the same
 * document, not two near-copies.
 * ------------------------------------------------------------------------ */

const UA = 'Mozilla/5.0 (compatible; TrilithKnowledgeBot/1.0; +https://trilithfunding.com)';

/* --- HTML to text -------------------------------------------------------- */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…', middot: '·',
};

export function decode(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

export function htmlToText(html) {
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

/* Prefer the article body; fall back to <main>, then the whole document. */
export function articleScope(html) {
  return (
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html
  );
}

export function metaFromHtml(html) {
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
      if (!/Article|BlogPosting|Report|WebPage/i.test(type)) continue;
      out.title ||= node.headline || node.name;
      out.summary ||= node.description;
      out.published ||= node.datePublished;
      out.publisher ||= typeof node.publisher === 'string' ? node.publisher : node.publisher?.name;
    }
  }
  out.title ||= decode(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1] || '') || null;
  out.title ||= decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim() || null;
  out.published ||=
    html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)/i)?.[1] || null;
  return out;
}

export function isoOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* --- articles ------------------------------------------------------------ */

const TIMEOUT_MS = 20000;
const timeout = (entry) => AbortSignal.timeout(entry.timeout_ms || TIMEOUT_MS);

export async function fetchArticle(entry) {
  const res = await fetch(entry.url, { headers: { 'user-agent': UA }, signal: timeout(entry) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const html = await res.text();
  const meta = metaFromHtml(html);
  const text = htmlToText(articleScope(html));

  if (text.length < 200) throw new Error('extracted body was under 200 characters — probably a JS-rendered page');

  return {
    document_type: entry.document_type || 'article',
    title: entry.title || meta.title || entry.url,
    source: entry.source || meta.publisher || new URL(entry.url).hostname.replace(/^www\./, ''),
    source_url: entry.url,
    published_at: isoOrNull(entry.published_at || meta.published),
    source_key: `url:${entry.url}`,
    raw_content: text,
    metadata: {
      ingest_route: 'url',
      ...(meta.summary ? { summary: meta.summary } : {}),
      ...(entry.topics ? { topics: entry.topics } : {}),
      ...(entry.research_type ? { research_type: entry.research_type } : {}),
    },
  };
}

/* --- YouTube ------------------------------------------------------------- */

export const videoId = (url) =>
  url.match(/[?&]v=([\w-]{11})/)?.[1] ||
  url.match(/youtu\.be\/([\w-]{11})/)?.[1] ||
  url.match(/\/shorts\/([\w-]{11})/)?.[1] ||
  null;

export const isYouTube = (url) => /(?:youtube\.com|youtu\.be)/i.test(url);

/* Captions are read off the watch page rather than through an API, because
 * there is no public captions API that does not require OAuth on the channel.
 * That makes this the most fragile fetcher here: YouTube changes the shape of
 * the watch page freely, and it challenges datacenter IPs the same way Meta
 * does. Failures are per-document and non-fatal for exactly that reason. */
export async function fetchYouTube(entry) {
  const id = videoId(entry.url);
  if (!id) throw new Error('could not read a video id out of the URL');

  const res = await fetch(`https://www.youtube.com/watch?v=${id}`, {
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
    signal: timeout(entry),
  });
  if (!res.ok) throw new Error(`watch page returned ${res.status}`);
  const html = await res.text();

  const raw = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\})\s*;\s*(?:var|<\/script>)/);
  if (!raw) throw new Error('no player response on the watch page (likely a bot challenge)');

  let player;
  try { player = JSON.parse(raw[1]); } catch { throw new Error('player response was not parseable JSON'); }

  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

  /* Prefer a human track over an automatic one, and English over anything else,
   * but take what exists rather than failing on a Spanish-only upload. */
  const track =
    tracks.find((t) => /^en/i.test(t.languageCode) && t.kind !== 'asr') ||
    tracks.find((t) => /^en/i.test(t.languageCode)) ||
    tracks[0] || null;

  /* The track URL is signed and, as of 2026, frequently answers 200 with an
   * empty body: YouTube gates captions behind a token the watch page mints in
   * its own JavaScript. Treat that as "no captions" rather than an error, and
   * let the caller decide whether the title, channel and description are worth
   * having on their own. */
  let cap = null;
  if (track) {
    try {
      const capRes = await fetch(`${track.baseUrl}&fmt=json3`, { headers: { 'user-agent': UA }, signal: timeout(entry) });
      const raw = capRes.ok ? await capRes.text() : '';
      cap = raw ? JSON.parse(raw) : null;
    } catch { cap = null; }
  }

  const lines = (cap?.events || [])
    .filter((e) => e.segs)
    .map((e) => {
      const text = e.segs.map((s) => s.utf8).join('').replace(/\s+/g, ' ').trim();
      if (!text) return null;
      const start = Math.round((e.tStartMs || 0) / 1000);
      const end = Math.round(((e.tStartMs || 0) + (e.dDurationMs || 0)) / 1000);
      return { start, end, text };
    })
    .filter(Boolean);

  const details = player.videoDetails || {};
  if (!lines.length && !entry.allow_description_only) {
    throw new Error(track
      ? 'YouTube would not serve this video’s captions'
      : 'this video has no caption tracks');
  }

  /* Re-emitted as WebVTT so it goes through exactly the same transcript parser
   * as a caption file dropped in the folder. One code path, one behaviour. */
  const hms = (s) =>
    `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000`;

  const vtt = ['WEBVTT', '', ...lines.flatMap((l) => [`${hms(l.start)} --> ${hms(l.end)}`, l.text, ''])].join('\n');

  const published =
    player.microformat?.playerMicroformatRenderer?.publishDate ||
    html.match(/"publishDate":"([^"]+)"/)?.[1] ||
    null;

  /* All that is left when the captions are withheld: enough for the planner to
   * know what the video is about, and not a substitute for what was said. */
  const summary = [
    decode(details.title || ''),
    details.author ? `Channel: ${decode(details.author)}` : '',
    '',
    decode(details.shortDescription || ''),
  ].join('\n').trim();

  return {
    document_type: entry.document_type || (lines.length ? 'transcript' : 'other'),
    title: entry.title || decode(details.title || `YouTube ${id}`),
    source: entry.source || decode(details.author || 'YouTube'),
    source_url: `https://www.youtube.com/watch?v=${id}`,
    published_at: isoOrNull(entry.published_at || published),
    source_key: `youtube:${id}`,
    raw_content: lines.length ? vtt : summary,
    metadata: {
      ingest_route: 'youtube',
      video_id: id,
      channel: decode(details.author || ''),
      duration_seconds: Number(details.lengthSeconds) || null,
      caption_kind: !lines.length ? 'none' : track.kind === 'asr' ? 'automatic' : 'human',
      ...(lines.length ? {} : { partial: true }),
      language: track?.languageCode || null,
      content_type: entry.content_type || 'video',
      ...(entry.topics ? { topics: entry.topics } : {}),
    },
  };
}
