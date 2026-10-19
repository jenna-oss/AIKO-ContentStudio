/* ---------------------------------------------------------------------------
 * /recordings/* — voice recordings on the Recordings page.
 *
 * Upload an audio file with a name; it goes into the private `kb-recordings`
 * bucket — `recordings` is another AIKO tool's, and public —, ElevenLabs
 * transcribes it, and the transcript is both kept on the
 * recording and ingested into the knowledge base as a document. So a planning
 * session can find a passage by searching, and can also be pointed at one
 * recording and read the whole thing.
 *
 * Transcribing happens after the answer goes out (ctx.waitUntil), the way an
 * upload's embedding does: a ten-minute recording takes tens of seconds and
 * nobody should hold a request open for it. The row says 'transcribing' until
 * it lands, and the page polls. A run that dies leaves it there, so /retry
 * starts again from the stored audio rather than asking for the file twice.
 *
 * Only a signed-in person on the app's list reaches any of this: index.js
 * gates every route.
 * ------------------------------------------------------------------------ */

import { rpc } from './db.js';
import { ingestText } from './upload.js';

const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const SCRIBE_MODEL = 'scribe_v1';
const MAX_BYTES = 40 * 1024 * 1024;
const MIN_BYTES = 2000;
const MAX_NAME = 120;

/* What a phone or a laptop actually produces. The extension is only for the
 * stored file's name; what matters to ElevenLabs is the bytes. */
