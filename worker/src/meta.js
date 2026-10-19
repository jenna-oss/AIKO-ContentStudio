/* ---------------------------------------------------------------------------
 * /meta/* — connecting the Facebook Page, and the Instagram account linked to
 * it, that the app publishes to.
 *
 * This is Facebook Login, not Instagram Login. The Buy Box's accounts live in
 * a Meta Business Portfolio with admins rather than a shared password, so the
 * person who connects signs in as themselves on Facebook's own page and picks
 * the Page. One approval covers both: the Page posts with its own token, and
 * the Instagram account is reached through the Page it is linked to. Nothing
 * in this app ever sees a password.
 *
 * Our sign-in is a bearer token in a header, and an OAuth redirect is a browser
 * navigation that cannot carry one. So a signed-in page asks for a ticket
 * first; that ticket travels to Facebook as `state` and comes back on the
 * callback, which is the only route here that is not behind the gate. A
 * callback without a ticket we issued, unused and minutes old, is refused.
 *
 * A Page token taken from a long-lived user token does not expire, so unlike
 * Instagram Login there is nothing to renew. It stops working only if the
 * person who connected loses the Page or takes the permission back, and then
 * the post says so and someone connects again.
 *
 * Tokens are encrypted before they are stored. This Supabase project is shared
 * with other AIKO tools, so anything holding its anon key can call the
 * function that returns the row — what that returns is ciphertext, and the key
 * is META_TOKEN_KEY, which lives only here.
 * ------------------------------------------------------------------------ */

import { rpc } from './db.js';

export const GRAPH = 'https://graph.facebook.com/v25.0';
const AUTHORIZE = 'https://www.facebook.com/v25.0/dialog/oauth';

/* List the Pages, post to them, and publish to the Instagram accounts linked
 * to them. business_management is what lets a Page owned by a Business
 * Portfolio, rather than by a person, show up in the list at all. Used only
 * when no Login for Business configuration is set; with one, the
 * configuration holds the permissions instead. */
const SCOPES = [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_posts',
  'instagram_basic', 'instagram_content_publish', 'business_management',
].join(',');

const json = (obj, status, headers) => new Response(JSON.stringify(obj), {
  status, headers: { ...headers, 'content-type': 'application/json' },
});

const ready = (env) => Boolean(env.META_APP_ID && env.META_APP_SECRET && env.META_TOKEN_KEY);

/* --- the key ------------------------------------------------------------- */

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(env) {
  if (!env.META_TOKEN_KEY) throw new Error('no META_TOKEN_KEY is set');
  const raw = unb64(env.META_TOKEN_KEY);
  if (raw.length !== 32) throw new Error('META_TOKEN_KEY must be 32 bytes, base64');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), new TextEncoder().encode(text));
  return { cipher: b64(out), iv: b64(iv) };
}

async function open(env, cipher, iv) {
  const out = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(iv) }, await key(env), unb64(cipher),
  );
  return new TextDecoder().decode(out);
}

/* --- talking to Facebook --------------------------------------------------- */

const callbackUrl = (request) => `${new URL(request.url).origin}/meta/callback`;

async function getJson(url, what) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const got = await res.json().catch(() => ({}));
  if (!res.ok || got.error) throw new Error(got.error?.message || `Facebook ${what} (${res.status})`);
  return got;
}

/* The code becomes an hour's user token, the hour's token becomes a 60-day
 * one, and Page tokens asked for with the 60-day one never run out. */
async function userToken(env, code, redirectUri) {
  const short = await getJson(`${GRAPH}/oauth/access_token?${new URLSearchParams({
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    redirect_uri: redirectUri,
    code,
  })}`, 'refused the code');
  if (!short.access_token) throw new Error('Facebook sent no token back');

  const long = await getJson(`${GRAPH}/oauth/access_token?${new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    fb_exchange_token: short.access_token,
  })}`, 'would not extend the token');
  if (!long.access_token) throw new Error('Facebook would not extend the token');
  return long.access_token;
}

/* Every Page the person approved, with its token and its Instagram account
 * if one is linked. Follows the paging, which a portfolio with many Pages
 * needs. */
async function pagesFor(token) {
  const pages = [];
  let url = `${GRAPH}/me/accounts?${new URLSearchParams({
    fields: 'id,name,access_token,instagram_business_account{id,username}',
    limit: '100',
    access_token: token,
  })}`;
  for (let i = 0; url && i < 10; i += 1) {
    const got = await getJson(url, 'would not list the Pages');
    for (const p of got.data || []) {
      if (!p.id || !p.access_token) continue;
      pages.push({
        page_id: String(p.id),
        page_name: String(p.name || ''),
        ig_user_id: p.instagram_business_account?.id ? String(p.instagram_business_account.id) : '',
        ig_username: String(p.instagram_business_account?.username || ''),
        token: p.access_token,
      });
    }
    url = got.paging?.next || null;
  }
  return pages;
}

/* The Page to publish as: its id, its Instagram account's id if it has one,
 * and its token, decrypted. Used by the scheduler, not by any page. */
export async function pageAccount(env) {
  const row = await rpc(env, 'kb_meta_secret', {});
  if (!row?.cipher) return null;
  return {
    token: await open(env, row.cipher, row.iv),
    pageId: row.page_id,
    pageName: row.page_name || '',
    igUserId: row.ig_user_id || null,
  };
}

