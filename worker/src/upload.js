/* ---------------------------------------------------------------------------
 * /kb/upload — put a file into the knowledge base from the planner page.
 *
 * Distinct from attaching a file to a brief. An attachment is read once, by the
 * model, for one conversation. This is permanent: the document is chunked,
 * embedded, and retrievable by every future planning session.
 *
 * Two things this route is careful about.
 *
 * It is a WRITE endpoint on a public URL. The CORS allowlist in index.js stops
 * browsers and nothing else — curl sends whatever Origin it likes — so it sits
 * behind sign-in: index.js lets only a signed-in person on the app's list reach
 * any route. Without that, anyone who found this URL could put text into the
 * corpus the planner cites and is instructed to trust, which would quietly
 * defeat every traceability guarantee in the system.
 *
 * It answers before the work is done. Spec sections 12 and 40 want ingestion
 * asynchronous, and the user should not sit watching a spinner while an
 * embedding API is called. The document is written as 'pending', the response
 * goes out, and chunking and embedding continue under ctx.waitUntil.
 * ------------------------------------------------------------------------ */

import { rpc } from './db.js';
import {
  estimateTokens, chunkProse, parseCues, parsePlainTranscript, chunkTranscript,
} from '../../tools/kb-chunk.mjs';

/* Text only. PDFs and Word documents need real parsers — pdf-parse and mammoth
 * are Node libraries and do not run in a Worker — so they keep going through
 * kb/files/, where the Actions runner has them. Accepting a PDF here and
 * extracting a plausible-looking fraction of it would be worse than refusing
 * it: the gaps would be invisible and the citations would still look sound. */
const ACCEPTED = /\.(txt|md|markdown|vtt|srt|json|csv|tsv)$/i;

const TRANSCRIPT_EXT = /\.(vtt|srt)$/i;
const MAX_CHARS = 500000;
const MIN_CHARS = 40;
const MAX_CHUNKS = 400;

const DOCUMENT_TYPES = new Set([
  'transcript', 'research', 'article', 'report', 'recording', 'interview', 'other',
]);

function chunksFor({ name, text, documentType, topics, source }) {
  if (TRANSCRIPT_EXT.test(name) || documentType === 'transcript' || documentType === 'interview' || documentType === 'recording') {
    let cues = parseCues(text);
    if (cues.length < 2) cues = parsePlainTranscript(text);
    if (cues.length) {
      return chunkTranscript(cues).map((c, i) => ({
        chunk_index: i,
        heading: null,
        content: c.text,
        token_count: estimateTokens(c.text),
        metadata: {
          ...(c.speaker ? { speaker: c.speaker } : {}),
          ...(c.speakers?.length > 1 ? { speakers: c.speakers } : {}),
          ...(c.start !== null ? { start_time: c.start } : {}),
          ...(c.end !== null ? { end_time: c.end } : {}),
          ...(topics?.length ? { topics } : {}),
        },
      }));
    }
    /* A file named .vtt that parses as neither cues nor speaker turns is just
     * prose. Fall through rather than fail — the text is still worth having. */
  }

  return chunkProse(text).map((p, i) => ({
    chunk_index: i,
    heading: p.heading || null,
    content: p.text,
    token_count: estimateTokens(p.text),
    metadata: {
      ...(topics?.length ? { topics } : {}),
      ...(source ? { source } : {}),
    },
  }));
}

async function embedChunks(env, chunks, cfg) {
  const inputs = chunks.map((c) => [c.heading, c.content].filter(Boolean).join('\n'));
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.VOYAGE_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      input: inputs,
      model: cfg.model,
      input_type: 'document',
      output_dimension: cfg.dimensions,
      truncation: true,
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`voyage ${res.status}`);
  const json = await res.json();
  const vectors = json.data.sort((a, b) => a.index - b.index).map((d) => `[${d.embedding.join(',')}]`);
  if (vectors.length !== chunks.length) throw new Error('embedding count mismatch');
  chunks.forEach((c, i) => { c.embedding = vectors[i]; });
}

/* Text into the corpus: store the document, chunk it, and embed after the
 * caller has been answered. Shared with the recordings route, whose text comes
 * from a transcription rather than a file. Returns what was stored, or throws
 * with a message worth showing. */