const KINDS = new Map([
  ['audio/mpeg', 'mp3'], ['audio/mp3', 'mp3'], ['audio/mp4', 'm4a'], ['audio/x-m4a', 'm4a'],
  ['audio/aac', 'aac'], ['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/webm', 'webm'],
  ['audio/ogg', 'ogg'], ['audio/flac', 'flac'], ['audio/x-flac', 'flac'], ['video/mp4', 'mp4'],
  ['video/webm', 'webm'], ['video/quicktime', 'mov'],
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const base = (env) => env.SUPABASE_URL.replace(/\/+$/, '');

const json = (obj, status, headers) => new Response(JSON.stringify(obj), {
  status, headers: { ...headers, 'content-type': 'application/json' },
});

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

/* The bucket is private and the Worker's key is the only one that reaches it. */
async function storage(env, method, path, init = {}) {
  return fetch(`${base(env)}/storage/v1/object/kb-recordings/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      ...(init.headers || {}),
    },
    body: init.body,
    signal: AbortSignal.timeout(init.timeout ?? 60000),
  });
}

async function transcribe(env, bytes, filename) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);
  form.append('model_id', SCRIBE_MODEL);
  const res = await fetch(SCRIBE_URL, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
    body: form,
    signal: AbortSignal.timeout(280000),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const out = await res.json();
  const text = String(out.text || '').trim();
  if (!text) throw new Error('the recording came back with no words in it');
  /* The word timings give the length without decoding the audio here. */
  const words = Array.isArray(out.words) ? out.words : [];
  const last = words.length ? Number(words[words.length - 1].end) : null;
  return { text, seconds: Number.isFinite(last) ? Math.round(last) : null };
}

/* Transcribe, then put the transcript in the corpus and mark the recording
 * ready. Anything that goes wrong is written on the recording, where the page
 * shows it, rather than lost in a log. */
async function finish(env, ctx, { id, name, path, bytes }) {
  try {
    const { text, seconds } = await transcribe(env, bytes, path);
    let documentId = null;
    try {
      const stored = await ingestText(env, null, {
        sourceKey: `recording:${id}`,
        title: name,
        text,
        documentType: 'recording',
      });
      documentId = stored.documentId;
    } catch (err) {
      console.error('recording ingest failed:', err?.message);
    }
    await rpc(env, 'kb_recording_ready', {
      p_id: id, p_transcript: text, p_seconds: seconds, p_document_id: documentId,
    });
  } catch (err) {
    console.error('recording transcription failed:', err?.message);
    try { await rpc(env, 'kb_recording_failed', { p_id: id, p_error: String(err?.message || err) }); }
    catch { /* the page shows it as still transcribing, and /retry can run again */ }
  }
}

export async function handleRecordings(path, request, env, headers, ctx, user) {
  if (path === '/recordings') {
    if (!env.ELEVENLABS_API_KEY) {
      return json({
        error: 'Recordings aren’t set up yet: the Worker needs its ElevenLabs key.',
        hint: 'From the worker folder: npx wrangler secret put ELEVENLABS_API_KEY',
      }, 503, headers);
    }

    let form;
    try { form = await request.formData(); }
    catch { return json({ error: 'send the recording as a form with a file and a name' }, 400, headers); }

    const file = form.get('file');
    const name = String(form.get('name') ?? '').trim().slice(0, MAX_NAME);
    if (!file || typeof file === 'string') return json({ error: 'no file was attached' }, 400, headers);
    if (!name) return json({ error: 'give the recording a name' }, 400, headers);

    /* A browser recording arrives as audio/webm;codecs=opus. The codec is
     * not our business; the container is. */
    const kind = KINDS.get(String(file.type || '').toLowerCase().split(';')[0].trim());
    if (!kind) {
      return json({
        error: `${file.type || 'that file'} isn’t audio this can read.`,
        hint: 'mp3, m4a, wav, webm, ogg, flac, or the audio in an mp4 or mov.',
      }, 415, headers);
    }
    if (file.size < MIN_BYTES) return json({ error: 'that file is too small to be a recording' }, 400, headers);
    if (file.size > MAX_BYTES) {
      return json({
        error: `That recording is ${(file.size / 1024 / 1024).toFixed(0)}MB, over the ${MAX_BYTES / 1024 / 1024}MB limit.`,
      }, 413, headers);
    }

    const bytes = await file.arrayBuffer();
    const storagePath = `${crypto.randomUUID()}.${kind}`;
    const put = await storage(env, 'POST', storagePath, {
      headers: { 'content-type': file.type, 'x-upsert': 'true' },
      body: bytes,
    });
    if (!put.ok) {
      console.error('recording upload failed:', put.status, (await put.text()).slice(0, 200));
      return json({ error: 'Couldn’t store that recording. Try again.' }, 502, headers);
    }

    let id;
    try {
      id = await rpc(env, 'kb_recording_create', {
        p_name: name, p_storage_path: storagePath, p_bytes: file.size, p_email: user?.email || null,
      });
    } catch {
      return json({ error: 'Couldn’t save that recording. Try again.' }, 502, headers);
    }

    ctx.waitUntil(finish(env, ctx, { id, name, path: storagePath, bytes }));
    return json({ id, name, status: 'transcribing' }, 202, headers);
  }

  if (path === '/recordings/list') {
    try {
      const rows = await rpc(env, 'kb_recordings', { p_limit: 100 });
      return json({ recordings: rows || [] }, 200, headers);
    } catch {
      return json({ error: 'could not load the recordings' }, 502, headers);
    }
  }

  const body = await readBody(request);
  const id = String(body?.id ?? '');
  if (!UUID.test(id)) return json({ error: 'id must be a recording id' }, 400, headers);

  if (path === '/recordings/read') {
    try {
      const rec = await rpc(env, 'kb_recording_read', { p_id: id });
      if (!rec) return json({ error: 'no recording with that id' }, 404, headers);
      delete rec.storage_path;
      return json({ recording: rec }, 200, headers);
    } catch {
      return json({ error: 'could not load that recording' }, 502, headers);
    }
  }

  if (path === '/recordings/rename') {
    const name = String(body?.name ?? '').trim().slice(0, MAX_NAME);
    if (!name) return json({ error: 'give the recording a name' }, 400, headers);
    try {
      const ok = await rpc(env, 'kb_recording_rename', { p_id: id, p_name: name });
      if (!ok) return json({ error: 'no recording with that id' }, 404, headers);
      return json({ name }, 200, headers);
    } catch {
      return json({ error: 'could not rename that recording' }, 502, headers);
    }
  }

  if (path === '/recordings/delete') {
    let out;
    try { out = await rpc(env, 'kb_recording_delete', { p_id: id }); }
    catch { return json({ error: 'could not delete that recording' }, 502, headers); }
    if (!out?.ok) return json({ error: 'no recording with that id' }, 404, headers);
    if (out.storage_path) {
      ctx.waitUntil(storage(env, 'DELETE', out.storage_path).catch(() => {}));
    }
    return json({ deleted: true }, 200, headers);
  }

  /* The audio itself, for the player. The bucket is private, so it comes back
   * through here rather than as a link the browser could hand around. */
  if (path === '/recordings/audio') {
    let rec;
    try { rec = await rpc(env, 'kb_recording_read', { p_id: id }); }
    catch { return json({ error: 'could not load that recording' }, 502, headers); }
    if (!rec?.storage_path) return json({ error: 'that recording has no audio' }, 404, headers);
    const got = await storage(env, 'GET', rec.storage_path);
    if (!got.ok) return json({ error: 'could not fetch that audio' }, 502, headers);
    return new Response(got.body, {
      status: 200,
      headers: {
        ...headers,
        'content-type': got.headers.get('content-type') || 'audio/mpeg',
        'cache-control': 'no-store',
      },
    });
  }

  /* Transcribing again, for a recording whose first attempt died. */
  if (path === '/recordings/retry') {
    if (!env.ELEVENLABS_API_KEY) return json({ error: 'the Worker needs its ElevenLabs key' }, 503, headers);
    let rec;
    try { rec = await rpc(env, 'kb_recording_read', { p_id: id }); }
    catch { return json({ error: 'could not load that recording' }, 502, headers); }
    if (!rec?.storage_path) return json({ error: 'that recording has no audio to read' }, 404, headers);
    if (rec.status === 'ready') return json({ status: 'ready' }, 200, headers);

    const got = await storage(env, 'GET', rec.storage_path);
    if (!got.ok) return json({ error: 'could not fetch that audio' }, 502, headers);
    const bytes = await got.arrayBuffer();
    ctx.waitUntil(finish(env, ctx, { id, name: rec.name, path: rec.storage_path, bytes }));
    return json({ status: 'transcribing' }, 202, headers);
  }

  return json({ error: 'unknown recordings route' }, 404, headers);
}
