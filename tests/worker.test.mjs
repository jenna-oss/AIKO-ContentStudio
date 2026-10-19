/* ---------------------------------------------------------------------------
 * The Worker's routes, with Supabase and Anthropic faked at the fetch layer.
 *
 *   npm test
 *
 * This file is in the repo on purpose. An earlier suite lived in a scratch
 * directory outside it and was deleted when that session ended, which left
 * every route uncovered and nobody any the wiser until the next change.
 *
 * It covers the sign-in gate on every route family, and the behaviour that is
 * easy to break by accident: the polled read that must not carry an article's
 * text, the lookups that must ask for the ids they want, the opening line a
 * script writer may not rewrite, and what happens to a file that is not audio.
 * It is not exhaustive. Add to it when you touch a route.
 * ------------------------------------------------------------------------ */

import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const worker = (await import(pathToFileURL(join(here, '..', 'worker', 'src', 'index.js')).href)).default;
const { pageAccount } = await import(pathToFileURL(join(here, '..', 'worker', 'src', 'meta.js')).href);
const { publishDue } = await import(pathToFileURL(join(here, '..', 'worker', 'src', 'posts.js')).href);

/* --- the fakes ----------------------------------------------------------- */

let calls = [];
let rpcAnswer = {};
let claudeReply = { type: 'text', text: 'Here are some ideas.' };
let supaJob = { status: 'active' };
let githubOk = true;
/* What the container reports, run by run, and how many have been made. */
let container = [];
let made = 0;
/* The Pages an approval covers, and what a Facebook reel reports, run by run. */
const PAGES = () => [{
  id: '555', name: 'The Buy Box', access_token: 'PAGE-SECRET',
  instagram_business_account: { id: '178414', username: 'thebuyboxre' },
}];
let fbPages = PAGES();
let reelStatus = [];
let photos = 0;
/* Upload-Post: the profile it reports, its Pages, how /upload answers, and
 * what the status call says, run by run. */
const PROFILE = () => ({
  username: 'thebuybox',
  social_accounts: {
    youtube: { handle: '@thebuyboxre', display_name: 'The Buy Box' },
    instagram: { username: 'thebuyboxre', display_name: 'The Buy Box' },
    facebook: { display_name: 'The Buy Box' },
    tiktok: null,
  },
});
let upProfile = PROFILE();
let upSend = null;
let upStatus = [];

/* Clerk: a real RS256 key, so the Worker's signature check runs for real. */
const { subtle } = globalThis.crypto;
const pair = await subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']);
const JWK = { ...(await subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = (buf) => Buffer.from(buf).toString('base64url');
async function mint(claims = {}, key = pair.privateKey, kid = 'k1') {
  const now = Math.floor(Date.now() / 1000);
  const body = { sub: 'user_1', azp: 'http://localhost:8788', iat: now, nbf: now - 1, exp: now + 60, ...claims };
  const unsigned = b64u(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })) + '.' + b64u(JSON.stringify(body));
  const sig = await subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return unsigned + '.' + b64u(sig);
}
const TOKEN = await mint();
const clerkUser = {
  id: 'user_1', primary_email_address_id: 'e2',
  email_addresses: [
    { id: 'e1', email_address: 'old@x.io', verification: { status: 'verified' } },
    { id: 'e2', email_address: 'Me@x.io', verification: { status: 'verified' } },
    { id: 'e3', email_address: 'typed@x.io', verification: { status: 'unverified' } },
  ],
};
let listed = ['me@x.io'];

const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

