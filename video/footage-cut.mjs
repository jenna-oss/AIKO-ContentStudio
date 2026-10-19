/* ---------------------------------------------------------------------------
 * Cut the clips out of a take and put the brand on them.
 *
 *   node video/footage-cut.mjs <footage-id> <take-file>
 *
 * For each clip the picker chose: cut it out of the take, square it up to
 * 9:16, caption it with Remotion, and put it where the app can see it.
 *
 * The captions are the ones the made-from-scratch videos use — the same
 * component, fed the same way, from public/<slug>/captions.json — so a clip
 * out of a take and a video built from nothing caption identically. The words
 * come from the take's transcript, already rebased to the clip's own clock, so
 * nothing is transcribed twice.
 * ------------------------------------------------------------------------ */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { keptSegments, wordsFor, openingSentence } from './clip-edit.mjs';

/* `--edit <clip-id> <take-file>` re-cuts one clip that was edited in the app:
 * a new start and end, sections cut out of the middle, and words the
 * transcript got wrong. Everything else is the same cut, caption and store. */
const editing = process.argv[2] === '--edit';
const [footageId, takeFile] = editing ? [null, process.argv[4]] : process.argv.slice(2);
const editClipId = editing ? process.argv[3] : null;
if ((!footageId && !editClipId) || !takeFile) {
  console.error('usage: footage-cut.mjs <footage-id> <take-file>\n       footage-cut.mjs --edit <clip-id> <take-file>');
  process.exit(2);
}

const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!base || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');

const ROOT = new URL('./remotion/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PUBLIC = join(ROOT, 'public');

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

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT });

/* Captions.tsx groups words into lines by beat, so a beat here is a sentence:
 * the captions then break where the speaker did. */
function withBeats(words) {
  let beat = 1;
  return words.map((w, i) => {
    const out = { text: w.t, start: w.s, end: w.e, beat };
    const next = words[i + 1];
    if (/[.?!,;:]$/.test(w.t) || (next && next.s - w.e > 0.6)) beat += 1;
    return out;
  });
}

/* The guide puts the money in orange. Anything countable gets it. */
const emphasisIn = (words) => [
  ...new Set(
    words
      .map((w) => w.t)
      .filter((t) => /[$£€]|\d/.test(t))
      .map((t) => t.toLowerCase().replace(/^[^a-z0-9$]+|[^a-z0-9%]+$/g, ''))
      .filter(Boolean),
  ),
];

async function upload(path, file) {
  const body = readFileSync(file);
  const res = await fetch(`${base}/storage/v1/object/videos/${path}`, {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'video/mp4',
      'x-upsert': 'true',
      /* An edited clip replaces the file at the same path; a long cache would
       * keep showing the old cut. */
      'cache-control': 'max-age=60',
    },
    body,
  });
  if (!res.ok) throw new Error(`storing the clip answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return `${base}/storage/v1/object/public/videos/${path}`;
}

const vf = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30';

/* Cut the kept segments out of the take and join them into one 9:16 file. */
function cutSegments(segments, outFile) {
  if (segments.length === 1) {
    const [a, b] = segments[0];
    run('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(a), '-i', takeFile, '-t', String(b - a),
      '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outFile,
    ]);
    return;
  }
  const parts = segments.map(([a, b], i) =>
    `[0:v]trim=start=${a}:end=${b},setpts=PTS-STARTPTS,${vf}[v${i}];`
    + `[0:a]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS[a${i}];`).join('');
  const joins = segments.map((_, i) => `[v${i}][a${i}]`).join('');
  run('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', takeFile,
    '-filter_complex', `${parts}${joins}concat=n=${segments.length}:v=1:a=1[v][a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outFile,
  ]);
}

function captionAndRender(slug, dir, hook, seconds, words) {
  writeFileSync(join(dir, 'captions.json'), JSON.stringify({ words: withBeats(words) }));
  const out = join(ROOT, 'out', `${slug}.mp4`);
  mkdirSync(join(ROOT, 'out'), { recursive: true });
  console.log(`captioning ${slug}`);
  run('npx', [
    'remotion', 'render', 'Clip', out,
    '--props', JSON.stringify({ slug, hook: hook || '', seconds: Number(seconds.toFixed(2)), emphasis: emphasisIn(words) }),
    '--log', 'error',
  ]);
  return out;
}

