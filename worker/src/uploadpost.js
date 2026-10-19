/* ---------------------------------------------------------------------------
 * /social/* — connecting The Buy Box's accounts through Upload-Post, and the
 * publishing half the scheduler calls.
 *
 * Upload-Post runs apps that Meta, Google and TikTok have already approved, so
 * a post goes out public without this tool passing YouTube's audit or
 * TikTok's. The tool holds one Upload-Post API key (UPLOAD_POST_API_KEY) and
 * one profile in it; the four social accounts hang off that profile.
 *
 * Nobody shares a password. Connect asks Upload-Post for a single-use link to
 * its connection page, and whoever opens it signs in on Google's, TikTok's and
 * Facebook's own pages. The tokens stay with Upload-Post; this tool only ever
 * holds the API key, which lives in the Worker and never reaches a browser.
 * ------------------------------------------------------------------------ */

import { rpc } from './db.js';

const API = 'https://api.upload-post.com/api';
export const SOCIAL = ['instagram', 'facebook', 'youtube', 'tiktok'];

/* The profile inside Upload-Post that The Buy Box's accounts belong to. */
const profileName = (env) => env.UPLOAD_POST_PROFILE || 'thebuybox';

const json = (obj, status, headers) => new Response(JSON.stringify(obj), {
  status, headers: { ...headers, 'content-type': 'application/json' },
});

/* Forgiving of how the key was pasted: a stray space or newline, or the
 * "Apikey " prefix copied along with it from Upload-Post's examples. */
const apiKey = (env) => String(env.UPLOAD_POST_API_KEY || '').trim().replace(/^apikey\s+/i, '');

export const uploadPostReady = (env) => Boolean(env.UPLOAD_POST_API_KEY);

async function call(env, path, { method = 'GET', body, form } = {}) {
  const init = {
    method,
    headers: { authorization: `Apikey ${apiKey(env)}` },
    signal: AbortSignal.timeout(60000),
  };
  if (form) init.body = form;
  else if (body) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, init);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.success !== false, status: res.status, data };
}

const why = (got, fallback) => String(got.data?.message || got.data?.error || `${fallback} (${got.status})`);

/* The profile, made the first time it is asked for. */
async function profile(env) {
  const name = encodeURIComponent(profileName(env));
  let got = await call(env, `/uploadposts/users/${name}`);
  if (got.status === 404) {
    const made = await call(env, '/uploadposts/users', { method: 'POST', body: { username: profileName(env) } });
    if (!made.ok && made.status !== 409) throw new Error(why(made, 'Upload-Post would not make the profile'));
    got = await call(env, `/uploadposts/users/${name}`);
  }
  if (!got.ok) throw new Error(why(got, 'Upload-Post would not say what is connected'));
  return got.data.profile || {};
}

/* Which Facebook Page to post to: the one chosen here, or the only one. */
async function facebookPages(env) {
  const got = await call(env, `/uploadposts/facebook/pages?profile=${encodeURIComponent(profileName(env))}`);
  return got.ok ? (got.data.pages || []).map((p) => ({ page_id: String(p.page_id), page_name: p.page_name || '' })) : [];
}

async function facebookPageId(env, pages) {
  const chosen = await rpc(env, 'kb_social_get', { p_key: 'facebook_page_id' }).catch(() => null);
  const list = pages || await facebookPages(env);
  if (chosen && list.some((p) => p.page_id === chosen)) return chosen;
  return list.length === 1 ? list[0].page_id : null;
}

/* --- publishing ------------------------------------------------------------ */

const str = (v, max) => String(v ?? '').trim().slice(0, max);

/* A YouTube title has to exist and stop at 100. The post's own title if it
 * has one, else the caption's first line. */
const youtubeTitle = (post) => str(post.title || String(post.caption || '').split('\n')[0] || 'The Buy Box', 100);

/* Hand Upload-Post the video. async_upload means it answers at once with a
 * request id and fetches the file itself; the status call says how it went. */
async function send(env, post) {
  if (post.kind !== 'reel') throw new Error('only videos go out through Upload-Post so far');
  const media = Array.isArray(post.media) ? post.media : [];
  if (!media.length) throw new Error('there is nothing to post');

  const caption = str(post.caption, 2200);
  const form = new FormData();
  form.append('user', profileName(env));
  form.append('platform[]', post.platform);
  form.append('video', media[0].url);
  form.append('async_upload', 'true');
  form.append('external_id', post.id);

  if (post.platform === 'youtube') {
    form.append('title', youtubeTitle(post));
    form.append('youtube_description', caption);
    form.append('privacyStatus', 'public');
  } else {
    form.append('title', caption);
  }
  if (post.platform === 'facebook') {
    const page = await facebookPageId(env);
    if (!page) throw new Error('choose which Facebook Page to post to on the Schedule page');
    form.append('facebook_page_id', page);
    form.append('facebook_description', caption);
  }

  const got = await call(env, '/upload', { method: 'POST', form });
  if (!got.ok) throw new Error(why(got, 'Upload-Post refused the post'));

  /* A short video can come back finished rather than queued. */
  if (got.data.results) return { done: resultFor(got.data.results, post.platform) };
  const id = got.data.request_id || got.data.job_id;
  if (!id) throw new Error('Upload-Post did not say how to follow the post');
  return { requestId: String(id) };
}