export async function ingestText(env, ctx, {
  sourceKey, title, text, documentType = 'other', source = null, topics = [],
  sourceUrl = null, publishedAt = null, metadata = {},
}) {
  const created = await rpc(env, 'kb_upload_document', {
    payload: {
      brand_slug: 'trilith',
      document_type: documentType,
      title,
      source,
      source_url: sourceUrl,
      published_at: publishedAt,
      source_key: sourceKey,
      raw_content: text,
      metadata: { original_filename: sourceKey, ...(topics.length ? { topics } : {}), ...metadata },
    },
  });
  if (!created.changed) return { documentId: created.id, chunks: 0, unchanged: true };

  const chunks = chunksFor({ name: sourceKey, text, documentType, topics, source });
  if (!chunks.length) throw new Error('no usable chunks');
  if (chunks.length > MAX_CHUNKS) throw new Error(`${chunks.length} chunks, over the ${MAX_CHUNKS} limit`);

  const store = (async () => {
    let cfg = null;
    if (env.VOYAGE_API_KEY) {
      try { cfg = await rpc(env, 'kb_embedding_config', {}); } catch { cfg = null; }
    }
    if (cfg?.model) {
      try { await embedChunks(env, chunks, cfg); } catch { /* store unembedded */ }
    }
    try {
      await rpc(env, 'kb_upload_chunks', { p_document_id: created.id, payload: chunks });
    } catch { /* the document stays 'pending'; the next pipeline run picks it up */ }
  })();
  if (ctx?.waitUntil) ctx.waitUntil(store); else await store;

  return {
    documentId: created.id,
    chunks: chunks.length,
    tokens: chunks.reduce((n, c) => n + c.token_count, 0),
    unchanged: false,
  };
}

export async function handleUpload(request, env, headers, ctx) {
  /* Who may upload was settled before this runs: index.js lets only a
   * signed-in person on the app's list through. */

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'body must be JSON' }, 400, headers); }

  const name = String(body.name || '').trim();
  const text = String(body.text || '');
  const documentType = DOCUMENT_TYPES.has(body.document_type) ? body.document_type : 'other';

  if (!name) return json({ error: 'name is required' }, 400, headers);
  if (!ACCEPTED.test(name)) {
    return json({
      error: `${name}: only text files can be uploaded here.`,
      hint: 'Accepted: .txt .md .vtt .srt .json .csv .tsv — PDFs and Word documents go in kb/files/, where the pipeline has real parsers for them.',
    }, 415, headers);
  }
  if (text.trim().length < MIN_CHARS) {
    return json({ error: `${name} is empty or too short to be worth retrieving.` }, 400, headers);
  }
  if (text.length > MAX_CHARS) {
    return json({
      error: `${name} is too large (${text.length.toLocaleString()} characters, limit ${MAX_CHARS.toLocaleString()}).`,
    }, 413, headers);
  }

  const topics = Array.isArray(body.topics)
    ? body.topics.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
    : [];

  let created;
  try {
    created = await rpc(env, 'kb_upload_document', {
      payload: {
        brand_slug: 'trilith',
        document_type: documentType,
        title: body.title || name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim(),
        source: body.source || null,
        published_at: body.published_at || null,
        source_key: name,
        raw_content: text,
        metadata: {
          original_filename: name,
          ...(topics.length ? { topics } : {}),
        },
      },
    });
  } catch (err) {
    return json({ error: 'Could not store the document.', detail: String(err.message) }, 502, headers);
  }

  /* Already have it, byte for byte. Nothing to re-chunk and nothing to
   * re-embed — say so rather than silently doing the work again. */
  if (!created.changed) {
    return json({
      status: 'unchanged',
      document_id: created.id,
      message: `${name} is already in the knowledge base, unchanged.`,
    }, 200, headers);
  }

  let chunks;
  try {
    chunks = chunksFor({ name, text, documentType, topics, source: body.source });
  } catch (err) {
    return json({ error: `Could not chunk ${name}.`, detail: String(err.message) }, 422, headers);
  }

  if (!chunks.length) {
    return json({ error: `${name} produced no usable chunks.` }, 422, headers);
  }
  if (chunks.length > MAX_CHUNKS) {
    return json({
      error: `${name} produced ${chunks.length} chunks, over the ${MAX_CHUNKS} limit. Split it up.`,
    }, 413, headers);
  }

  /* Embed and store after responding. The caller learns the document was
   * accepted and how many chunks it became; it does not wait on Voyage. */
  ctx.waitUntil((async () => {
    let cfg = null;
    if (env.VOYAGE_API_KEY) {
      try { cfg = await rpc(env, 'kb_embedding_config', {}); } catch { cfg = null; }
    }
    if (cfg?.model) {
      try { await embedChunks(env, chunks, cfg); } catch { /* store unembedded */ }
    }
    try {
      await rpc(env, 'kb_upload_chunks', { p_document_id: created.id, payload: chunks });
    } catch { /* the document stays 'pending'; the next pipeline run picks it up */ }
  })());

  return json({
    status: 'queued',
    document_id: created.id,
    chunks: chunks.length,
    tokens: chunks.reduce((n, c) => n + c.token_count, 0),
    embedding: Boolean(env.VOYAGE_API_KEY),
    message: `${name} accepted — ${chunks.length} chunks. Searchable in a few seconds.`,
  }, 202, headers);
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...headers, 'content-type': 'application/json' },
  });
}