/* --- the routes ----------------------------------------------------------- */

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (title, body) => new Response(
  `<!doctype html><meta charset="utf-8"><title>${title}</title>`
  + '<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#ECE9D8;color:#3B5850;'
  + 'display:grid;place-items:center;height:100vh;margin:0;text-align:center}'
  + 'div{max-width:28rem;padding:2rem}h1{color:#103224;font-size:1.25rem;margin:0 0 .5rem}'
  + 'a{color:#2C785E}</style>'
  + `<div><h1>${title}</h1>${body}</div>`,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
);

/* The callback, which arrives as a navigation from Facebook with no session.
 * index.js routes it before the gate; the ticket is what stands in for one. */
export async function handleMetaCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') || '';
  const denied = url.searchParams.get('error_description') || url.searchParams.get('error');

  if (denied) return page('Not connected', `<p>Facebook said: ${escape(denied)}</p><p>Close this and try again from the Schedule page.</p>`);
  if (!code) return page('Not connected', '<p>Facebook sent us back without a code.</p>');

  let who = null;
  try { who = await rpc(env, 'kb_ig_ticket_take', { p_ticket: state }); } catch { who = null; }
  if (!who) {
    return page('Not connected', '<p>That connection link had expired, or had already been used. Start again from the Schedule page.</p>');
  }

  try {
    const token = await userToken(env, code, callbackUrl(request));
    const pages = await pagesFor(token);
    if (!pages.length) {
      return page('Not connected', '<p>Facebook didn’t share any Pages. Try again, and when it asks, choose the Page '
        + '(and its Instagram account) to give access to. You need to be able to post on that Page in the Business Portfolio.</p>');
    }
    const sealed = [];
    for (const p of pages) {
      const s = await seal(env, p.token);
      sealed.push({ page_id: p.page_id, page_name: p.page_name, ig_user_id: p.ig_user_id, ig_username: p.ig_username, ...s });
    }
    await rpc(env, 'kb_meta_save', { p_pages: sealed, p_email: who });

    const what = pages.length === 1
      ? `${escape(pages[0].page_name || 'The Page')}${pages[0].ig_username ? ' and @' + escape(pages[0].ig_username) : ''} ${pages[0].ig_username ? 'are' : 'is'} connected.`
      : `${pages.length} Pages came through. Go back to the Schedule page and choose which one to post to.`;
    return page('Connected', `<p>${what} You can close this tab.</p>`);
  } catch (err) {
    console.error('meta: connecting failed:', err?.message);
    return page('Not connected', `<p>${escape(err?.message || 'Something went wrong.')}</p><p>Nothing was saved. Try again from the Schedule page.</p>`);
  }
}

export async function handleMeta(path, request, env, headers, ctx, user) {
  if (path === '/meta/account') {
    try {
      const pages = (await rpc(env, 'kb_meta_account', {})) || [];
      const chosen = pages.find((p) => p.selected) || null;
      return json({
        connected: Boolean(chosen),
        page: chosen,
        pages,
        ready: ready(env),
      }, 200, headers);
    } catch {
      return json({ error: 'could not read the connection' }, 502, headers);
    }
  }

  if (path === '/meta/start') {
    if (!env.META_APP_ID || !env.META_APP_SECRET) {
      return json({
        error: 'Facebook isn’t set up yet: the Worker needs the Meta app’s id and secret.',
        hint: 'From the worker folder: npx wrangler secret put META_APP_SECRET',
      }, 503, headers);
    }
    if (!env.META_TOKEN_KEY) {
      return json({
        error: 'Facebook isn’t set up yet: the Worker needs a key to encrypt the tokens with.',
        hint: 'npx wrangler secret put META_TOKEN_KEY — 32 random bytes, base64',
      }, 503, headers);
    }

    let ticket;
    try { ticket = await rpc(env, 'kb_ig_ticket_new', { p_email: user?.email || null }); }
    catch { return json({ error: 'could not start that. Try again.' }, 502, headers); }

    const params = {
      client_id: env.META_APP_ID,
      redirect_uri: callbackUrl(request),
      response_type: 'code',
      state: ticket,
    };
    /* Login for Business wants its configuration rather than a scope list. */
    if (env.META_LOGIN_CONFIG_ID) params.config_id = env.META_LOGIN_CONFIG_ID;
    else params.scope = SCOPES;
    return json({ url: `${AUTHORIZE}?${new URLSearchParams(params)}` }, 200, headers);
  }

  if (path === '/meta/pick') {
    let body = null;
    try { body = await request.json(); } catch { body = null; }
    const id = String(body?.page_id || '').trim().slice(0, 64);
    if (!/^\d+$/.test(id)) return json({ error: 'page_id must be a Page id' }, 400, headers);
    try {
      const ok = await rpc(env, 'kb_meta_pick', { p_page_id: id });
      if (!ok) return json({ error: 'that Page isn’t one of the connected ones' }, 404, headers);
      return json({ picked: id }, 200, headers);
    } catch {
      return json({ error: 'could not choose that Page' }, 502, headers);
    }
  }

  if (path === '/meta/disconnect') {
    try {
      await rpc(env, 'kb_meta_forget', {});
      return json({ connected: false }, 200, headers);
    } catch {
      return json({ error: 'could not disconnect' }, 502, headers);
    }
  }

  return json({ error: 'unknown meta route' }, 404, headers);
}
