/* ---------------------------------------------------------------------------
 * /posts/* — what is scheduled, and the thing that sends it.
 *
 * A post goes to one platform; scheduling the same video to several makes
 * one row each, so each keeps its own progress, link and error.
 *
 * With UPLOAD_POST_API_KEY set, every platform goes through Upload-Post
 * (uploadpost.js): one request, then following it until it is up. Without
 * it, Instagram and Facebook go straight to Meta, as below — kept as the
 * fallback, and it is what the rest of this comment describes.
 *
 * Neither holds a post for us, so the waiting happens here. A cron trigger
 * wakes the Worker every five minutes, claims whatever is due, and moves it
 * along. Publishing a video is never one call on either side:
 *
 *   Instagram  1. create a container from a public media URL
 *              2. Instagram processes it — seconds for an image, minutes for
 *                 a video
 *              3. publish the container
 *
 *   Facebook   1. open a reel upload and hand it the public URL
 *              2. Facebook fetches and processes it
 *              3. finish the upload as published
 *
 * So a post is a small state machine that any run can pick up where the last
 * one left off. A run waits about a minute for processing; past that it leaves
 * the container (or video) id on the row and the next run carries on. Nothing
 * is ever published twice: kb_post_claim hands a post to one run only.
 *
 * The media has to be somewhere Meta can fetch it. The videos bucket is
 * public, which is what makes this possible at all.
 * ------------------------------------------------------------------------ */

import { rpc } from './db.js';
import { GRAPH, pageAccount } from './meta.js';
import { SOCIAL, advanceUploadPost, uploadPostReady } from './uploadpost.js';

const RUPLOAD = 'https://rupload.facebook.com/video-upload/v25.0';

/* How long one run will sit watching a container finish before leaving it for
 * the next run. Images are ready almost at once; a reel can take minutes. */
const WAIT_TRIES = 10;
const WAIT_MS = 6000;

/* After this many runs have failed on the same post, stop and say so rather
 * than retrying forever. */
const MAX_ATTEMPTS = 5;

const MAX_CAPTION = 2200;
const KINDS = new Set(['reel', 'image', 'carousel']);
const PLATFORMS = new Set(SOCIAL);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (obj, status, headers) => new Response(JSON.stringify(obj), {
  status, headers: { ...headers, 'content-type': 'application/json' },
});

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

/* --- talking to the Graph API --------------------------------------------- */

async function graph(path, params, token, method = 'POST') {
  const url = `${GRAPH}${path}`;
  const search = new URLSearchParams({ ...params, access_token: token });
  const res = method === 'GET'
    ? await fetch(`${url}?${search}`, { signal: AbortSignal.timeout(30000) })
    : await fetch(url, { method: 'POST', body: search, signal: AbortSignal.timeout(60000) });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const why = data.error?.error_user_msg || data.error?.message || `Meta answered ${res.status}`;
    throw new Error(why);
  }
  return data;
}

/* The wait is tunable so the tests can exercise a container that never
 * finishes without sitting here for a minute. */
const waits = (env) => ({
  tries: Number(env.POST_WAIT_TRIES) || WAIT_TRIES,
  gap: Number(env.POST_WAIT_MS) || WAIT_MS,
});

function reporter(env, post) {
  return (status, fields) => rpc(env, 'kb_post_state', {
    p_id: post.id, p_status: status,
    p_container: fields?.container ?? null,
    p_children: fields?.children ?? null,
    p_media_id: fields?.mediaId ?? null,
    p_permalink: fields?.permalink ?? null,
    p_error: fields?.error ?? null,
  });
}

/* --- Instagram ------------------------------------------------------------ */

/* One container, for whichever of the three shapes this post is. A carousel
 * is its children built first, then a container that holds them. */
async function makeContainer(post, igUserId, token) {
  const caption = str(post.caption, MAX_CAPTION);
  const media = Array.isArray(post.media) ? post.media : [];
  if (!media.length) throw new Error('there is nothing to post');

  if (post.kind === 'reel') {
    const made = await graph(`/${igUserId}/media`, {
      media_type: 'REELS', video_url: media[0].url, caption,
    }, token);
    return { container: made.id, children: [] };
  }

  if (post.kind === 'image') {
    const made = await graph(`/${igUserId}/media`, { image_url: media[0].url, caption }, token);
    return { container: made.id, children: [] };
  }

  /* Carousel: between two and ten, each its own container first. */
  if (media.length < 2 || media.length > 10) {
    throw new Error('a carousel is between 2 and 10 things');
  }
  const children = [];
  for (const item of media) {
    const child = item.kind === 'video'
      ? await graph(`/${igUserId}/media`, { media_type: 'VIDEO', video_url: item.url, is_carousel_item: 'true' }, token)
      : await graph(`/${igUserId}/media`, { image_url: item.url, is_carousel_item: 'true' }, token);
    children.push(child.id);
  }
  const made = await graph(`/${igUserId}/media`, {
    media_type: 'CAROUSEL', children: children.join(','), caption,
  }, token);
  return { container: made.id, children };
}

