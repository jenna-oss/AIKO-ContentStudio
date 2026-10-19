/* ---------------------------------------------------------------------------
 * Sign-in for the whole app.
 *
 * Accounts are Clerk accounts: single sign-on (Google, Microsoft, whatever is
 * switched on in the Clerk dashboard) or an email and password. The pages sign
 * in with Clerk directly and send its short-lived session token with every
 * call; this file checks that token against Clerk's signing keys and asks
 * Clerk for the person's email.
 *
 * "Has a Clerk account" is still not the same as "may use this app". Who may
 * is kb.app_users, checked on every request: taking someone off the list locks
 * them out within a minute.
 *
 * CLERK_SECRET_KEY is the only Clerk secret. It reads the signing keys and the
 * user's email from Clerk's Backend API; the browser never sees it.
 * ------------------------------------------------------------------------ */

import { rpc } from './db.js';

const CLERK_API = 'https://api.clerk.com/v1';
const USER_CACHE_MS = 60000;
const KEYS_CACHE_MS = 3600000;
const MAX_CACHE = 500;
/* Clocks drift; Clerk's own SDK allows the same. */
const SKEW_S = 5;

/* Clerk user id -> { email, allowed, until }. Per isolate, so it only saves
 * repeat lookups within a burst of requests; the source of truth is Clerk and
 * kb.app_users. */
const userCache = new Map();
/* kid -> CryptoKey, refetched when an unknown kid turns up or after an hour. */
let keys = { byKid: new Map(), until: 0 };

const cleanEmail = (v) => String(v ?? '').trim().toLowerCase().slice(0, 254);

const bearer = (request) => {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};

async function clerk(env, path) {
  if (!env.CLERK_SECRET_KEY) throw new Error('CLERK_SECRET_KEY is not set');
  const res = await fetch(`${CLERK_API}/${path}`, {
    headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`clerk ${path.split('/')[0]} ${res.status}`);
  return res.json();
}

async function signingKey(env, kid) {
  if (keys.until < Date.now() || !keys.byKid.has(kid)) {
    const { keys: jwks = [] } = await clerk(env, 'jwks');
    const byKid = new Map();
    for (const jwk of jwks) {
      if (jwk.kty !== 'RSA' || !jwk.kid) continue;
      byKid.set(jwk.kid, await crypto.subtle.importKey(
        'jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
      ));
    }
    keys = { byKid, until: Date.now() + KEYS_CACHE_MS };
  }
  return keys.byKid.get(kid) || null;
}

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const part = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

/* The token's claims if Clerk signed it, it is in date, and it was made for
 * one of this app's pages; null otherwise. Network trouble reaching Clerk
 * throws, so it reads as "try again" rather than "sign in again". */
async function verify(env, token, isAllowedOrigin) {
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) return null;
  let header, claims;
  try { header = part(h); claims = part(p); } catch { return null; }
  if (header.alg !== 'RS256' || !header.kid) return null;

  const key = await signingKey(env, header.kid);
  if (!key) return null;
  let good = false;
  try {
    good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  } catch { return null; }
  if (!good) return null;

  const now = Math.floor(Date.now() / 1000);
  if (!(Number(claims.exp) > now - SKEW_S)) return null;
  if (Number(claims.nbf) > now + SKEW_S) return null;
  /* azp is the page origin the token was minted for. A token taken from some
   * other site on the same Clerk instance is not good here. */
  if (claims.azp && !isAllowedOrigin(claims.azp)) return null;
  if (!claims.sub) return null;
  return claims;
}

async function isListed(env, email) {
  if (!email) return false;
  try { return Boolean(await rpc(env, 'kb_app_user_allowed', { p_email: email })); }
  catch { return false; }
}

/* A person's verified addresses, primary first. Only verified ones count, so
 * nobody gets in by typing someone else's address into a new account. */
function verifiedEmails(user) {
  const all = (user.email_addresses || [])
    .filter((e) => e?.verification?.status === 'verified')
    .sort((a, b) => (b.id === user.primary_email_address_id) - (a.id === user.primary_email_address_id));
  return all.map((e) => cleanEmail(e.email_address)).filter(Boolean);
}

const NOT_LISTED = 'This email isn’t on the list for this app. Ask to be added.';

/* Every route. Returns { user } for a signed-in person on the list, or
 * { response } to send instead. `signin: true` tells the page to go and sign
 * in rather than show the error. */
export async function requireUser(request, env, headers, isAllowedOrigin) {
  const deny = (error, status) => ({
    response: new Response(JSON.stringify({ error, signin: true }), {
      status, headers: { ...headers, 'content-type': 'application/json' },
    }),
  });

  const token = bearer(request);
  if (!token) return deny('Sign in to use this.', 401);

  const claims = await verify(env, token, isAllowedOrigin);
  if (!claims) return deny('Your session has ended. Sign in again.', 401);

  const now = Date.now();
  let hit = userCache.get(claims.sub);
  if (!hit || hit.until < now) {
    const emails = verifiedEmails(await clerk(env, `users/${encodeURIComponent(claims.sub)}`));
    let email = emails[0] || '';
    let allowed = false;
    for (const e of emails) {
      if (await isListed(env, e)) { email = e; allowed = true; break; }
    }
    hit = { email, allowed, until: now + USER_CACHE_MS };
    if (userCache.size >= MAX_CACHE) userCache.delete(userCache.keys().next().value);
    userCache.set(claims.sub, hit);
  }
  if (!hit.allowed) return deny(NOT_LISTED, 403);
  return { user: { email: hit.email } };
}
