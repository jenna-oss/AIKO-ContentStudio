/* ---------------------------------------------------------------------------
 * Push data/content.json into Postgres via the content_upsert_docs RPC.
 *
 * The RPC owns the merge: a document is upserted by url, and its chunks are
 * replaced wholesale rather than merged, because chunk boundaries move whenever
 * a post is edited or the chunker changes.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment. The
 * service key bypasses RLS — CI secrets only, never a file or a commit.
 * ------------------------------------------------------------------------ */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* Documents carry their full body plus every chunk, so a batch of ten is
 * already a sizeable request. Keep it small rather than fast. */
const CHUNK = 8;

/* See push-supabase.mjs: a stored secret can carry a trailing newline or a BOM,
 * and the CI log masks the value so the damage is invisible. */
const env = (name) => {
  let v = String(process.env[name] ?? '').trim();
  if (v.charCodeAt(0) === 0xfeff) v = v.slice(1);   // UTF-8 BOM
  return v.trim();
};

const URL_BASE = env('SUPABASE_URL').replace(/\/+$/, '');
const KEY = env('SUPABASE_SERVICE_ROLE_KEY');

if (!URL_BASE || !KEY) {
  console.log('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping the content push.');
  process.exit(0);
}

/* Fail on a malformed URL here, with a message naming the cause, rather than
 * letting fetch report "Failed to parse URL" against a masked value. */
if (!URL.canParse(`${URL_BASE}/rest/v1/`)) {
  console.error('SUPABASE_URL is not a valid URL. Check the stored secret for stray whitespace.');
  process.exit(1);
}

const redact = (s) => String(s).split(KEY).join('[REDACTED]');

const corpus = JSON.parse(await readFile(join(ROOT, 'data', 'content.json'), 'utf8'));
const docs = corpus.docs || [];

if (!docs.length) {
  console.error('Content corpus is empty. Not pushing.');
  process.exit(1);
}

const batches = [];
for (let i = 0; i < docs.length; i += CHUNK) batches.push(docs.slice(i, i + CHUNK));

let written = 0;

for (const [i, batch] of batches.entries()) {
  const payload = batch.map((d) => ({ ...d, site: corpus.site }));

  let res;
  try {
    res = await fetch(`${URL_BASE}/rest/v1/rpc/content_upsert_docs`, {
      method: 'POST',
      headers: {
        apikey: KEY,
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ payload }),
    });
  } catch (err) {
    console.error(`Batch ${i + 1}/${batches.length} failed to send: ${redact(err.message)}`);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`Batch ${i + 1}/${batches.length} rejected (${res.status}): ${redact(await res.text())}`);
    process.exit(1);
  }

  written += Number(await res.json()) || 0;
  console.log(`Batch ${i + 1}/${batches.length} written (${batch.length} documents)`);
}

const chunks = docs.reduce((n, d) => n + (d.chunks?.length || 0), 0);
console.log(`Pushed ${written} documents · ${chunks} chunks`);
