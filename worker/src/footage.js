/* ---------------------------------------------------------------------------
 * /footage/* — raw takes, before they are cut into shorts.
 *
 * A take is gigabytes, and Cloudflare caps a request body at 100MB, so unlike
 * every other upload here the bytes never pass through this Worker. Instead it
 * signs an upload and the browser sends the file straight to storage, in
 * resumable chunks it can pick up again if the connection drops. The signature
 * is what stands in for a key: the browser is never given the anon key, which
 * would let it call every kb_* function directly and walk round the sign-in
 * gate entirely.
 *
 * Once the bytes are there, the cutting happens in GitHub Actions, because
 * ffmpeg and Remotion cannot run in a Worker.
 * ------------------------------------------------------------------------ */

import { rpc } from './db.js';
import { dispatchWorkflow } from './github.js';

/* The direct storage hostname, which is markedly faster for large files than
 * going through the API gateway. */
const storageHost = (env) => env.SUPABASE_URL.replace('.supabase.co', '.storage.supabase.co').replace(/\/+$/, '');
const BUCKET = 'kb-footage';

/* Five gigabytes is the bucket's own limit; anything larger is a mistake. */
const MAX_BYTES = 5 * 1024 * 1024 * 1024;
const MIN_BYTES = 100 * 1024;

