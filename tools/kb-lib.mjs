/* ---------------------------------------------------------------------------
 * Shared machinery for the content intelligence pipeline.
 *
 * Parsing, chunking and embedding live here so that the ingest step and the
 * process step cannot drift apart about what a chunk is. The HTML extraction
 * and prose chunker are lifted from tools/pull-content.mjs deliberately — the
 * two corpora should chunk the same way, or a passage retrieved from one will
 * read differently from a passage retrieved from the other.
 * ------------------------------------------------------------------------ */

import { createHash } from 'node:crypto';

/* Chunking lives in its own module because the Worker needs it too, and the
 * Worker has no node:crypto. Re-exported here so every existing caller of
 * kb-lib keeps working unchanged. */
export {
  estimateTokens, chunkProse, parseCues, parsePlainTranscript, chunkTranscript,
} from './kb-chunk.mjs';
import { estimateTokens } from './kb-chunk.mjs';

/* --- environment --------------------------------------------------------- */

/* Secrets arrive however the tool that stored them encoded the value. A stored
 * URL with a trailing newline or a UTF-8 BOM produces "Failed to parse URL",
 * with the offending characters invisible in the CI log because the value is
 * masked. Same defence as tools/push-supabase.mjs. */
export const env = (name) => {
  let v = String(process.env[name] ?? '').trim();
  if (v.charCodeAt(0) === 0xfeff) v = v.slice(1);
  return v.trim();
};

export const SUPABASE_URL = env('SUPABASE_URL').replace(/\/+$/, '');
export const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
export const VOYAGE_KEY = env('VOYAGE_API_KEY');

/* Never let a key reach a log line, even inside an echoed request URL. */
export const redact = (s) => {
  let out = String(s);
  for (const k of [SERVICE_KEY, VOYAGE_KEY]) if (k) out = out.split(k).join('[REDACTED]');
  return out;
};

export const sha256 = (s) => createHash('sha256').update(s ?? '', 'utf8').digest('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --- Supabase ------------------------------------------------------------ */

export async function rpc(fn, body) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.');
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn} failed (${res.status}): ${redact(text)}`);
  return text ? JSON.parse(text) : null;
}


/* --- HTML ---------------------------------------------------------------- */

/* The HTML-to-text helpers live in kb-web.mjs, which the Worker imports too;
 * they are re-exported here so every caller keeps its old import. */
export { decode, htmlToText, articleScope, metaFromHtml, isoOrNull } from './kb-web.mjs';

/* --- embeddings ---------------------------------------------------------- */

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

/* The model and dimension come from the database, never from a constant here.
 * If this read fails the caller stops: embedding at the provider's default
 * width would be rejected by the dimension guard anyway, and it is better to
 * say why up front than to fail one row at a time. */
export async function embeddingConfig() {
  const cfg = await rpc('kb_embedding_config', {});
  if (!cfg?.model || !cfg?.dimensions) {
    throw new Error('kb.embedding_config is unreadable or incomplete; cannot embed.');
  }
  return cfg;
}

/* Voyage caps a request at 128 inputs and a total token count; batching by both
 * keeps a long research report from tripping the second limit while sitting
 * well inside the first. */
export async function embed(texts, { inputType = 'document', model, dimensions } = {}) {
  if (!VOYAGE_KEY) throw new Error('VOYAGE_API_KEY is not set.');
  if (!texts.length) return [];

  const out = [];
  let batch = [];
  let batchTokens = 0;

  const flush = async () => {
    if (!batch.length) return;
    const vectors = await voyageCall(batch, { inputType, model, dimensions });
    out.push(...vectors);
    batch = [];
    batchTokens = 0;
  };

  for (const t of texts) {
    const tk = estimateTokens(t);
    if (batch.length >= 96 || batchTokens + tk > 100000) await flush();
    batch.push(t);
    batchTokens += tk;
  }
  await flush();

  if (out.length !== texts.length) {
    throw new Error(`embedding count mismatch: asked for ${texts.length}, got ${out.length}`);
  }
  return out;
}

async function voyageCall(input, { inputType, model, dimensions }, attempt = 0) {
  let res;
  try {
    res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${VOYAGE_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input,
        model,
        input_type: inputType,
        output_dimension: dimensions,
        truncation: true,
      }),
    });
  } catch (err) {
    if (attempt < 4) {
      await sleep(2 ** attempt * 1000);
      return voyageCall(input, { inputType, model, dimensions }, attempt + 1);
    }
    throw new Error(`Voyage unreachable: ${redact(err.message)}`);
  }

  /* Rate limits and 5xx are worth waiting out; a 400 means the request itself
   * is wrong and retrying it just spends the quota more slowly. */
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await sleep(2 ** attempt * 1500);
    return voyageCall(input, { inputType, model, dimensions }, attempt + 1);
  }
  if (!res.ok) throw new Error(`Voyage error ${res.status}: ${redact(await res.text())}`);

  const json = await res.json();
  return json.data
    .sort((a, b) => a.index - b.index)
    .map((d) => `[${d.embedding.join(',')}]`);
}


/* What a hook is embedded as. One shape for the backfill and the seed, so a
 * hook embedded on arrival and one embedded later sit in the same place. The
 * category is spelled out because "cost_of_waiting" is a label, and the words
 * in it are what a query like "hooks about waiting too long" should meet. */
export function hookText(h) {
  return [
    String(h.category || '').replace(/_/g, ' '),
    h.template,
    h.example,
    (h.topics || []).join(', '),
  ].filter(Boolean).join(' — ');
}
