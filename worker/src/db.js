/* ---------------------------------------------------------------------------
 * Supabase access for the Worker.
 *
 * Read with the anon key and nothing else. Every corpus is reached through a
 * SECURITY INVOKER wrapper in the public schema, so RLS stays in the path and
 * this route physically cannot rewrite a corpus even if something goes wrong.
 * ------------------------------------------------------------------------ */

const RPC_TIMEOUT_MS = 12000;

export async function rpc(env, fn, args) {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) {
    /* The response body can echo the request. Never let it reach the page. */
    throw new Error(`${fn} returned ${res.status}`);
  }
  return res.json();
}

export const clamp = (n, def, max) => Math.min(Math.max(Number(n) || def, 1), max);
