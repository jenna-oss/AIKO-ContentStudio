/* ---------------------------------------------------------------------------
 * Stage 4 — push the harvested corpus into Postgres so agents can retrieve
 * against it instead of being handed the whole thing in a prompt.
 *
 * Reads data/ads-load.json (written by to-sql.mjs) and calls the
 * adspy_upsert_ads RPC, which owns the merge rules: first_seen is never
 * overwritten and last_seen only moves forward.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment. The
 * service key bypasses RLS, so it belongs in CI secrets and nowhere else —
 * never in a file, a commit, or a log line.
 * ------------------------------------------------------------------------ */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHUNK = 200;

/* Secrets arrive however the tool that stored them encoded the value. A stored
 * URL with a trailing newline or a UTF-8 BOM produces "Failed to parse URL",
 * with the offending characters invisible in the CI log because the value is
 * masked. Strip both rather than trust the storage path. */
const env = (name) => {
  let v = String(process.env[name] ?? '').trim();
  if (v.charCodeAt(0) === 0xfeff) v = v.slice(1);   // UTF-8 BOM
  return v.trim();
};

const URL_BASE = env('SUPABASE_URL').replace(/\/+$/, '');
const KEY = env('SUPABASE_SERVICE_ROLE_KEY');

if (!URL_BASE || !KEY) {
  console.log('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping the database push.');
  process.exit(0);
}

/* Fail on a malformed URL here, with a message naming the cause, rather than
 * letting fetch report "Failed to parse URL" against a value the log masks. */
if (!URL.canParse(`${URL_BASE}/rest/v1/`)) {
  console.error('SUPABASE_URL is not a valid URL. Check the stored secret for stray whitespace.');
  process.exit(1);
}

/* A failed request echoes the URL and sometimes the headers. Scrub the key out
 * of anything we print, so a CI log can never leak it. */
const redact = (s) => String(s).split(KEY).join('[REDACTED]');

const rows = JSON.parse(await readFile(join(ROOT, 'data', 'ads-load.json'), 'utf8'));
if (!Array.isArray(rows) || !rows.length) {
  console.error('Load payload is empty. Not pushing.');
  process.exit(1);
}

const chunks = [];
for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK));

let merged = 0;

for (const [i, chunk] of chunks.entries()) {
  let res;
  try {
    res = await fetch(`${URL_BASE}/rest/v1/rpc/adspy_upsert_ads`, {
      method: 'POST',
      headers: {
        apikey: KEY,
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ payload: chunk }),
    });
  } catch (err) {
    console.error(`Chunk ${i + 1}/${chunks.length} failed to send: ${redact(err.message)}`);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`Chunk ${i + 1}/${chunks.length} rejected (${res.status}): ${redact(await res.text())}`);
    process.exit(1);
  }

  merged += Number(await res.json()) || 0;
  console.log(`Chunk ${i + 1}/${chunks.length} merged (${chunk.length} ads)`);
}

console.log(`Pushed ${rows.length} ads in ${chunks.length} chunks · ${merged} rows written`);