const KINDS = new Map([
  ['video/mp4', 'mp4'], ['video/quicktime', 'mov'], ['video/x-matroska', 'mkv'],
  ['video/webm', 'webm'], ['audio/mpeg', 'mp3'], ['audio/mp4', 'm4a'],
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (obj, status, headers) => new Response(JSON.stringify(obj), {
  status, headers: { ...headers, 'content-type': 'application/json' },
});

const str = (v, max) => String(v ?? '').trim().slice(0, max);

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

/* A token the browser can upload with, and nothing else. It is good for two
 * hours and for this one path. */
async function signUpload(env, path) {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/upload/sign/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      'content-type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`storage would not sign the upload (${res.status})`);
  const out = await res.json().catch(() => ({}));
  /* It comes back as a url with the token on it; the resumable upload wants
   * the token by itself, in a header. */
  const token = String(out.url || '').match(/[?&]token=([^&]+)/)?.[1];
  if (!token) throw new Error('storage signed the upload but returned no token');
  return decodeURIComponent(token);
}

export async function handleFootage(path, request, env, headers, ctx, user) {
  if (path === '/footage/list') {
    try {
      const rows = await rpc(env, 'kb_footage', { p_limit: 100 });
      return json({ footage: rows || [] }, 200, headers);
    } catch {
      return json({ error: 'could not load the footage' }, 502, headers);
    }
  }

  const body = await readBody(request);
  if (!body) return json({ error: 'body must be JSON' }, 400, headers);

  /* Ask to upload: this makes the row and signs the place to put it. The file
   * itself goes straight from the browser to storage. */
  if (path === '/footage/start') {
    const kind = KINDS.get(str(body.content_type, 100).toLowerCase().split(';')[0]);
    if (!kind) {
      return json({
        error: `${body.content_type || 'that file'} isn’t video this can read.`,
        hint: 'mp4, mov, mkv or webm — what a phone or a camera gives you.',
      }, 415, headers);
    }
    const bytes = Number(body.bytes);
    if (!Number.isFinite(bytes) || bytes < MIN_BYTES) {
      return json({ error: 'that file is too small to be a take' }, 400, headers);
    }
    if (bytes > MAX_BYTES) {
      return json({
        error: `That take is ${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB, over the ${MAX_BYTES / 1024 / 1024 / 1024}GB limit.`,
      }, 413, headers);
    }

    const name = str(body.name, 200) || 'Untitled take';
    const storagePath = `${crypto.randomUUID()}.${kind}`;

    let token;
    try { token = await signUpload(env, storagePath); }
    catch (err) {
      console.error('footage: signing failed:', err?.message);
      return json({ error: 'Couldn’t start that upload. Try again.' }, 502, headers);
    }

    let id;
    try {
      id = await rpc(env, 'kb_footage_create', {
        p_name: name, p_path: storagePath, p_bytes: bytes, p_email: user?.email || null,
      });
    } catch {
      return json({ error: 'Couldn’t save that take. Try again.' }, 502, headers);
    }

    return json({
      id,
      path: storagePath,
      bucket: BUCKET,
      token,
      endpoint: `${storageHost(env)}/storage/v1/upload/resumable`,
    }, 200, headers);
  }

  const id = str(body.id, 64);
  if (!UUID.test(id)) return json({ error: 'id must be a footage id' }, 400, headers);

  /* The browser says the bytes are all there. Transcribing and cutting happen
   * in GitHub Actions; this is where that gets started. */
  if (path === '/footage/uploaded') {
    try {
      const ok = await rpc(env, 'kb_footage_state', { p_id: id, p_status: 'uploaded', p_error: null });
      if (!ok) return json({ error: 'no take with that id' }, 404, headers);
    } catch {
      return json({ error: 'could not mark that take' }, 502, headers);
    }

    /* Transcribing and cutting happen in GitHub Actions; this is the only
     * thing that starts them. A take whose run could not be started says so
     * rather than sitting on 'uploaded' with nothing coming. */
    const started = await dispatchWorkflow(env, 'cut-footage.yml', { footage_id: id }, 'the cutting');
    if (!started.ok) {
      await rpc(env, 'kb_footage_state', { p_id: id, p_status: 'failed', p_error: started.error }).catch(() => {});
      return json({ error: started.error }, 502, headers);
    }
    return json({ status: 'uploaded' }, 202, headers);
  }

  /* Run it again from the file already in storage. A take that failed for a
   * passing reason — a billing hiccup at the transcriber, a flaky minute —
   * should not mean uploading gigabytes a second time. */
  if (path === '/footage/retry') {
    let take;
    try { take = await rpc(env, 'kb_footage_read', { p_id: id }); }
    catch { return json({ error: 'could not load that take' }, 502, headers); }
    if (!take) return json({ error: 'no take with that id' }, 404, headers);
    if (take.status === 'transcribing') return json({ status: 'transcribing' }, 200, headers);

    try { await rpc(env, 'kb_footage_state', { p_id: id, p_status: 'uploaded', p_error: null }); }
    catch { return json({ error: 'could not mark that take' }, 502, headers); }

    const again = await dispatchWorkflow(env, 'cut-footage.yml', { footage_id: id }, 'the cutting');
    if (!again.ok) {
      await rpc(env, 'kb_footage_state', { p_id: id, p_status: 'failed', p_error: again.error }).catch(() => {});
      return json({ error: again.error }, 502, headers);
    }
    return json({ status: 'uploaded' }, 202, headers);
  }

  if (path === '/footage/read') {
    try {
      const take = await rpc(env, 'kb_footage_read', { p_id: id });
      if (!take) return json({ error: 'no take with that id' }, 404, headers);
      /* The words are for the agent that picks the clips, not for the page:
       * twenty minutes of talking is a couple of hundred kilobytes of them. */
      const { words, storage_path: where, ...rest } = take;
      return json({ footage: { ...rest, has_words: Array.isArray(words) && words.length > 0 } }, 200, headers);
    } catch {
      return json({ error: 'could not load that take' }, 502, headers);
    }
  }

  if (path === '/footage/failed') {
    try {
      await rpc(env, 'kb_footage_state', { p_id: id, p_status: 'failed', p_error: str(body.error, 400) || 'the upload did not finish' });
      return json({ status: 'failed' }, 200, headers);
    } catch {
      return json({ error: 'could not mark that take' }, 502, headers);
    }
  }

  if (path === '/footage/delete') {
    let out;
    try { out = await rpc(env, 'kb_footage_delete', { p_id: id }); }
    catch { return json({ error: 'could not delete that take' }, 502, headers); }
    if (!out?.ok) return json({ error: 'no take with that id' }, 404, headers);

    if (out.storage_path) {
      ctx.waitUntil(fetch(`${env.SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/${BUCKET}/${out.storage_path}`, {
        method: 'DELETE',
        headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
      }).catch(() => {}));
    }
    return json({ deleted: true }, 200, headers);
  }

  return json({ error: 'unknown footage route' }, 404, headers);
}