/* FINISHED means publishable. IN_PROGRESS means come back. Anything else is
 * over. */
async function containerState(container, token) {
  const got = await graph(`/${container}`, { fields: 'status_code,status' }, token, 'GET');
  return { code: got.status_code || '', detail: got.status || '' };
}

async function advanceInstagram(env, post, account) {
  const say = reporter(env, post);
  const { igUserId, token } = account;
  if (!igUserId) throw new Error('the connected Facebook Page has no Instagram account linked to it');

  let container = post.container_id;
  if (!container) {
    const made = await makeContainer(post, igUserId, token);
    container = made.container;
    await say('working', { container, children: made.children });
  }

  const { tries, gap } = waits(env);
  for (let i = 0; i < tries; i += 1) {
    const state = await containerState(container, token);
    if (state.code === 'FINISHED') {
      const published = await graph(`/${igUserId}/media_publish`, { creation_id: container }, token);
      let permalink = null;
      try {
        const where = await graph(`/${published.id}`, { fields: 'permalink' }, token, 'GET');
        permalink = where.permalink || null;
      } catch { /* posted either way; the link is a nicety */ }
      await say('posted', { mediaId: published.id, permalink });
      return 'posted';
    }
    if (state.code === 'ERROR' || state.code === 'EXPIRED') {
      throw new Error(state.detail || `Instagram could not process it (${state.code})`);
    }
    if (state.code === 'PUBLISHED') {
      /* Someone or something already published this container. */
      await say('posted', {});
      return 'posted';
    }
    await sleep(gap);
  }

  /* Still processing. The container is saved, so the next run resumes. */
  await say('working', { container });
  return 'waiting';
}

/* --- Facebook ------------------------------------------------------------- */

const fbLink = (link) => (!link ? null : /^https?:/i.test(link) ? link : `https://www.facebook.com${link}`);
const done = (phase) => phase?.status === 'complete' || phase?.status === 'completed';

/* A reel: open an upload, point Facebook at the file, and once it has
 * fetched and processed it, finish the upload as published. The video id is
 * the container, so a later run picks up at the waiting. */
async function advanceFacebookReel(env, post, account, say) {
  const { pageId, token } = account;
  const media = Array.isArray(post.media) ? post.media : [];
  if (!media.length) throw new Error('there is nothing to post');

  let videoId = post.container_id;
  if (!videoId) {
    const opened = await graph(`/${pageId}/video_reels`, { upload_phase: 'start' }, token);
    if (!opened.video_id) throw new Error('Facebook did not open an upload');
    videoId = String(opened.video_id);

    const res = await fetch(`${RUPLOAD}/${videoId}`, {
      method: 'POST',
      headers: { authorization: `OAuth ${token}`, file_url: media[0].url },
      signal: AbortSignal.timeout(60000),
    });
    const got = await res.json().catch(() => ({}));
    if (!res.ok || got.error || got.success === false) {
      throw new Error(got.error?.message || got.debug_info?.message || `Facebook would not take the video (${res.status})`);
    }
    await say('working', { container: videoId });
  }

  const { tries, gap } = waits(env);
  for (let i = 0; i < tries; i += 1) {
    const got = await graph(`/${videoId}`, { fields: 'status' }, token, 'GET');
    const s = got.status || {};
    if (s.video_status === 'error' || s.uploading_phase?.status === 'error' || s.processing_phase?.status === 'error') {
      const why = s.processing_phase?.errors?.[0]?.message || s.uploading_phase?.errors?.[0]?.message;
      throw new Error(why || 'Facebook could not process the video');
    }
    /* Already finished by an earlier run whose answer never got saved. */
    if (done(s.publishing_phase) || s.video_status === 'published') {
      await say('posted', { mediaId: videoId });
      return 'posted';
    }
    if (done(s.uploading_phase) && (s.video_status === 'ready' || done(s.processing_phase))) {
      await graph(`/${pageId}/video_reels`, {
        upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED',
        description: str(post.caption, MAX_CAPTION),
      }, token);
      let permalink = null;
      try {
        const where = await graph(`/${videoId}`, { fields: 'permalink_url' }, token, 'GET');
        permalink = fbLink(where.permalink_url);
      } catch { /* posted either way */ }
      await say('posted', { mediaId: videoId, permalink });
      return 'posted';
    }
    await sleep(gap);
  }

  await say('working', { container: videoId });
  return 'waiting';
}