/* One content block, in the event sequence the SDK's stream reader expects. */
function sse(block) {
  const event = (type, data) => `event: ${type}
data: ${JSON.stringify({ type, ...data })}

`;
  const opening = block.type === 'tool_use'
    ? { type: 'tool_use', id: block.id, name: block.name, input: {} }
    : { type: 'text', text: '' };
  const delta = block.type === 'tool_use'
    ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
    : { type: 'text_delta', text: block.text };

  const body = [
    event('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }),
    event('content_block_start', { index: 0, content_block: opening }),
    event('content_block_delta', { index: 0, delta }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
    event('message_stop', {}),
  ].join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url instanceof Request ? url.url : url);
  let body = null;
  if (init.body && typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
  else if (init.body instanceof URLSearchParams) body = Object.fromEntries(init.body);
  else if (init.body instanceof FormData) body = Object.fromEntries(init.body);
  calls.push({ url: u, body, headers: init.headers });

  if (u.includes('api.anthropic.com')) {
    const block = claudeReply.type === 'tool_use'
      ? { type: 'tool_use', id: 'tu_1', name: body?.tool_choice?.name || 'report', input: claudeReply.input }
      : { type: 'text', text: claudeReply.text };

    /* The planner streams and everything else does not. Answering a streamed
     * request with plain JSON makes the SDK give up on an empty stream, which
     * looked like a route failure on an otherwise green run. */
    if (!body?.stream) {
      return jsonRes({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
        stop_reason: claudeReply.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [block],
      });
    }
    return sse(block);
  }
  if (u.startsWith('https://api.supadata.ai/v1/transcript/')) return jsonRes(supaJob);
  if (u.startsWith('https://graph.facebook.com/v25.0/oauth/access_token')) {
    return jsonRes({ access_token: u.includes('fb_exchange_token') ? 'LONG-USER' : 'SHORT-USER', token_type: 'bearer' });
  }
  if (u.startsWith('https://graph.facebook.com/v25.0/me/accounts')) return jsonRes({ data: fbPages });
  if (u.startsWith('https://rupload.facebook.com/video-upload/v25.0/')) return jsonRes({ success: true });
  if (u.includes('/media_publish')) return jsonRes({ id: 'MEDIA-1' });
  if (u.includes('/v25.0/') && u.includes('fields=permalink_url')) return jsonRes({ permalink_url: '/reel/123' });
  if (u.includes('/v25.0/') && u.includes('fields=permalink')) return jsonRes({ permalink: 'https://www.instagram.com/reel/xyz/' });
  if (u.includes('/v25.0/') && u.includes('status_code')) return jsonRes({ status_code: container.shift() || 'FINISHED' });
  if (u.includes('/v25.0/') && u.includes('fields=status')) return jsonRes({ status: reelStatus.shift() || {} });
  if (/\/v25\.0\/\d+\/media$/.test(u)) return jsonRes({ id: 'CONTAINER-' + (made += 1) });
  if (/\/v25\.0\/\d+\/video_reels$/.test(u)) {
    return jsonRes(body?.upload_phase === 'start' ? { video_id: 'VID-1', upload_url: 'https://rupload.facebook.com/video-upload/v25.0/VID-1' } : { success: true });
  }
  if (/\/v25\.0\/\d+\/photos$/.test(u)) {
    photos += 1;
    return jsonRes(body?.published === 'false' ? { id: 'PHOTO-' + photos } : { id: 'PHOTO-' + photos, post_id: 'PAGE_POST-1' });
  }
  if (/\/v25\.0\/\d+\/feed$/.test(u)) return jsonRes({ id: 'FEED-1' });
  if (u.startsWith('https://api.upload-post.com/api/')) {
    const path = new URL(u).pathname.replace('/api', '');
    if (path === '/uploadposts/users/thebuybox') {
      return upProfile ? jsonRes({ success: true, profile: upProfile }) : jsonRes({ success: false, message: 'not found' }, 404);
    }
    if (path === '/uploadposts/users' && init.method === 'POST') { upProfile = PROFILE(); return jsonRes({ success: true }, 201); }
    if (path === '/uploadposts/users/generate-jwt') return jsonRes({ success: true, access_url: 'https://app.upload-post.com/connect?token=JWT', duration: '48h' });
    if (path === '/uploadposts/facebook/pages') {
      return jsonRes({ success: true, pages: [{ page_id: '555', page_name: 'The Buy Box' }, { page_id: '666', page_name: 'Trilith Funding' }] });
    }
    if (path === '/upload') return upSend ? jsonRes(upSend.body, upSend.status) : jsonRes({ success: true, request_id: 'REQ-1' });
    if (path === '/uploadposts/status') return jsonRes(upStatus.shift() || { status: 'processing', results: [] });
  }
  if (u.includes('/actions/workflows/')) {
    /* 204 must carry no body at all, or the Response constructor throws. */
    return githubOk ? new Response(null, { status: 204 }) : new Response('no', { status: 403 });
  }
  if (u.includes('/storage/v1/object/upload/sign/')) {
    return jsonRes({ url: '/object/upload/sign/kb-footage/abc.mp4?token=SIGNED-TOKEN-123' });
  }
  if (u === 'https://api.clerk.com/v1/jwks') return jsonRes({ keys: [JWK] });
  if (u.startsWith('https://api.clerk.com/v1/users/')) return jsonRes(clerkUser);
  const fn = (u.match(/\/rpc\/([a-z_]+)/) || [])[1];
  if (fn === 'kb_app_user_allowed') return jsonRes(listed.includes(JSON.parse(init.body).p_email));
  return jsonRes(fn in rpcAnswer ? rpcAnswer[fn] : null);
};

const env = {
  SUPABASE_URL: 'https://db.supabase.co', SUPABASE_ANON_KEY: 'anon',
  ANTHROPIC_API_KEY: 'sk-test', CLERK_SECRET_KEY: 'sk_test_clerk', GITHUB_TOKEN: 'tok', VOYAGE_API_KEY: '',
};
/* The token key is 32 bytes, base64, as the real one must be. */
const metaEnv = {
  ...env,
  META_APP_ID: '1234567890',
  META_APP_SECRET: 'app-secret',
  META_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const get = (path, e = metaEnv) => worker.fetch(new Request('https://w.example' + path, {
  method: 'GET', headers: { origin: 'http://localhost:8788' },
}), e, ctx);
let pending = [];
const ctx = { waitUntil(p) { pending.push(p); } };
const settle = async () => { const all = pending; pending = []; await Promise.allSettled(all); };

const post = (path, payload, token = TOKEN, e = env) => worker.fetch(new Request('https://w.example' + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost:8788', ...(token ? { authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(payload || {}),
}), e, ctx);

/* --- the harness --------------------------------------------------------- */

let failures = 0;
const check = (name, ok, extra) => {
  if (!ok) failures++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (!ok && extra !== undefined ? '  [' + String(extra).slice(0, 300) + ']' : ''));
};
const reset = () => {
  calls = []; rpcAnswer = {}; pending = [];
  listed = ['me@x.io'];
  claudeReply = { type: 'text', text: 'Here are some ideas.' };
  supaJob = { status: 'active' };
  githubOk = true;
  container = [];
  made = 0;
  fbPages = PAGES();
  reelStatus = [];
  photos = 0;
  upProfile = PROFILE();
  upSend = null;
  upStatus = [];
};
/* Exactly this function: '/rpc/kb_links' is a prefix of '/rpc/kb_links_by_ids',
 * and matching loosely made the new call look like the old one. */
const rpcs = (fn) => calls.filter((c) => new URL(c.url).pathname.endsWith('/rpc/' + fn));
const LINK = '99999999-9999-4999-8999-999999999999';
const REC = '77777777-7777-7777-7777-777777777777';

/* --- the gate ------------------------------------------------------------ */

for (const path of ['/ideas', '/videos', '/links', '/links/read', '/recordings/list', '/scripts/list', '/scripts/write', '/kb/upload', '/meta/account', '/meta/start', '/meta/pick', '/social/account', '/social/connect', '/footage/list', '/footage/start']) {
  reset();
  const res = await post(path, {}, '');
  check(`${path} without a session -> 401`, res.status === 401, res.status);
}

let res, j;
/* Each test below signs as a different Clerk user, so the Worker's per-user
 * cache doesn't carry one answer into the next. */
reset();
res = await post('/scripts/list', {});
check('a Clerk session on the list gets in', res.status === 200, res.status);

const other = (await subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign'])).privateKey;
for (const [name, tok] of [
  ['signed by another key', await mint({ sub: 'user_2' }, other)],
  ['an unknown key id', await mint({ sub: 'user_3' }, pair.privateKey, 'k9')],
  ['expired', await mint({ sub: 'user_4', exp: Math.floor(Date.now() / 1000) - 60 })],
  ['made for another site', await mint({ sub: 'user_5', azp: 'https://evil.example' })],
  ['not a token', 'signed-in'],
]) {
  reset();
  res = await post('/scripts/list', {}, tok);
  check(`a token ${name} -> 401`, res.status === 401, res.status);
}

reset();
listed = ['someone@else.io'];
res = await post('/scripts/list', {}, await mint({ sub: 'user_6' }));
j = await res.json();
check('a Clerk user not on the list -> 403 and back to sign in', res.status === 403 && j.signin === true, res.status);

reset();
listed = ['typed@x.io'];
res = await post('/scripts/list', {}, await mint({ sub: 'user_7' }));
check('an unverified address on the list does not count', res.status === 403, res.status);

reset();
listed = ['old@x.io'];
res = await post('/scripts/list', {}, await mint({ sub: 'user_8' }));
check('a verified address that is not the primary one counts', res.status === 200, res.status);

res = await post('/scripts/list', {}, await mint({ sub: 'user_9' }), { ...env, CLERK_SECRET_KEY: '' });
check('no Clerk secret -> 502, not an open door', res.status === 502, res.status);

/* --- the polled read must not carry the article -------------------------- */

reset();
rpcAnswer.kb_link_status = { id: LINK, url: 'https://example.com/a', kind: 'article', status: 'ready', title: 'A long read', site: 'example.com', words: 40000, partial: false };
res = await post('/links/read', { id: LINK });
j = await res.json();
check('links/read asks for the row without the body',
  rpcs('kb_link_status').length === 1 && rpcs('kb_link_read').length === 0,
  `status:${rpcs('kb_link_status').length} full:${rpcs('kb_link_read').length}`);
check('...and never hands the page the text', res.status === 200 && j.link.title === 'A long read' && !('body' in j.link) && !('job_id' in j.link),
  JSON.stringify(j.link));

/* A transcript still being generated is the one case that needs the stored
 * description, as what to fall back to, so there the full row is fetched. */
reset();
rpcAnswer.kb_link_status = { id: LINK, url: 'https://www.youtube.com/watch?v=abc12345678', kind: 'video', status: 'reading', job_id: 'job-1' };
rpcAnswer.kb_link_read = { ...rpcAnswer.kb_link_status, body: 'the description' };
res = await post('/links/read', { id: LINK }, TOKEN, { ...env, SUPADATA_API_KEY: '' });
check('a job with no transcript key does not reach for the body', rpcs('kb_link_read').length === 0);

/* The other half of that: when the job has finished, the poll is what stores
 * the result, and it needs the full row to fall back to on a failure. This is
 * the path the light read above was threaded through, so it is checked both
 * ways round. */
const JOB_ROW = {
  id: LINK, url: 'https://www.youtube.com/watch?v=abc12345678', kind: 'video',
  status: 'reading', job_id: 'job-1', title: 'A video', site: 'The Buy Box',
};
const withSupa = { ...env, SUPADATA_API_KEY: 'sd-test' };

reset();
rpcAnswer.kb_link_status = JOB_ROW;
rpcAnswer.kb_link_read = { ...JOB_ROW, body: 'the description, kept as the fallback' };
rpcAnswer.kb_upload_document = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', changed: true };
supaJob = { status: 'completed', content: new Array(300).fill('spoken').join(' ') };
res = await post('/links/read', { id: LINK }, TOKEN, withSupa);
let stored = rpcs('kb_link_ready')[0]?.body;
check('a finished job is collected by the poll and stored as a transcript',
  stored?.p_partial === false && stored.p_words === 300
  && rpcs('kb_upload_document')[0]?.body?.payload?.document_type === 'transcript',
  JSON.stringify({ partial: stored?.p_partial, words: stored?.p_words }));

reset();
rpcAnswer.kb_link_status = JOB_ROW;
rpcAnswer.kb_link_read = { ...JOB_ROW, body: new Array(60).fill('described').join(' ') };
rpcAnswer.kb_upload_document = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', changed: true };
supaJob = { status: 'failed', error: 'could not process' };
res = await post('/links/read', { id: LINK }, TOKEN, withSupa);
stored = rpcs('kb_link_ready')[0]?.body;
check('a failed job falls back to the description it saved, flagged partial',
  stored?.p_partial === true && stored.p_words === 60,
  JSON.stringify({ partial: stored?.p_partial, words: stored?.p_words }));

reset();
res = await post('/links/read', { id: 'not-an-id' });
check('links/read with a bad id -> 400', res.status === 400);

/* --- looking up what a planning session picked ---------------------------- */

reset();
rpcAnswer.kb_recordings_by_ids = [{ id: REC, name: 'Call with Mike', status: 'ready', words: 120 }];
rpcAnswer.kb_links_by_ids = [{ id: LINK, title: 'A long read', site: 'example.com', status: 'ready', kind: 'article', partial: false }];
res = await post('/ideas', { brief: 'what should we make?', history: [], recordings: [REC], links: [LINK] });
await res.text();
await settle();
check('picked recordings are fetched by id, not by listing two hundred rows',
  rpcs('kb_recordings_by_ids').length === 1 && rpcs('kb_recordings')?.length === 0,
  `byIds:${rpcs('kb_recordings_by_ids').length} list:${rpcs('kb_recordings').length}`);
check('so are picked links',
  rpcs('kb_links_by_ids').length === 1 && rpcs('kb_links').length === 0,
  `byIds:${rpcs('kb_links_by_ids').length} list:${rpcs('kb_links').length}`);
check('both are named to the model in the message it answers',
  /Call with Mike/.test(JSON.stringify(calls.find((c) => c.url.includes('anthropic'))?.body || {}))
  && /A long read/.test(JSON.stringify(calls.find((c) => c.url.includes('anthropic'))?.body || {})));

/* --- a script is written to the plan's opening line ----------------------- */

reset();
rpcAnswer.kb_script_save = '44444444-4444-4444-8444-444444444444';
claudeReply = { type: 'tool_use', input: { lines: ['An opening I preferred.', 'The rent covers the note.', 'Follow for the next one.'] } };
res = await post('/scripts/write', {
  session_id: 'plan-abc', slot: 1, topic: 'Four rowhomes, one loan',
  opening_line: 'Four rowhomes in Baltimore. One loan.', product: 'dscr',
});
j = await res.json();
check('the opening line agreed in the plan is put back as line 1',
  res.status === 200 && j.lines[0] === 'Four rowhomes in Baltimore. One loan.', j.lines?.[0]);
check('the script is saved against the slot it came from',
  rpcs('kb_script_save')[0]?.body?.p_session === 'plan-abc' && rpcs('kb_script_save')[0].body.p_slot === 1);

reset();
res = await post('/scripts/write', { session_id: 'plan-abc', topic: 'No slot' });
check('a script with no slot -> 400, the model is not called',
  res.status === 400 && calls.filter((c) => c.url.includes('anthropic')).length === 0);

/* --- uploads that are not what they say ----------------------------------- */

reset();
const form = new FormData();
form.append('file', new File([new Uint8Array(new Array(5000).fill(7))], 'notes.pdf', { type: 'application/pdf' }));
form.append('name', 'A pdf');
res = await worker.fetch(new Request('https://w.example/recordings', {
  method: 'POST',
  headers: { origin: 'http://localhost:8788', authorization: 'Bearer ' + TOKEN },
  body: form,
}), { ...env, ELEVENLABS_API_KEY: 'el' }, ctx);
check('a recording that is not audio -> 415, nothing stored',
  res.status === 415 && calls.filter((c) => c.url.includes('/storage/')).length === 0, res.status);

/* --- the edges ----------------------------------------------------------- */

reset();
res = await post('/nonsense', {});
check('an unknown route -> 404', res.status === 404, res.status);

/* --- connecting Facebook and Instagram ------------------------------------- */

reset();
res = await post('/meta/start', {}, TOKEN, env);   // no keys set
j = await res.json();
check('connecting with no Meta keys -> 503 saying which to set',
  res.status === 503 && /META_APP_SECRET/.test(j.hint || ''), JSON.stringify(j));

reset();
rpcAnswer.kb_ig_ticket_new = '00000000-aaaa-4aaa-8aaa-000000000001';
res = await post('/meta/start', {}, TOKEN, metaEnv);
j = await res.json();
let authorize = new URL(j.url || 'https://x.invalid');
check('connecting hands back Facebook own page, not a form here',
  authorize.origin + authorize.pathname === 'https://www.facebook.com/v25.0/dialog/oauth', j.url);
check('...asking for the Page, posting to it, and its Instagram',
  ['pages_show_list', 'pages_manage_posts', 'instagram_content_publish', 'business_management']
    .every((s) => (authorize.searchParams.get('scope') || '').split(',').includes(s)),
  authorize.searchParams.get('scope'));
check('...with the one-time ticket as state, and our callback as the redirect',
  authorize.searchParams.get('state') === '00000000-aaaa-4aaa-8aaa-000000000001'
  && authorize.searchParams.get('redirect_uri') === 'https://w.example/meta/callback',
  authorize.search);

reset();
rpcAnswer.kb_ig_ticket_new = '00000000-aaaa-4aaa-8aaa-000000000001';
res = await post('/meta/start', {}, TOKEN, { ...metaEnv, META_LOGIN_CONFIG_ID: '42' });
authorize = new URL((await res.json()).url || 'https://x.invalid');
check('with a Login for Business configuration it sends that, not a scope list',
  authorize.searchParams.get('config_id') === '42' && !authorize.searchParams.has('scope'), authorize.search);

/* The callback is the one route with no session on it, so the ticket is the
 * whole of its security. */
reset();
rpcAnswer.kb_ig_ticket_take = null;
res = await get('/meta/callback?code=abc&state=00000000-aaaa-4aaa-8aaa-000000000009');
let html = await res.text();
check('a callback with a ticket we did not issue saves nothing',
  res.status === 200 && /expired, or had already been used/.test(html) && rpcs('kb_meta_save').length === 0,
  res.status);

reset();
res = await get('/meta/callback?error=access_denied&error_description=%3Cscript%3Ex%3C%2Fscript%3E');
html = await res.text();
check('what Facebook says on a refusal is shown as text, not run',
  !html.includes('<script>x') && html.includes('&#60;script&#62;'), html.slice(0, 200));

reset();
rpcAnswer.kb_ig_ticket_take = 'me@x.io';
res = await get('/meta/callback?code=abc&state=00000000-aaaa-4aaa-8aaa-000000000001');
html = await res.text();
const saved = rpcs('kb_meta_save')[0]?.body;
const one = saved?.p_pages?.[0];
check('a good callback connects the Page and its Instagram, and names them',
  /The Buy Box and @thebuyboxre are connected/.test(html)
  && saved.p_pages.length === 1 && one.page_id === '555' && one.ig_user_id === '178414'
  && one.ig_username === 'thebuyboxre' && saved.p_email === 'me@x.io',
  html.slice(0, 200));
check('the short-lived token is traded for a long-lived one before the Pages are asked for',
  calls.some((c) => c.url.includes('fb_exchange_token'))
  && calls.find((c) => c.url.includes('/me/accounts'))?.url.includes('access_token=LONG-USER'));
check('what is stored is ciphertext, not the Page token',
  typeof one.cipher === 'string' && one.cipher.length > 0
  && !JSON.stringify(saved).includes('PAGE-SECRET'),
  JSON.stringify(saved).slice(0, 200));

reset();
rpcAnswer.kb_ig_ticket_take = 'me@x.io';
fbPages = [];
res = await get('/meta/callback?code=abc&state=00000000-aaaa-4aaa-8aaa-000000000001');
html = await res.text();
check('an approval that shared no Pages saves nothing and says what to do',
  /didn’t share any Pages/.test(html) && rpcs('kb_meta_save').length === 0, html.slice(0, 200));

/* And it has to come back out again, or nothing can ever post. */
reset();
rpcAnswer.kb_meta_secret = { page_id: '555', page_name: 'The Buy Box', ig_user_id: '178414', cipher: one.cipher, iv: one.iv };
const opened = await pageAccount(metaEnv);
check('the Worker can open it again with its own key',
  opened?.token === 'PAGE-SECRET' && opened.pageId === '555' && opened.igUserId === '178414', JSON.stringify(opened));

reset();
rpcAnswer.kb_meta_account = [{ page_id: '555', page_name: 'The Buy Box', ig_user_id: '178414', ig_username: 'thebuyboxre', selected: true }];
res = await post('/meta/account', {}, TOKEN, metaEnv);
j = await res.json();
check('the page is told which Page is connected, and never the token',
  j.connected === true && j.page?.ig_username === 'thebuyboxre' && !JSON.stringify(j).includes('cipher'),
  JSON.stringify(j));

reset();
res = await post('/meta/pick', { page_id: 'not-a-page' }, TOKEN, metaEnv);
check('choosing a Page that is not an id -> 400', res.status === 400, res.status);

/* --- scheduling ------------------------------------------------------------ */

const soon = () => new Date(Date.now() + 3600000).toISOString();

reset();
for (const [what, payload] of [
  ['an unknown kind', { kind: 'story', media: [{ url: 'https://x/a.mp4' }], scheduled_for: soon() }],
  ['nothing to post', { kind: 'reel', media: [], scheduled_for: soon() }],
  ['media that is not https', { kind: 'reel', media: [{ url: 'http://x/a.mp4' }], scheduled_for: soon() }],
  ['a carousel of one', { kind: 'carousel', media: [{ url: 'https://x/a.jpg' }], scheduled_for: soon() }],
  ['a time that has gone', { kind: 'reel', media: [{ url: 'https://x/a.mp4' }], scheduled_for: new Date(Date.now() - 7200000).toISOString() }],
  ['to a platform we do not post to', { kind: 'reel', media: [{ url: 'https://x/a.mp4' }], scheduled_for: soon(), platforms: ['myspace'] }],
  ['a Facebook carousel with a video in it', { kind: 'carousel', media: [{ url: 'https://x/a.jpg' }, { url: 'https://x/b.mp4', kind: 'video' }], scheduled_for: soon(), platforms: ['facebook'] }],
]) {
  reset();
  res = await post('/posts/create', payload);
  check(`scheduling ${what} -> 400, nothing saved`,
    res.status === 400 && rpcs('kb_post_create').length === 0, res.status);
}

reset();
rpcAnswer.kb_post_create = '55555555-5555-4555-8555-555555555555';
res = await post('/posts/create', {
  kind: 'reel', media: [{ url: 'https://videos.example/a.mp4' }],
  caption: 'Four rowhomes, one loan.', scheduled_for: soon(),
  render_id: 'cccc3333-3333-4333-8333-cccccccccccc',
});
j = await res.json();
const scheduled = rpcs('kb_post_create')[0]?.body;
check('a reel is scheduled, with its caption, time and the video it came from',
  res.status === 200 && j.status === 'scheduled' && scheduled.p_kind === 'reel'
  && scheduled.p_media[0].kind === 'video' && scheduled.p_caption === 'Four rowhomes, one loan.'
  && scheduled.p_render_id === 'cccc3333-3333-4333-8333-cccccccccccc',
  JSON.stringify(scheduled).slice(0, 200));
check('...to Instagram when no platform is named, as before',
  rpcs('kb_post_create').length === 1 && scheduled.p_platform === 'instagram', scheduled.p_platform);

reset();
rpcAnswer.kb_post_create = '55555555-5555-4555-8555-555555555555';
res = await post('/posts/create', {
  kind: 'reel', media: [{ url: 'https://videos.example/a.mp4' }], scheduled_for: soon(),
  platforms: ['instagram', 'facebook', 'facebook'],
});
check('scheduling to both makes one row each, and only one each',
  res.status === 200 && rpcs('kb_post_create').map((c) => c.body.p_platform).join() === 'instagram,facebook',
  rpcs('kb_post_create').map((c) => c.body.p_platform).join());

reset();
rpcAnswer.kb_post_cancel = false;
res = await post('/posts/cancel', { id: '55555555-5555-4555-8555-555555555555' });
check('cancelling one that has already gone out -> 409', res.status === 409, res.status);

/* --- sending it to Instagram ---------------------------------------------- */

/* The publisher needs a token it can open, so reuse the one sealed above. */
const publishEnv = {
  ...metaEnv, POST_WAIT_TRIES: 2, POST_WAIT_MS: 1,
};
const sealed = (over) => ({
  page_id: '555', page_name: 'The Buy Box', ig_user_id: '178414', cipher: one.cipher, iv: one.iv, ...over,
});
const DUE = (over) => ({
  id: '55555555-5555-4555-8555-555555555555', kind: 'reel', attempts: 1, platform: 'instagram',
  media: [{ url: 'https://videos.example/a.mp4', kind: 'video' }],
  caption: 'Four rowhomes, one loan.', container_id: null, ...over,
});
const IG_MEDIA = /\/v25\.0\/178414\/media$/;

reset();
rpcAnswer.kb_meta_secret = null;
rpcAnswer.kb_post_claim = DUE();
let out = await publishDue(publishEnv);
check('with no Page connected nothing is claimed or sent',
  out.error === 'no Facebook Page is connected' && rpcs('kb_post_claim').length === 0, JSON.stringify(out));

reset();
rpcAnswer.kb_meta_secret = sealed();
rpcAnswer.kb_post_claim = DUE();
container = ['IN_PROGRESS', 'FINISHED'];
out = await publishDue(publishEnv, 1);
let builtCall = calls.find((c) => IG_MEDIA.test(c.url));
let built = builtCall?.body;
check('a reel is built as a REELS container from the video url, with the Page token',
  built?.media_type === 'REELS' && built.video_url === 'https://videos.example/a.mp4'
  && built.caption === 'Four rowhomes, one loan.' && built.access_token === 'PAGE-SECRET', JSON.stringify(built));
check('...and published only once the container says it is finished',
  calls.some((c) => c.url.includes('/media_publish')) && out.done[0]?.outcome === 'posted',
  JSON.stringify(out.done));
let posted = rpcs('kb_post_state').map((c) => c.body).find((b) => b.p_status === 'posted');
check('...with the permalink kept',
  posted?.p_permalink === 'https://www.instagram.com/reel/xyz/' && posted.p_media_id === 'MEDIA-1',
  JSON.stringify(posted));

reset();
rpcAnswer.kb_meta_secret = sealed({ ig_user_id: null });
rpcAnswer.kb_post_claim = DUE();
out = await publishDue(publishEnv, 1);
let said = rpcs('kb_post_state').map((c) => c.body).at(-1);
check('an Instagram post on a Page with no Instagram linked says so, and builds nothing',
  /no Instagram account linked/.test(said?.p_error || '') && !calls.some((c) => c.url.includes('/media')),
  JSON.stringify(said));

reset();
rpcAnswer.kb_meta_secret = sealed();
rpcAnswer.kb_post_claim = DUE({ kind: 'image', media: [{ url: 'https://videos.example/a.jpg', kind: 'image' }] });
container = ['FINISHED'];
await publishDue(publishEnv, 1);
built = calls.find((c) => IG_MEDIA.test(c.url))?.body;
check('an image is built from image_url, with no media_type',
  built?.image_url === 'https://videos.example/a.jpg' && !built.media_type, JSON.stringify(built));

reset();
rpcAnswer.kb_meta_secret = sealed();
rpcAnswer.kb_post_claim = DUE({
  kind: 'carousel',
  media: [{ url: 'https://videos.example/1.jpg', kind: 'image' }, { url: 'https://videos.example/2.mp4', kind: 'video' }],
});
container = ['FINISHED'];
await publishDue(publishEnv, 1);
const containers = calls.filter((c) => IG_MEDIA.test(c.url)).map((c) => c.body);
check('a carousel builds each child first, then one container holding them',
  containers.length === 3 && containers[0].is_carousel_item === 'true'
  && containers[1].media_type === 'VIDEO' && containers[1].is_carousel_item === 'true'
  && containers[2].media_type === 'CAROUSEL' && containers[2].children.split(',').length === 2,
  JSON.stringify(containers.map((c) => c.media_type || 'image')));
check('...and only the holding container carries the caption',
  !containers[0].caption && !containers[1].caption && containers[2].caption === 'Four rowhomes, one loan.');

/* Still processing when the run gives up: the container is kept so the next
 * run carries on, and nothing is published. */
reset();
rpcAnswer.kb_meta_secret = sealed();
rpcAnswer.kb_post_claim = DUE();
container = ['IN_PROGRESS', 'IN_PROGRESS', 'IN_PROGRESS'];
out = await publishDue(publishEnv, 1);
let left = rpcs('kb_post_state').map((c) => c.body).at(-1);
check('a container still processing is left working, with its id kept',
  out.done[0]?.outcome === 'waiting' && left.p_status === 'working' && left.p_container === 'CONTAINER-1'
  && !calls.some((c) => c.url.includes('/media_publish')),
  JSON.stringify({ outcome: out.done[0]?.outcome, status: left.p_status, container: left.p_container }));

reset();
rpcAnswer.kb_meta_secret = sealed();
rpcAnswer.kb_post_claim = DUE({ container_id: 'CONTAINER-EARLIER' });
container = ['FINISHED'];
await publishDue(publishEnv, 1);
check('a post picked up mid-flight does not build a second container',
  !calls.some((c) => IG_MEDIA.test(c.url))
  && calls.some((c) => c.url.includes('/media_publish')));

/* Instagram refusing the media. */
reset();
rpcAnswer.kb_meta_secret = sealed();
rpcAnswer.kb_post_claim = DUE({ attempts: 1 });
container = ['ERROR'];
out = await publishDue(publishEnv, 1);
said = rpcs('kb_post_state').map((c) => c.body).at(-1);
check('a container that errors goes back to scheduled, with the reason on it',
  said.p_status === 'scheduled' && (said.p_error || '').length > 0,
  JSON.stringify({ status: said.p_status, error: said.p_error }));

reset();
rpcAnswer.kb_meta_secret = sealed();
rpcAnswer.kb_post_claim = DUE({ attempts: 5 });
container = ['ERROR'];
out = await publishDue(publishEnv, 1);
said = rpcs('kb_post_state').map((c) => c.body).at(-1);
check('after five tries it is marked failed rather than retried forever',
  said.p_status === 'failed' && out.done[0]?.outcome === 'failed',
  JSON.stringify({ status: said.p_status, outcome: out.done[0]?.outcome }));

/* --- sending it to Facebook ------------------------------------------------ */

const REELS = /\/v25\.0\/555\/video_reels$/;

reset();
rpcAnswer.kb_meta_secret = sealed();
rpcAnswer.kb_post_claim = DUE({ platform: 'facebook' });
reelStatus = [
  { video_status: 'processing', uploading_phase: { status: 'complete' }, processing_phase: { status: 'in_progress' } },
  { video_status: 'ready', uploading_phase: { status: 'complete' }, processing_phase: { status: 'complete' } },
];
out = await publishDue(publishEnv, 1);
const reelCalls = calls.filter((c) => REELS.test(c.url)).map((c) => c.body);
const upload = calls.find((c) => c.url.startsWith('https://rupload.facebook.com/video-upload/v25.0/VID-1'));
check('a Facebook reel opens an upload on the Page, then hands Facebook the video url',
  reelCalls[0]?.upload_phase === 'start' && upload?.headers?.file_url === 'https://videos.example/a.mp4'
  && upload.headers.authorization === 'OAuth PAGE-SECRET',
  JSON.stringify({ first: reelCalls[0], headers: upload?.headers }));
check('...and finishes it as published, with the caption, only once it is processed',
  reelCalls.length === 2 && reelCalls[1].upload_phase === 'finish' && reelCalls[1].video_id === 'VID-1'
  && reelCalls[1].video_state === 'PUBLISHED' && reelCalls[1].description === 'Four rowhomes, one loan.'
  && calls.filter((c) => c.url.includes('/VID-1?') && c.url.includes('fields=status')).length === 2,
  JSON.stringify(reelCalls));
posted = rpcs('kb_post_state').map((c) => c.body).find((b) => b.p_status === 'posted');
check('...with a full link to it kept, not Facebook’s relative one',
  out.done[0]?.outcome === 'posted' && posted?.p_permalink === 'https://www.facebook.com/reel/123'
  && posted.p_media_id === 'VID-1', JSON.stringify(posted));
check('...and nothing sent to the Instagram endpoints',
  !calls.some((c) => c.url.includes('/178414/')));

reset();
rpcAnswer.kb_meta_secret = sealed();
rpcAnswer.kb_post_claim = DUE({ platform: 'facebook' });
reelStatus = [
  { video_status: 'processing', uploading_phase: { status: 'complete' }, processing_phase: { status: 'in_progress' } },
  { video_status: 'processing', uploading_phase: { status: 'complete' }, processing_phase: { status: 'in_progress' } },
];
out = await publishDue(publishEnv, 1);
left = rpcs('kb_post_state').map((c) => c.body).at(-1);
check('a Facebook reel still processing is left working with its video id, not finished',
  out.done[0]?.outcome === 'waiting' && left.p_container === 'VID-1'
  && !calls.some((c) => REELS.test(c.url) && c.body?.upload_phase === 'finish'),
  JSON.stringify(left));

reset();
rpcAnswer.kb_meta_secret = sealed();
rpcAnswer.kb_post_claim = DUE({ platform: 'facebook', container_id: 'VID-1' });
reelStatus = [{ video_status: 'ready', uploading_phase: { status: 'complete' }, processing_phase: { status: 'complete' } }];
out = await publishDue(publishEnv, 1);
check('a Facebook reel picked up mid-flight does not open a second upload',
  out.done[0]?.outcome === 'posted' && !calls.some((c) => c.url.startsWith('https://rupload.'))
  && calls.filter((c) => REELS.test(c.url)).map((c) => c.body.upload_phase).join() === 'finish');

reset();
rpcAnswer.kb_meta_secret = sealed();
rpcAnswer.kb_post_claim = DUE({ platform: 'facebook', container_id: 'VID-1' });
reelStatus = [{ video_status: 'error', processing_phase: { status: 'error', errors: [{ message: 'Video too long' }] } }];
out = await publishDue(publishEnv, 1);
said = rpcs('kb_post_state').map((c) => c.body).at(-1);
check('a reel Facebook cannot process goes back with Facebook’s reason on it',
  said.p_status === 'scheduled' && said.p_error === 'Video too long', JSON.stringify(said));

reset();
rpcAnswer.kb_meta_secret = sealed({ ig_user_id: null });
rpcAnswer.kb_post_claim = DUE({ platform: 'facebook', kind: 'image', media: [{ url: 'https://videos.example/a.jpg', kind: 'image' }] });
out = await publishDue(publishEnv, 1);
built = calls.find((c) => /\/v25\.0\/555\/photos$/.test(c.url))?.body;
posted = rpcs('kb_post_state').map((c) => c.body).find((b) => b.p_status === 'posted');
check('a Facebook photo is one call with the caption, and needs no Instagram',
  built?.url === 'https://videos.example/a.jpg' && built.message === 'Four rowhomes, one loan.'
  && posted?.p_media_id === 'PAGE_POST-1', JSON.stringify({ built, posted }));

reset();
rpcAnswer.kb_meta_secret = sealed();
rpcAnswer.kb_post_claim = DUE({
  platform: 'facebook', kind: 'carousel',
  media: [{ url: 'https://videos.example/1.jpg', kind: 'image' }, { url: 'https://videos.example/2.jpg', kind: 'image' }],
});
out = await publishDue(publishEnv, 1);
const uploads = calls.filter((c) => /\/v25\.0\/555\/photos$/.test(c.url)).map((c) => c.body);
const feed = calls.find((c) => /\/v25\.0\/555\/feed$/.test(c.url))?.body;
check('several Facebook photos are uploaded unpublished, then posted together once',
  uploads.length === 2 && uploads.every((p) => p.published === 'false' && !p.message)
  && JSON.parse(feed?.['attached_media[1]'] || '{}').media_fbid === 'PHOTO-2'
  && feed.message === 'Four rowhomes, one loan.', JSON.stringify({ uploads, feed }));

/* --- Upload-Post: connecting ----------------------------------------------- */

const upEnv = { ...env, UPLOAD_POST_API_KEY: 'up-key', POST_WAIT_TRIES: 2, POST_WAIT_MS: 1 };
const upCalls = () => calls.filter((c) => c.url.startsWith('https://api.upload-post.com/'));

reset();
res = await post('/social/account', {}, TOKEN, env);
j = await res.json();
check('with no Upload-Post key the page is told it is not set up, and nothing is called',
  res.status === 200 && j.ready === false && upCalls().length === 0, JSON.stringify(j));

reset();
res = await post('/social/connect', {}, TOKEN, env);
j = await res.json();
check('connecting with no Upload-Post key -> 503 saying which to set',
  res.status === 503 && /UPLOAD_POST_API_KEY/.test(j.hint || ''), JSON.stringify(j));

reset();
upProfile = null;   // not made yet
res = await post('/social/connect', {}, TOKEN, upEnv);
j = await res.json();
const createdProfile = upCalls().find((c) => c.url.endsWith('/api/uploadposts/users') && c.body?.username);
const jwt = upCalls().find((c) => c.url.endsWith('/generate-jwt'));
check('connecting makes the profile the first time, then hands back Upload-Post’s own page',
  res.status === 200 && j.url === 'https://app.upload-post.com/connect?token=JWT' && createdProfile?.body.username === 'thebuybox',
  JSON.stringify({ status: res.status, j, made: createdProfile?.body }));
check('...for all four platforms, coming back to the Schedule page',
  ['instagram', 'facebook', 'youtube', 'tiktok'].every((p) => jwt?.body.platforms.includes(p))
  && jwt.body.redirect_url === 'http://localhost:8788/schedule.html',
  JSON.stringify(jwt?.body));
check('...and the API key goes in the header, never to the page',
  jwt?.headers?.authorization === 'Apikey up-key' && !JSON.stringify(j).includes('up-key'));

reset();
res = await post('/social/account', {}, TOKEN, upEnv);
j = await res.json();
check('the page is told which accounts are connected, by handle',
  j.ready === true && j.accounts.youtube?.handle === '@thebuyboxre' && j.accounts.tiktok === null
  && j.accounts.instagram?.handle === 'thebuyboxre', JSON.stringify(j));
check('...and with two Facebook Pages and none chosen, that one has to be chosen',
  j.facebook_pages.length === 2 && j.facebook_page_id === null, JSON.stringify(j.facebook_pages));

reset();
res = await post('/social/facebook-page', { page_id: '999' }, TOKEN, upEnv);
check('choosing a Page Upload-Post does not have -> 404, nothing saved',
  res.status === 404 && rpcs('kb_social_set').length === 0, res.status);

reset();
res = await post('/social/facebook-page', { page_id: '555' }, TOKEN, upEnv);
check('choosing one of the connected Pages saves it',
  res.status === 200 && rpcs('kb_social_set')[0]?.body.p_value === '555', res.status);

/* --- Upload-Post: sending -------------------------------------------------- */

reset();
rpcAnswer.kb_post_create = '55555555-5555-4555-8555-555555555555';
res = await post('/posts/create', {
  kind: 'reel', media: [{ url: 'https://videos.example/a.mp4' }], scheduled_for: soon(),
  platforms: ['youtube', 'tiktok'], title: 'Four rowhomes, one loan',
});
check('YouTube and TikTok can be scheduled, with a title kept for YouTube',
  res.status === 200 && rpcs('kb_post_create').map((c) => c.body.p_platform).join() === 'youtube,tiktok'
  && rpcs('kb_post_create')[0].body.p_title === 'Four rowhomes, one loan',
  JSON.stringify(rpcs('kb_post_create').map((c) => c.body)));

reset();
rpcAnswer.kb_post_claim = DUE({ platform: 'youtube', title: 'Four rowhomes, one loan' });
upStatus = [{ status: 'processing', results: [] },
  { status: 'completed', results: [{ platform: 'youtube', success: true, url: 'https://youtube.com/shorts/abc', post_id: 'abc' }] }];
out = await publishDue(upEnv, 1);
let sent = upCalls().find((c) => c.url.endsWith('/api/upload'))?.body;
check('with Upload-Post set, a due post is sent there and not to Meta',
  sent && !calls.some((c) => c.url.includes('graph.facebook.com')) && rpcs('kb_meta_secret').length === 0,
  JSON.stringify(sent));
check('...as the video url, to the one platform, in the background, with our id on it',
  sent['platform[]'] === 'youtube' && sent.video === 'https://videos.example/a.mp4' && sent.user === 'thebuybox'
  && sent.async_upload === 'true' && sent.external_id === '55555555-5555-4555-8555-555555555555',
  JSON.stringify(sent));
check('...with the YouTube title and the caption as its description, public',
  sent.title === 'Four rowhomes, one loan' && sent.youtube_description === 'Four rowhomes, one loan.'
  && sent.privacyStatus === 'public', JSON.stringify(sent));
posted = rpcs('kb_post_state').map((c) => c.body).find((b) => b.p_status === 'posted');
check('...followed until it is up, and the link kept',
  out.done[0]?.outcome === 'posted' && posted?.p_permalink === 'https://youtube.com/shorts/abc'
  && rpcs('kb_post_state').some((c) => c.body.p_container === 'REQ-1'), JSON.stringify(posted));

reset();
rpcAnswer.kb_post_claim = DUE({ platform: 'tiktok' });
upStatus = [{ status: 'processing', results: [] }, { status: 'processing', results: [] }];
out = await publishDue(upEnv, 1);
left = rpcs('kb_post_state').map((c) => c.body).at(-1);
check('one still going is left working with its request id, to be followed next run',
  out.done[0]?.outcome === 'waiting' && left.p_status === 'working' && left.p_container === 'REQ-1',
  JSON.stringify(left));

reset();
rpcAnswer.kb_post_claim = DUE({ platform: 'tiktok', container_id: 'REQ-EARLIER' });
upStatus = [{ status: 'completed', results: [{ platform: 'tiktok', success: true, url: 'https://tiktok.com/@thebuyboxre/video/1' }] }];
out = await publishDue(upEnv, 1);
check('a post picked up mid-flight is followed, not sent a second time',
  out.done[0]?.outcome === 'posted' && !upCalls().some((c) => c.url.endsWith('/api/upload'))
  && upCalls().some((c) => c.url.includes('request_id=REQ-EARLIER')));

reset();
rpcAnswer.kb_post_claim = DUE({ platform: 'tiktok', container_id: 'REQ-1' });
upStatus = [{ status: 'failed', results: [{ platform: 'tiktok', success: false, error_message: 'Video must be at least 3 seconds' }] }];
out = await publishDue(upEnv, 1);
said = rpcs('kb_post_state').map((c) => c.body).at(-1);
check('a platform refusing it goes back with the platform’s reason on it',
  said.p_status === 'scheduled' && said.p_error === 'Video must be at least 3 seconds', JSON.stringify(said));

reset();
rpcAnswer.kb_post_claim = DUE({ platform: 'facebook' });
rpcAnswer.kb_social_get = '555';
upStatus = [{ status: 'completed', results: [{ platform: 'facebook', success: true, url: 'https://facebook.com/reel/9' }] }];
out = await publishDue(upEnv, 1);
sent = upCalls().find((c) => c.url.endsWith('/api/upload'))?.body;
check('a Facebook post goes to the chosen Page',
  out.done[0]?.outcome === 'posted' && sent?.facebook_page_id === '555', JSON.stringify(sent));

reset();
rpcAnswer.kb_post_claim = DUE({ platform: 'facebook' });
rpcAnswer.kb_social_get = null;
out = await publishDue(upEnv, 1);
said = rpcs('kb_post_state').map((c) => c.body).at(-1);
check('with several Pages and none chosen, it says to choose one rather than guessing',
  /choose which Facebook Page/.test(said?.p_error || '') && !upCalls().some((c) => c.url.endsWith('/api/upload')),
  JSON.stringify(said));

reset();
rpcAnswer.kb_post_claim = DUE({ platform: 'youtube' });
upSend = { status: 403, body: { success: false, message: 'TikTok requires a paid plan' } };
out = await publishDue(upEnv, 1);
said = rpcs('kb_post_state').map((c) => c.body).at(-1);
check('Upload-Post refusing the request puts its own reason on the post',
  said.p_status === 'scheduled' && said.p_error === 'TikTok requires a paid plan', JSON.stringify(said));

reset();
rpcAnswer.kb_meta_secret = sealed();
rpcAnswer.kb_post_claim = DUE({ platform: 'tiktok' });
out = await publishDue(publishEnv, 1);
said = rpcs('kb_post_state').map((c) => c.body).at(-1);
check('without Upload-Post, a TikTok post says it needs it',
  /need Upload-Post/.test(said?.p_error || ''), JSON.stringify(said));

/* --- raw footage ----------------------------------------------------------- */

reset();
res = await post('/footage/start', { name: 'A take', bytes: 2e9, content_type: 'application/pdf' });
check('footage that is not video -> 415, no row and no signature',
  res.status === 415 && rpcs('kb_footage_create').length === 0
  && !calls.some((c) => c.url.includes('/upload/sign/')), res.status);

reset();
res = await post('/footage/start', { name: 'A take', bytes: 1000, content_type: 'video/mp4' });
check('a file too small to be a take -> 400', res.status === 400, res.status);

reset();
res = await post('/footage/start', { name: 'A take', bytes: 9e9, content_type: 'video/mp4' });
check('a file over the bucket limit -> 413, said in gigabytes',
  res.status === 413 && /GB/.test((await res.json()).error || ''), res.status);

reset();
rpcAnswer.kb_footage_create = '66666666-6666-4666-8666-666666666666';
res = await post('/footage/start', { name: 'Monday morning take', bytes: 2.4e9, content_type: 'video/quicktime' });
j = await res.json();
check('a take is signed for upload, and the row records it',
  res.status === 200 && j.id === '66666666-6666-4666-8666-666666666666'
  && j.token === 'SIGNED-TOKEN-123' && /\.mov$/.test(j.path)
  && rpcs('kb_footage_create')[0].body.p_bytes === 2.4e9,
  JSON.stringify(j).slice(0, 200));
check('the upload goes to the direct storage host, resumable',
  j.endpoint === 'https://db.storage.supabase.co/storage/v1/upload/resumable', j.endpoint);
check('the browser is never handed the anon key',
  !JSON.stringify(j).includes('anon'), JSON.stringify(j).slice(0, 200));

reset();
rpcAnswer.kb_footage_read = {
  id: '66666666-6666-4666-8666-666666666666', name: 'Monday morning take', status: 'ready',
  storage_path: 'abc.mov', transcript: 'Four rowhomes...', words: [{ t: 'Four', s: 0.1, e: 0.4 }],
};
res = await post('/footage/read', { id: '66666666-6666-4666-8666-666666666666' });
j = await res.json();
check('reading a take gives the page the transcript but not the word timings',
  j.footage.transcript.startsWith('Four rowhomes') && j.footage.has_words === true
  && !('words' in j.footage) && !('storage_path' in j.footage),
  JSON.stringify(j.footage).slice(0, 200));

/* Finishing an upload is what starts the cutting; nothing else does. */
reset();
rpcAnswer.kb_footage_state = true;
res = await post('/footage/uploaded', { id: '66666666-6666-4666-8666-666666666666' });
const dispatched = calls.find((c) => c.url.includes('/actions/workflows/'));
check('an upload that finished starts the cutting run for that take',
  res.status === 202 && /cut-footage\.yml\/dispatches$/.test(dispatched?.url || '')
  && dispatched.body.inputs.footage_id === '66666666-6666-4666-8666-666666666666',
  dispatched?.url);

reset();
rpcAnswer.kb_footage_state = true;
githubOk = false;
res = await post('/footage/uploaded', { id: '66666666-6666-4666-8666-666666666666' });
githubOk = true;
check('a take whose run could not be started is marked failed, not left waiting',
  res.status === 502 && rpcs('kb_footage_state').some((c) => c.body.p_status === 'failed'),
  res.status);

/* A take that fell over is run again from the file already in storage. */
reset();
rpcAnswer.kb_footage_read = { id: '66666666-6666-4666-8666-666666666666', status: 'failed', storage_path: 'abc.mov' };
rpcAnswer.kb_footage_state = true;
res = await post('/footage/retry', { id: '66666666-6666-4666-8666-666666666666' });
const again = calls.find((c) => c.url.includes('/actions/workflows/'));
check('retrying a failed take starts the run again, without a second upload',
  res.status === 202 && /cut-footage\.yml\/dispatches$/.test(again?.url || '')
  && rpcs('kb_footage_state').some((c) => c.body.p_status === 'uploaded' && c.body.p_error === null)
  && !calls.some((c) => c.url.includes('/upload/sign/')),
  res.status);

reset();
rpcAnswer.kb_footage_read = { id: '66666666-6666-4666-8666-666666666666', status: 'transcribing' };
res = await post('/footage/retry', { id: '66666666-6666-4666-8666-666666666666' });
check('one already being transcribed is left alone',
  res.status === 200 && !calls.some((c) => c.url.includes('/actions/workflows/')), res.status);

reset();
rpcAnswer.kb_footage_delete = { ok: true, storage_path: 'abc.mov' };
res = await post('/footage/delete', { id: '66666666-6666-4666-8666-666666666666' });
await settle();
check('deleting a take takes the file with it',
  res.status === 200 && calls.some((c) => c.url.includes('/object/kb-footage/abc.mov') && c.url),
  res.status);

/* --- version 6: clip edits, the Library's files, recent plans ------------- */

const CLIP = '2a020bb0-7912-4867-a484-17c01f1027ee';
for (const path of ['/clips/info', '/clips/edit', '/kb/list', '/kb/delete', '/plan/list']) {
  reset();
  const r = await post(path, {}, '');
  check(`${path} without a session -> 401`, r.status === 401, r.status);
}

reset();
rpcAnswer.kb_clip_request_edit = { ok: true, id: CLIP };
res = await post('/clips/edit', { id: CLIP, start_s: 112, end_s: 140, cuts: [{ from: 120, to: 122 }], fixes: [{ at: 125.3, text: 'bond' }], summary: 'Trimmed' });
const clipRun = calls.find((c) => c.url.includes('/actions/workflows/'));
const asked = rpcs('kb_clip_request_edit')[0]?.body;
check('a clip edit is queued with its window and starts the cutting run for that clip',
  res.status === 202 && /cut-footage\.yml\/dispatches$/.test(clipRun?.url || '') && clipRun.body.inputs.clip_id === CLIP
  && asked.p_start === 112 && asked.p_end === 140 && asked.p_cuts[0].from === 120 && asked.p_fixes[0].text === 'bond',
  JSON.stringify(asked));

reset();
rpcAnswer.kb_clip_request_edit = { ok: false, error: 'Only clips in To review can be edited.' };
res = await post('/clips/edit', { id: CLIP, start_s: 112, end_s: 140 });
check('a refused clip edit says why and starts nothing',
  res.status === 409 && /To review/.test((await res.json()).error) && !calls.some((c) => c.url.includes('/actions/workflows/')), res.status);

reset();
rpcAnswer.kb_clip_request_edit = { ok: true, id: CLIP };
rpcAnswer.kb_clip_edit_state = true;
githubOk = false;
res = await post('/clips/edit', { id: CLIP, start_s: 112, end_s: 140 });
githubOk = true;
check('a clip edit whose run could not start is marked failed',
  res.status === 502 && rpcs('kb_clip_edit_state').some((c) => c.body.p_status === 'failed'), res.status);

reset();
rpcAnswer.kb_uploads_list = [{ id: LINK, title: 'An article', document_type: 'article' }];
res = await post('/kb/list', {});
j = await res.json();
check('the Library lists files put in by hand', res.status === 200 && j.files[0].title === 'An article', JSON.stringify(j));

reset();
rpcAnswer.kb_upload_delete = false;
res = await post('/kb/delete', { id: LINK });
check('removing a file that is not an upload is refused', res.status === 404, res.status);

reset();
rpcAnswer.kb_plans_recent = [{ id: 'plan-1', goal: 'Financing basics', slots: 3, rendered: 3 }];
res = await post('/plan/list', {});
j = await res.json();
check('recent plans are listed', res.status === 200 && j.plans[0].id === 'plan-1', JSON.stringify(j));

reset();
rpcAnswer.kb_video_set_review = { found: true, review_status: null, reviewed_at: null };
res = await post('/videos/review', { id: CLIP, status: 'review' });
check('a video can be moved back to review', res.status === 200 && rpcs('kb_video_set_review')[0]?.body.p_status === 'review', res.status);

reset();
rpcAnswer.kb_video_library = [{ id: CLIP, kind: 'clip', storage_path: 'clips/x.mp4', rendered_at: '2026-10-13T10:00:00Z' }];
res = await post('/videos', {});
j = await res.json();
check('a clip’s URL changes when the clip does', /\/clips\/x\.mp4\?v=\d+$/.test(j.videos[0].url), j.videos[0].url);

/* The arithmetic of an edited clip. */
const { keptSegments, wordsFor, openingSentence } = await import(pathToFileURL(join(here, '..', 'video', 'clip-edit.mjs')).href);
const segs = keptSegments(10, 20, [{ from: 12, to: 14 }]);
check('cutting a section out leaves the two sides', JSON.stringify(segs) === '[[10,12],[14,20]]', JSON.stringify(segs));
const ws = wordsFor([{ t: 'a', s: 10.5, e: 10.8 }, { t: 'gone', s: 12.5, e: 12.9 }, { t: 'wrod', s: 15, e: 15.4 }], segs, [{ at: 15, text: 'word' }]);
check('words in a cut section go, fixes apply, and later words move up',
  ws.length === 2 && ws[1].t === 'word' && ws[1].s === 3 && ws[0].s === 0.5, JSON.stringify(ws));
check('the hook is the sentence the clip opens on',
  openingSentence([{ t: 'Rates' }, { t: 'rose.' }, { t: 'Then' }]) === 'Rates rose.', '');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
