/* ---------------------------------------------------------------------------
 * /links/* — an article or a YouTube URL pasted on the Plan page.
 *
 * The page spots a URL in the message box and sends it here. The Worker reads
 * the page, keeps the text on the link row, and ingests it as a document. So
 * the session that pasted it can have it read in full, and every later session
 * can find a passage in it by searching.
 *
 * Reading happens after the answer goes out (ctx.waitUntil), like a
 * recording's transcript: a slow site should not hold the box open. The row
 * says 'reading' until it lands and the page polls.
 *
 * Articles are read here, with the same fetchers the nightly ingest of
 * kb/sources.json uses — tools/kb-web.mjs — so a link read on demand and the
 * same link read at 14:00 produce the same document rather than two
 * near-copies.
 *
 * A video's words come from Supadata, because YouTube stopped serving caption
 * tracks to anything but its own player. Without that key a video still reads,
 * but only down to its title, channel and description, and it says so.
 *
 * Only a signed-in person on the app's list reaches any of this: index.js
 * gates every route.
 * ------------------------------------------------------------------------ */

import { rpc } from './db.js';
import { ingestText } from './upload.js';
import { fetchArticle, fetchYouTube, isYouTube, videoId } from '../../tools/kb-web.mjs';

/* Comfortably inside the chunk limit, and far more than any one article. */
const MAX_TEXT = 200000;
/* Under this an article is a paywall teaser or a cookie wall, not a read. */
const MIN_WORDS = 120;
/* A video with no captions is only its title, channel and description. */
const MIN_SUMMARY_WORDS = 25;

const SUPADATA_URL = 'https://api.supadata.ai/v1/transcript';
const SUPADATA_VIDEO_URL = 'https://api.supadata.ai/v1/youtube/video';
const OEMBED_URL = 'https://www.youtube.com/oembed';
/* Captions that already exist cost one credit. Having Supadata listen to a
 * video that has none costs two credits a minute, against a free tier of a
 * hundred a month — worth it for a short video, not for an hour-long one,
 * which would spend a third of the month in a single paste. */
const GENERATE_UNDER_MINUTES = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Nothing that points back inside somebody's network. Workers cannot route to
 * these anyway; refusing them here means the refusal is legible. */
const PRIVATE = /^(localhost|\[?::1\]?|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;
/* Query keys that say where a click came from, not which page it is. */
const TRACKERS = /^(utm_|fbclid|gclid|msclkid|mc_[ce]id|igshid|ref_src|si$|s$)/i;

const json = (obj, status, headers) => new Response(JSON.stringify(obj), {
  status, headers: { ...headers, 'content-type': 'application/json' },
});

const wordCount = (text) => (String(text).match(/\S+/g) || []).length;

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

/* One URL, one row: the canonical form is what a second paste is matched
 * against, so the same article arriving with different tracking tags is read
 * once. Exported for the tests. */
export function normalise(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text.length > 2000) return null;

  let u;
  try { u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;

  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || PRIVATE.test(host) || /\.(local|internal|localdomain)$/.test(host)) return null;

  if (isYouTube(u.href)) {
    const id = videoId(u.href);
    if (!id) return null;
    const watch = `https://www.youtube.com/watch?v=${id}`;
    return { url: watch, canonical: watch, kind: 'video', site: 'YouTube' };
  }

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKERS.test(key)) u.searchParams.delete(key);
  }
  u.hash = '';
  u.hostname = host.replace(/^www\./, '');
  const canonical = u.href.replace(/\/$/, '');
  return { url: canonical, canonical, kind: 'article', site: u.hostname };
}

/* --- Supadata ------------------------------------------------------------ */