/* A photo is one call. Several photos are each uploaded unpublished, then one
 * feed post holds them; a Page post of several things cannot include video. */
async function advanceFacebook(env, post, account) {
  const say = reporter(env, post);
  if (post.kind === 'reel') return advanceFacebookReel(env, post, account, say);

  const { pageId, token } = account;
  const media = Array.isArray(post.media) ? post.media : [];
  if (!media.length) throw new Error('there is nothing to post');
  const message = str(post.caption, MAX_CAPTION);

  let postId;
  if (post.kind === 'image') {
    const made = await graph(`/${pageId}/photos`, { url: media[0].url, message }, token);
    postId = made.post_id || made.id;
  } else {
    if (media.some((m) => m.kind === 'video')) throw new Error('a Facebook post of several things can only hold photos');
    const params = { message };
    for (let i = 0; i < media.length; i += 1) {
      const photo = await graph(`/${pageId}/photos`, { url: media[i].url, published: 'false' }, token);
      params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: photo.id });
    }
    postId = (await graph(`/${pageId}/feed`, params, token)).id;
  }

  let permalink = null;
  try {
    const where = await graph(`/${postId}`, { fields: 'permalink_url' }, token, 'GET');
    permalink = fbLink(where.permalink_url);
  } catch { /* posted either way */ }
  await say('posted', { mediaId: postId, permalink });
  return 'posted';
}

/* --- one post, as far as it will go --------------------------------------- */

function advance(env, post, account) {
  if (uploadPostReady(env)) return advanceUploadPost(env, post, reporter(env, post), waits(env));
  if (!account) throw new Error('no Facebook Page is connected');
  if (post.platform === 'facebook') return advanceFacebook(env, post, account);
  if (post.platform === 'instagram') return advanceInstagram(env, post, account);
  throw new Error(`${post.platform} posts need Upload-Post, and its key isn’t set`);
}

/* Everything due, one at a time. Called by the cron, and by hand from the
 * page when someone wants it to go now. */
export async function publishDue(env, limit = 5) {
  const done = [];
  /* The direct Meta connection is only the fallback for when Upload-Post
   * isn't set up, so only look for it then. */
  const account = uploadPostReady(env) ? null : await pageAccount(env);
  if (!uploadPostReady(env) && !account) return { done, error: 'no Facebook Page is connected' };

  for (let i = 0; i < limit; i += 1) {
    let post;
    try { post = await rpc(env, 'kb_post_claim', {}); }
    catch { break; }
    if (!post) break;

    try {
      const outcome = await advance(env, post, account);
      done.push({ id: post.id, outcome });
    } catch (err) {
      const message = String(err?.message || err).slice(0, 400);
      console.error('posting failed:', post.id, message);
      /* Give up only after it has had its chances. The nulls leave what was
       * saved alone (kb_post_state coalesces), so a post already handed to
       * Upload-Post or Meta resumes from its container, never sends twice. */
      const spent = Number(post.attempts || 0) >= MAX_ATTEMPTS;
      await rpc(env, 'kb_post_state', {
        p_id: post.id, p_status: spent ? 'failed' : 'scheduled',
        p_container: null, p_children: null, p_media_id: null, p_permalink: null,
        p_error: message,
      }).catch(() => {});
      done.push({ id: post.id, outcome: spent ? 'failed' : 'will try again' });
    }
  }
  return { done };
}

/* --- the routes ----------------------------------------------------------- */

