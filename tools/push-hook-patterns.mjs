/* ---------------------------------------------------------------------------
 * Push data/hook-patterns.json into Postgres via hook_patterns_upsert.
 *
 * The RPC owns the merge and never clears the muted flag, so hand-curation of
 * creator-content noise survives a refresh.
 * ------------------------------------------------------------------------ */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHUNK = 100;

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
  console.log('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping the hook-pattern push.');
  process.exit(0);
}

if (!URL.canParse(`${URL_BASE}/rest/v1/`)) {
  console.error('SUPABASE_URL is not a valid URL. Check the stored secret for stray whitespace.');
  process.exit(1);
}

const redact = (s) => String(s).split(KEY).join('[REDACTED]');

let corpus;
try {
  corpus = JSON.parse(await readFile(join(ROOT, 'data', 'hook-patterns.json'), 'utf8'));
} catch {
  console.log('No data/hook-patterns.json — nothing to push.');
  process.exit(0);
}

const rows = corpus.rows || [];
if (!rows.length) {
  console.error('Hook-pattern payload is empty. Not pushing.');
  process.exit(1);
}

const batches = [];
for (let i = 0; i < rows.length; i += CHUNK) batches.push(rows.slice(i, i + CHUNK));

let written = 0;

for (const [i, batch] of batches.entries()) {
  let res;
  try {
    res = await fetch(`${URL_BASE}/rest/v1/rpc/hook_patterns_upsert`, {
      method: 'POST',
      headers: {
        apikey: KEY,
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ payload: batch }),
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
  console.log(`Batch ${i + 1}/${batches.length} merged (${batch.length} patterns)`);
}

console.log(`Pushed ${rows.length} patterns · ${written} rows written`);
