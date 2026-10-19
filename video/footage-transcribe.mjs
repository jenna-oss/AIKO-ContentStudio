/* ---------------------------------------------------------------------------
 * A take's words, with the time each one was said.
 *
 *   node video/footage-transcribe.mjs <footage-id> <audio-file>
 *
 * The audio has already been pulled out of the video by ffmpeg in the
 * workflow — a twenty minute take is a few gigabytes of video and about ten
 * megabytes of mono speech, and only the speech is any use here.
 *
 * The word timings are the point. Without them a clip can only be cut at a
 * guess; with them it can be cut between sentences, and the captions can land
 * on the word. They are kept on the take so nothing is transcribed twice.
 * ------------------------------------------------------------------------ */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const SCRIBE = 'https://api.elevenlabs.io/v1/speech-to-text';
const MODEL = 'scribe_v1';

const [, , footageId, audioPath] = process.argv;
if (!footageId || !audioPath) {
  console.error('usage: footage-transcribe.mjs <footage-id> <audio-file>');
  process.exit(2);
}

const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const eleven = process.env.ELEVENLABS_API_KEY || '';
if (!base || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
if (!eleven) throw new Error('ELEVENLABS_API_KEY is not set');

async function rpc(fn, args) {
  const res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${fn} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function say(status, error) {
  await rpc('kb_footage_state', { p_id: footageId, p_status: status, p_error: error || null }).catch(() => {});
}

try {
  await say('transcribing', null);

  const audio = await readFile(audioPath);
  console.log(`sending ${(audio.length / 1e6).toFixed(1)}MB of audio to Scribe`);

  const form = new FormData();
  form.append('file', new Blob([audio]), basename(audioPath));
  form.append('model_id', MODEL);
  /* Word timings are what the cutting runs on. */
  form.append('timestamps_granularity', 'word');

  const res = await fetch(SCRIBE, {
    method: 'POST',
    headers: { 'xi-api-key': eleven },
    body: form,
  });
  if (!res.ok) throw new Error(`ElevenLabs answered ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const out = await res.json();
  const transcript = String(out.text || '').trim();
  if (!transcript) throw new Error('nothing was said in that take, or none of it came back');

  /* Keep the spoken words. Scribe also returns spacing entries, which are no
   * use for finding a sentence boundary. */
  const words = (Array.isArray(out.words) ? out.words : [])
    .filter((w) => (w.type ? w.type === 'word' : true) && String(w.text || '').trim())
    .map((w) => ({
      t: String(w.text).trim(),
      s: Number(w.start),
      e: Number(w.end),
    }))
    .filter((w) => Number.isFinite(w.s) && Number.isFinite(w.e));

  if (!words.length) throw new Error('the transcript came back with no word timings, so nothing can be cut from it');

  const seconds = words[words.length - 1].e;
  await rpc('kb_footage_ready', {
    p_id: footageId,
    p_transcript: transcript,
    p_words: words,
    p_seconds: Number(seconds.toFixed(2)),
  });

  console.log(`transcribed: ${words.length} words over ${Math.round(seconds / 60)} minutes`);
} catch (err) {
  const why = String(err?.message || err).slice(0, 400);
  console.error('transcribing failed:', why);
  await say('failed', why);
  process.exit(1);
}