export async function handlePosts(path, request, env, headers, ctx, user) {
  if (path === '/posts/list') {
    try {
      const rows = await rpc(env, 'kb_posts', { p_limit: 100 });
      return json({ posts: rows || [] }, 200, headers);
    } catch {
      return json({ error: 'could not load what is scheduled' }, 502, headers);
    }
  }

  const body = await readBody(request);
  if (!body) return json({ error: 'body must be JSON' }, 400, headers);

  if (path === '/posts/create') {
    const kind = str(body.kind, 16);
    if (!KINDS.has(kind)) return json({ error: 'a post is a reel, an image or a carousel' }, 400, headers);

    const media = (Array.isArray(body.media) ? body.media : [])
      .map((m) => ({ url: str(m?.url, 1000), kind: m?.kind === 'video' ? 'video' : 'image' }))
      .filter((m) => /^https:\/\//i.test(m.url))
      .slice(0, 10);
    if (!media.length) return json({ error: 'a post needs something to post, at a https address' }, 400, headers);
    if (kind === 'carousel' && media.length < 2) {
      return json({ error: 'a carousel needs at least two' }, 400, headers);
    }
    if (kind === 'reel') media[0].kind = 'video';

    const when = new Date(body.scheduled_for);
    if (Number.isNaN(when.getTime())) return json({ error: 'a post needs a time' }, 400, headers);
    /* A minute's grace, so "now" typed a moment ago is not in the past. */
    if (when.getTime() < Date.now() - 60000) {
      return json({ error: 'that time has already gone by' }, 400, headers);
    }

    /* One row per platform. Left out, it means Instagram, which is all this
     * route used to do. */
    const asked = Array.isArray(body.platforms) ? body.platforms : [body.platform || 'instagram'];
    const platforms = [...new Set(asked.map((p) => str(p, 16)))];
    if (!platforms.length || !platforms.every((p) => PLATFORMS.has(p))) {
      return json({ error: 'a post goes to Instagram, Facebook, YouTube or TikTok' }, 400, headers);
    }
    if (platforms.includes('facebook') && kind === 'carousel' && media.some((m) => m.kind === 'video')) {
      return json({ error: 'a Facebook post of several things can only hold photos' }, 400, headers);
    }

    try {
      const ids = [];
      for (const platform of platforms) {
        ids.push(await rpc(env, 'kb_post_create', {
          p_kind: kind,
          p_media: media,
          p_caption: str(body.caption, MAX_CAPTION),
          p_when: when.toISOString(),
          p_render_id: UUID.test(String(body.render_id || '')) ? body.render_id : null,
          p_email: user?.email || null,
          p_platform: platform,
          p_title: str(body.title, 100) || null,
        }));
      }
      return json({ id: ids[0], ids, status: 'scheduled', scheduled_for: when.toISOString() }, 200, headers);
    } catch (err) {
      console.error('scheduling failed:', err?.message);
      return json({ error: 'Couldn’t schedule that. Try again.' }, 502, headers);
    }
  }

  const id = str(body.id, 64);
  if (!UUID.test(id)) return json({ error: 'id must be a post id' }, 400, headers);

  if (path === '/posts/read') {
    try {
      const post = await rpc(env, 'kb_post_read', { p_id: id });
      if (!post) return json({ error: 'no post with that id' }, 404, headers);
      return json({ post }, 200, headers);
    } catch {
      return json({ error: 'could not load that post' }, 502, headers);
    }
  }

  if (path === '/posts/edit') {
    const when = body.scheduled_for ? new Date(body.scheduled_for) : null;
    if (when && Number.isNaN(when.getTime())) return json({ error: 'that is not a time' }, 400, headers);
    try {
      const ok = await rpc(env, 'kb_post_edit', {
        p_id: id,
        p_caption: body.caption === undefined ? null : str(body.caption, MAX_CAPTION),
        p_when: when ? when.toISOString() : null,
      });
      if (!ok) return json({ error: 'that one has already gone out, or is going out now' }, 409, headers);
      return json({ saved: true }, 200, headers);
    } catch {
      return json({ error: 'could not change that post' }, 502, headers);
    }
  }

  if (path === '/posts/cancel') {
    try {
      const ok = await rpc(env, 'kb_post_cancel', { p_id: id });
      if (!ok) return json({ error: 'that one has already gone out, or is going out now' }, 409, headers);
      return json({ cancelled: true }, 200, headers);
    } catch {
      return json({ error: 'could not cancel that post' }, 502, headers);
    }
  }

  /* Send it now rather than waiting for its time. The work happens after the
   * answer, the way everything slow here does. */
  if (path === '/posts/now') {
    try {
      const ok = await rpc(env, 'kb_post_edit', { p_id: id, p_caption: null, p_when: new Date().toISOString() });
      if (!ok) return json({ error: 'that one has already gone out, or is going out now' }, 409, headers);
    } catch {
      return json({ error: 'could not send that post' }, 502, headers);
    }
    ctx.waitUntil(publishDue(env, 1).catch(() => {}));
    return json({ sending: true }, 202, headers);
  }

  return json({ error: 'unknown posts route' }, 404, headers);
}