/* results is an object keyed by platform from /upload, an array from /status. */
function resultFor(results, platform) {
  const r = Array.isArray(results) ? results.find((x) => x.platform === platform) : results?.[platform];
  if (!r) return null;
  const link = r.url || r.post_url || r.platform_post_url || null;
  if (r.skipped) return { ok: false, error: `${platform} isn’t connected in Upload-Post` };
  if (r.success === false || r.status === 'failed' || r.error) {
    return { ok: false, error: String(r.error_message || r.error || r.message || `${platform} refused it`) };
  }
  if (r.success === true || r.status === 'completed') {
    return { ok: true, url: link, id: String(r.post_id || r.video_id || r.platform_post_id || '') || null };
  }
  return null;
}

async function status(env, requestId) {
  const got = await call(env, `/uploadposts/status?request_id=${encodeURIComponent(requestId)}`);
  if (!got.ok) throw new Error(why(got, 'Upload-Post would not say how the post is going'));
  return got.data;
}

/* One post, as far as it will go: sent once, then followed until Upload-Post
 * says it is up or that it failed. The request id is kept as the container,
 * so the next run picks up the following rather than sending it again. */
export async function advanceUploadPost(env, post, say, waits) {
  let requestId = post.container_id;
  if (!requestId) {
    const sent = await send(env, post);
    if (sent.done) {
      if (!sent.done.ok) throw new Error(sent.done.error);
      await say('posted', { mediaId: sent.done.id, permalink: sent.done.url });
      return 'posted';
    }
    requestId = sent.requestId;
    await say('working', { container: requestId });
  }

  for (let i = 0; i < waits.tries; i += 1) {
    const s = await status(env, requestId);
    const r = resultFor(s.results, post.platform);
    if (r?.ok) {
      await say('posted', { mediaId: r.id, permalink: r.url });
      return 'posted';
    }
    if (r && !r.ok) throw new Error(r.error);
    if (s.status === 'failed') throw new Error(String(s.message || 'Upload-Post could not post it'));
    if (s.status === 'not_found') throw new Error('Upload-Post has no record of that post');
    await new Promise((done) => setTimeout(done, waits.gap));
  }

  await say('working', { container: requestId });
  return 'waiting';
}

/* --- the routes ----------------------------------------------------------- */

export async function handleSocial(path, request, env, headers, ctx, user) {
  if (!uploadPostReady(env)) {
    if (path === '/social/account') return json({ ready: false }, 200, headers);
    return json({
      error: 'Upload-Post isn’t set up yet: the Worker needs its API key.',
      hint: 'From the worker folder: npx wrangler secret put UPLOAD_POST_API_KEY',
    }, 503, headers);
  }

  if (path === '/social/account') {
    try {
      const p = await profile(env);
      const accounts = {};
      for (const name of SOCIAL) {
        const a = p.social_accounts?.[name];
        accounts[name] = a && typeof a === 'object'
          ? { handle: a.handle || a.username || '', name: a.display_name || '', reconnect: Boolean(a.reauth_required) }
          : (a ? { handle: '', name: String(a), reconnect: false } : null);
      }
      let pages = [];
      let pageId = null;
      if (accounts.facebook) {
        pages = await facebookPages(env);
        pageId = await facebookPageId(env, pages);
      }
      return json({ ready: true, accounts, facebook_pages: pages, facebook_page_id: pageId }, 200, headers);
    } catch (err) {
      console.error('social: reading the profile failed:', err?.message);
      return json({ error: 'Couldn’t reach Upload-Post to check the accounts. Try again.' }, 502, headers);
    }
  }

  /* A fresh link to Upload-Post's connection page, good for 48 hours, that
   * brings whoever used it back to the Schedule page. */
  if (path === '/social/connect') {
    const origin = request.headers.get('origin');
    try {
      await profile(env);
      const got = await call(env, '/uploadposts/users/generate-jwt', {
        method: 'POST',
        body: {
          username: profileName(env),
          platforms: SOCIAL,
          redirect_url: origin ? `${origin}/schedule.html` : undefined,
          redirect_button_text: 'Back to the Schedule page',
          connect_title: 'Connect The Buy Box',
          connect_description: 'Sign in to each account on its own page. Posts are scheduled from the marketing tool.',
          show_calendar: false,
          language: 'en',
        },
      });
      if (!got.ok || !got.data.access_url) throw new Error(why(got, 'Upload-Post would not make a link'));
      return json({ url: got.data.access_url }, 200, headers);
    } catch (err) {
      console.error('social: making the connect link failed:', err?.message);
      return json({ error: `Couldn’t start connecting: ${err?.message || 'try again.'}` }, 502, headers);
    }
  }

  if (path === '/social/facebook-page') {
    let body = null;
    try { body = await request.json(); } catch { body = null; }
    const id = String(body?.page_id || '').trim().slice(0, 64);
    if (!/^\d+$/.test(id)) return json({ error: 'page_id must be a Page id' }, 400, headers);
    try {
      const pages = await facebookPages(env);
      if (!pages.some((p) => p.page_id === id)) return json({ error: 'that Page isn’t one of the connected ones' }, 404, headers);
      await rpc(env, 'kb_social_set', { p_key: 'facebook_page_id', p_value: id });
      return json({ picked: id }, 200, headers);
    } catch {
      return json({ error: 'could not choose that Page' }, 502, headers);
    }
  }

  return json({ error: 'unknown social route' }, 404, headers);
}