async function askSupadata(env, params) {
  const res = await fetch(`${SUPADATA_URL}?${new URLSearchParams(params)}`, {
    headers: { 'x-api-key': env.SUPADATA_API_KEY },
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function askSupadataJob(env, jobId) {
  const res = await fetch(`${SUPADATA_URL}/${encodeURIComponent(jobId)}`, {
    headers: { 'x-api-key': env.SUPADATA_API_KEY },
    signal: AbortSignal.timeout(20000),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/* How long the video is, when the watch page would not say. One credit, and
 * only ever spent to answer the question "is this short enough to be worth
 * transcribing" — which is the question that protects the other 99. */
async function durationFrom(env, url) {
  try {
    const res = await fetch(`${SUPADATA_VIDEO_URL}?${new URLSearchParams({ url })}`, {
      headers: { 'x-api-key': env.SUPADATA_API_KEY },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return Number(data?.media?.duration) || null;
  } catch {
    return null;
  }
}

/* The words of a video, or a job id to come back for, or nothing. Never
 * throws: a video that cannot be transcribed still reads down to its
 * description, which is better than a chip that only says it failed. */
async function transcriptFor(env, url, seconds) {
  if (!env.SUPADATA_API_KEY) return {};
  const take = (out) => {
    if (out.status === 200 && out.data?.content) return { text: String(out.data.content), lang: out.data.lang };
    if (out.status === 202 && out.data?.jobId) return { jobId: String(out.data.jobId) };
    return null;
  };

  try {
    const native = take(await askSupadata(env, { url, text: 'true', mode: 'native' }));
    if (native) return native;

    /* Never guess at the length. Not knowing it once cost nothing here, but it
     * is the only thing standing between a three-hour upload and 360 credits. */
    const length = seconds || await durationFrom(env, url);
    if (!length) {
      return { why: 'it has no captions, and there was no way to tell how long it is before paying to have one made' };
    }
    const minutes = length / 60;
    if (minutes > GENERATE_UNDER_MINUTES) {
      return { why: `no captions, and at ${Math.round(minutes)} minutes it is too long to have one made` };
    }
    const made = take(await askSupadata(env, { url, text: 'true', mode: 'generate' }));
    if (made) return made;
    return { why: 'no transcript could be got for this one' };
  } catch (err) {
    console.error('supadata failed:', err?.message);
    return { why: 'the transcript service could not be reached' };
  }
}

/* --- storing what was read ------------------------------------------------ */

/* Into the corpus, then onto the row. One path, whether the text arrived on
 * the first read or a minute later when a job finished. */
async function store(env, link, { text, partial, documentType, sourceKey }) {
  let body = String(text || '').trim();
  if (body.length > MAX_TEXT) body = `${body.slice(0, MAX_TEXT)}\n\n[cut here: it went on longer than this]`;

  let documentId = null;
  try {
    const stored = await ingestText(env, null, {
      sourceKey,
      title: link.title,
      text: body,
      documentType,
      source: link.site,
      sourceUrl: link.url,
      publishedAt: link.published_at || null,
      metadata: { ingest_route: link.kind === 'video' ? 'youtube' : 'link', ...(partial ? { partial: true } : {}) },
    });
    documentId = stored.documentId;
  } catch (err) {
    console.error('link ingest failed:', err?.message);
  }

  await rpc(env, 'kb_link_ready', {
    p_id: link.id,
    p_title: link.title,
    p_site: link.site,
    p_author: link.author || null,
    p_published: link.published_at || null,
    p_words: wordCount(body),
    p_seconds: link.seconds ?? null,
    p_partial: partial,
    p_body: body,
    p_document_id: documentId,
  });
}

/* Read it and mark the row. Whatever goes wrong is written on the row, where
 * the chip shows it, rather than lost in a log. */
async function read(env, ctx, { id, url, kind }) {
  try {
    if (kind === 'video') return await readVideo(env, { id, url });

    const doc = await fetchArticle({ url });
    const text = String(doc.raw_content || '').trim();
    if (wordCount(text) < MIN_WORDS) {
      throw new Error('that page gave up almost no text — it is probably behind a paywall, or drawn by JavaScript');
    }
    await store(env, {
      id, url, kind, title: doc.title, site: doc.source,
      author: null, published_at: doc.published_at, seconds: null,
    }, { text, partial: false, documentType: doc.document_type, sourceKey: doc.source_key });
  } catch (err) {
    console.error('link read failed:', err?.message);
    try { await rpc(env, 'kb_link_failed', { p_id: id, p_error: String(err?.message || err) }); }
    catch { /* the chip stays on 'reading', and Try again can run it later */ }
  }
}

/* What the video is, as opposed to what was said in it. YouTube serves the
 * watch page to a Worker only some of the time — the first video read this way
 * came back titled "YouTube zVDW0RScEHc" — so oEmbed, which is public and has
 * never refused us, is the backstop for the name. */
async function videoMeta(url, fallbackId) {
  let page = null;
  try { page = await fetchYouTube({ url, allow_description_only: true }); }
  catch { page = null; }

  const named = page?.title && page.title !== `YouTube ${fallbackId}`;
  const meta = {
    title: named ? page.title : null,
    author: page?.metadata?.channel || null,
    seconds: page?.metadata?.duration_seconds ?? null,
    published: page?.published_at || null,
    summary: String(page?.raw_content || ''),
    sourceKey: page?.source_key || `youtube:${fallbackId}`,
  };
  if (meta.title) return meta;

  try {
    const res = await fetch(`${OEMBED_URL}?format=json&url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const o = await res.json().catch(() => ({}));
      meta.title = o.title || null;
      meta.author = meta.author || o.author_name || null;
    }
  } catch { /* the id will have to do */ }

  meta.title = meta.title || `YouTube ${fallbackId}`;
  return meta;
}

async function readVideo(env, { id, url }) {
  const meta = await videoMeta(url, videoId(url) || id);
  const link = {
    id, url, kind: 'video',
    title: meta.title,
    site: meta.author || 'YouTube',
    author: meta.author,
    published_at: meta.published,
    seconds: meta.seconds,
  };
  const summary = meta.summary;

  const got = await transcriptFor(env, url, link.seconds);

  if (got.text && wordCount(got.text) > MIN_SUMMARY_WORDS) {
    await store(env, link, {
      text: got.text, partial: false, documentType: 'transcript', sourceKey: meta.sourceKey,
    });
    return;
  }

  /* Being made rather than fetched: park the job and let the page's polling
   * collect it, with the description kept as what to fall back to. */
  if (got.jobId) {
    await rpc(env, 'kb_link_job', {
      p_id: id, p_job_id: got.jobId, p_title: link.title, p_site: link.site,
      p_seconds: link.seconds, p_published: link.published_at, p_body: summary,
    });
    return;
  }

  if (wordCount(summary) < MIN_SUMMARY_WORDS) {
    throw new Error(got.why || 'nothing came back but the title');
  }
  await store(env, link, {
    text: summary, partial: true, documentType: 'other', sourceKey: meta.sourceKey,
  });
}

/* A transcript being generated can take a few minutes, which is far longer
 * than a Worker should sit waiting. The page polls this route anyway, so each
 * poll asks after the job; the row is only finished once. */
async function collectJob(env, link) {
  let out;
  try { out = await askSupadataJob(env, link.job_id); }
  catch { return null; }
  if (out.status !== 200) return null;

  const { status, content } = out.data || {};
  if (status === 'queued' || status === 'active') return null;

  const done = status === 'completed' && content;
  await store(env, link, done
    ? { text: String(content), partial: false, documentType: 'transcript', sourceKey: `youtube:${videoId(link.url) || link.id}` }
    : { text: String(link.body || ''), partial: true, documentType: 'other', sourceKey: `youtube:${videoId(link.url) || link.id}` });

  try { return await rpc(env, 'kb_link_read', { p_id: link.id }); }
  catch { return null; }
}

export async function handleLinks(path, request, env, headers, ctx, user) {
  if (path === '/links') {
    const body = await readBody(request);
    const link = normalise(body?.url);
    if (!link) return json({ error: 'that does not look like a page I can read' }, 400, headers);

    let created;
    try {
      created = await rpc(env, 'kb_link_create', {
        p_url: link.url, p_canonical: link.canonical, p_kind: link.kind, p_email: user?.email || null,
      });
    } catch {
      return json({ error: 'Couldn’t save that link. Try again.' }, 502, headers);
    }

    /* Already read, recently and cleanly: hand back what we have. */
    if (created?.reused) {
      return json({ ...created, site: created.site || link.site, url: link.url }, 200, headers);
    }

    ctx.waitUntil(read(env, ctx, { id: created.id, url: link.url, kind: link.kind }));
    return json({ id: created.id, status: 'reading', kind: link.kind, site: link.site, url: link.url }, 202, headers);
  }

  if (path === '/links/list') {
    const body = await readBody(request);
    try {
      const rows = await rpc(env, 'kb_links', { p_limit: Number(body?.limit) || 50 });
      return json({ links: rows || [] }, 200, headers);
    } catch {
      return json({ error: 'could not load the links' }, 502, headers);
    }
  }

  const body = await readBody(request);
  const id = String(body?.id ?? '');
  if (!UUID.test(id)) return json({ error: 'id must be a link id' }, 400, headers);

  if (path === '/links/read') {
    /* Without the body: the page polls this every couple of seconds while a
     * page is being read, and an article can be 200,000 characters. All it
     * needs is the title and whether it has landed. */
    let link;
    try { link = await rpc(env, 'kb_link_status', { p_id: id }); }
    catch { return json({ error: 'could not load that link' }, 502, headers); }
    if (!link) return json({ error: 'no link with that id' }, 404, headers);

    if (link.status === 'reading' && link.job_id && env.SUPADATA_API_KEY) {
      /* Only here is the stored description needed, as what to fall back to
       * if the job failed. */
      let full = null;
      try { full = await rpc(env, 'kb_link_read', { p_id: id }); } catch { /* keep what we have */ }
      if (full) link = (await collectJob(env, full)) || link;
    }
    const { body: text, job_id: job, ...rest } = link;
    return json({ link: rest }, 200, headers);
  }

  if (path === '/links/retry') {
    let link;
    try { link = await rpc(env, 'kb_link_read', { p_id: id }); }   /* collectJob may need the fallback text */
    catch { return json({ error: 'could not load that link' }, 502, headers); }
    if (!link) return json({ error: 'no link with that id' }, 404, headers);
    if (link.status === 'ready') return json({ status: 'ready' }, 200, headers);

    /* A transcript already being made is worth waiting for rather than paying
     * to start again. */
    if (link.job_id && env.SUPADATA_API_KEY) {
      ctx.waitUntil(collectJob(env, link).catch(() => {}));
      return json({ status: 'reading' }, 202, headers);
    }

    ctx.waitUntil(read(env, ctx, { id, url: link.url, kind: link.kind }));
    return json({ status: 'reading' }, 202, headers);
  }

  return json({ error: 'unknown links route' }, 404, headers);
}