if (editing) {
  const clip = await rpc('kb_clip_read', { p_id: editClipId });
  if (!clip || !clip.edit) throw new Error('no edit waiting on that clip');
  const take = await rpc('kb_footage_read', { p_id: clip.footage_id });
  const edit = clip.edit;
  const slug = `clip-${clip.id.slice(0, 8)}`;
  const dir = join(PUBLIC, slug);
  try {
    await rpc('kb_clip_edit_state', { p_id: clip.id, p_status: 'running', p_error: null });
    mkdirSync(dir, { recursive: true });
    const segments = keptSegments(Number(edit.start_s), Number(edit.end_s), (edit.cuts || []).map((c) => ({ from: Number(c.from), to: Number(c.to) })));
    if (!segments.length) throw new Error('nothing is left once the cut-out sections are removed');
    const seconds = segments.reduce((n, [a, b]) => n + (b - a), 0);
    console.log(`re-cutting ${slug}: ${segments.length} segment(s), ${seconds.toFixed(1)}s`);
    cutSegments(segments, join(dir, 'clip.mp4'));
    const words = wordsFor(Array.isArray(take?.words) ? take.words : [], segments, edit.fixes || []);
    /* The hook is the sentence it opens on; a new start, or a fixed word in
     * it, changes that sentence. */
    const sameStart = Number(edit.start_s) === Number(clip.start_s) && !(edit.fixes || []).length;
    const hook = sameStart ? clip.hook : (openingSentence(words) || clip.hook);
    const out = captionAndRender(slug, dir, hook, seconds, words);
    const url = await upload(`clips/${clip.id}.mp4`, out);
    await rpc('kb_clip_edit_done', { p_id: clip.id, p_words: words, p_url: url, p_bytes: statSync(out).size, p_hook: hook });
    console.log(`  done: ${url}`);
  } catch (err) {
    const why = String(err?.message || err).slice(0, 400);
    console.error(`  ${slug} edit failed:`, why);
    await rpc('kb_clip_edit_state', { p_id: clip.id, p_status: 'failed', p_error: why }).catch(() => {});
    process.exit(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(0);
}

const clips = (await rpc('kb_clips', { p_footage: footageId, p_limit: 100 })) || [];
const todo = clips.filter((c) => c.status === 'suggested' || c.status === 'failed');
console.log(`${todo.length} clip(s) to cut`);

let made = 0;
for (const row of todo) {
  const slug = `clip-${row.id.slice(0, 8)}`;
  const dir = join(PUBLIC, slug);
  const seconds = Number(row.end_s) - Number(row.start_s);

  try {
    await rpc('kb_clip_state', { p_id: row.id, p_status: 'rendering', p_url: null, p_bytes: null, p_error: null });
    mkdirSync(dir, { recursive: true });

    /* Cut, then square up to 9:16. Phone footage is usually vertical already,
     * in which case this only scales; landscape is centre-cropped, which is
     * where a person talking to camera generally is. */
    console.log(`cutting ${slug}: ${row.start_s}s for ${seconds.toFixed(1)}s`);
    run('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(row.start_s),
      '-i', takeFile,
      '-t', String(seconds),
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
      join(dir, 'clip.mp4'),
    ]);

    const full = await rpc('kb_clip_read', { p_id: row.id });
    const words = Array.isArray(full?.words) ? full.words : [];
    writeFileSync(join(dir, 'captions.json'), JSON.stringify({ words: withBeats(words) }));

    const out = join(ROOT, 'out', `${slug}.mp4`);
    mkdirSync(join(ROOT, 'out'), { recursive: true });
    console.log(`captioning ${slug}`);
    run('npx', [
      'remotion', 'render', 'Clip', out,
      '--props', JSON.stringify({
        slug,
        hook: row.hook || '',
        seconds: Number(seconds.toFixed(2)),
        emphasis: emphasisIn(words),
      }),
      '--log', 'error',
    ]);

    const url = await upload(`clips/${row.id}.mp4`, out);
    await rpc('kb_clip_state', {
      p_id: row.id, p_status: 'ready', p_url: url,
      p_bytes: statSync(out).size, p_error: null,
    });
    made += 1;
    console.log(`  done: ${url}`);
  } catch (err) {
    const why = String(err?.message || err).slice(0, 400);
    console.error(`  ${slug} failed:`, why);
    await rpc('kb_clip_state', {
      p_id: row.id, p_status: 'failed', p_url: null, p_bytes: null, p_error: why,
    }).catch(() => {});
  } finally {
    /* The cut copy is only an input to the render; the render is what is kept. */
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`${made} of ${todo.length} clip(s) made`);
if (!made && todo.length) process.exit(1);
