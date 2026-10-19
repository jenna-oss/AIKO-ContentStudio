/* ---------------------------------------------------------------------------
 * Stage 2 — chunk and embed whatever ingestion queued.
 *
 * This is the asynchronous half of the pipeline (spec sections 12 and 40).
 * Nothing upstream waits for it: a document is uploaded and returns, and this
 * step turns it into retrievable chunks on its own schedule.
 *
 * Transcripts and prose are chunked differently on purpose (spec section 13).
 * A transcript is broken at speaker changes and pauses, keeping the speaker and
 * the timestamps, so a retrieved passage can be cited to the second. Research
 * is broken at headings and paragraphs, so a finding is not split down the
 * middle.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. VOYAGE_API_KEY is optional:
 * without it, chunks are stored unembedded and retrieval runs keyword-only,
 * reporting itself as degraded. Run this again once the key exists and the
 * backfill picks them up.
 * ------------------------------------------------------------------------ */

import {
  SUPABASE_URL, SERVICE_KEY, VOYAGE_KEY, rpc, redact,
  estimateTokens, chunkProse, parseCues, parsePlainTranscript, chunkTranscript,
  embed, embeddingConfig,
} from './kb-lib.mjs';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.log('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping processing.');
  process.exit(0);
}

const TRANSCRIPT_TYPES = new Set(['transcript', 'recording', 'interview']);
const BATCH = Number(process.env.KB_BATCH || 25);

let cfg = null;
if (VOYAGE_KEY) {
  cfg = await embeddingConfig();
  console.log(`Embedding with ${cfg.provider}/${cfg.model} at ${cfg.dimensions} dimensions.`);
} else {
  console.log('VOYAGE_API_KEY not set — chunking without embeddings. Retrieval will be keyword-only.');
}

/* --- chunking ------------------------------------------------------------ */

function chunksFor(doc) {
  const docTopics = Array.isArray(doc.metadata?.topics) ? doc.metadata.topics : undefined;

  if (TRANSCRIPT_TYPES.has(doc.document_type)) {
    /* A timestamped caption file and a pasted interview are both transcripts,
     * but only one of them has times. Try cues first; fall back to speaker
     * turns rather than pretending timestamps exist. */
    let cues = parseCues(doc.raw_content);
    if (cues.length < 2) cues = parsePlainTranscript(doc.raw_content);
    if (!cues.length) return [];

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
        ...(docTopics ? { topics: docTopics } : {}),
        ...(doc.metadata?.content_type ? { content_type: doc.metadata.content_type } : {}),
      },
    }));
  }

  return chunkProse(doc.raw_content).map((p, i) => ({
    chunk_index: i,
    heading: p.heading || null,
    content: p.text,
    token_count: estimateTokens(p.text),
    metadata: {
      ...(docTopics ? { topics: docTopics } : {}),
      ...(doc.source ? { source: doc.source } : {}),
      ...(doc.published_at ? { published_date: String(doc.published_at).slice(0, 10) } : {}),
      ...(doc.metadata?.research_type ? { research_type: doc.metadata.research_type } : {}),
      ...(doc.metadata?.content_type ? { content_type: doc.metadata.content_type } : {}),
    },
  }));
}

/* --- pass 1: chunk pending documents ------------------------------------- */

const pending = await rpc('kb_pending_documents', { p_limit: BATCH });
console.log(`\n${pending.length} document(s) pending.`);

let chunked = 0;
let failed = 0;

for (const doc of pending) {
  const label = `${doc.document_type}: ${doc.title}`;
  let chunks;

  try {
    chunks = chunksFor(doc);
  } catch (err) {
    failed += 1;
    await rpc('kb_mark_document', { p_id: doc.id, p_status: 'failed', p_detail: redact(err.message) });
    console.log(`  failed   ${label} — ${redact(err.message)}`);
    continue;
  }

  if (!chunks.length) {
    failed += 1;
    await rpc('kb_mark_document', {
      p_id: doc.id, p_status: 'failed', p_detail: 'chunker produced no chunks',
    });
    console.log(`  failed   ${label} — produced no chunks`);
    continue;
  }

  /* Embed before writing, so a document lands complete rather than appearing
   * half-embedded to a planner that queries mid-run. */
  if (cfg) {
    try {
      const vectors = await embed(
        chunks.map((c) => [c.heading, c.content].filter(Boolean).join('\n')),
        { inputType: 'document', model: cfg.model, dimensions: cfg.dimensions }
      );
      chunks.forEach((c, i) => { c.embedding = vectors[i]; });
    } catch (err) {
      /* Embedding failure is not document failure. Store the chunks; the
       * backfill pass below will vectorise them next run. */
      console.log(`  warning  ${label} — embedding failed, storing unembedded: ${redact(err.message)}`);
    }
  }

  try {
    const n = await rpc('kb_replace_chunks', { p_document_id: doc.id, payload: chunks });
    chunked += 1;
    const tokens = chunks.reduce((sum, c) => sum + c.token_count, 0);
    console.log(`  ready    ${label} — ${n} chunks, ~${tokens} tokens`);
  } catch (err) {
    failed += 1;
    await rpc('kb_mark_document', { p_id: doc.id, p_status: 'failed', p_detail: redact(err.message) });
    console.log(`  failed   ${label} — ${redact(err.message)}`);
  }
}

/* --- pass 2: backfill embeddings ----------------------------------------- */

let embedded = 0;

if (cfg) {
  const waiting = await rpc('kb_pending_embeddings', { p_limit: 500 });
  if (waiting.length) {
    console.log(`\n${waiting.length} chunk(s) waiting for an embedding.`);
    try {
      const vectors = await embed(
        waiting.map((c) => [c.heading, c.content].filter(Boolean).join('\n')),
        { inputType: 'document', model: cfg.model, dimensions: cfg.dimensions }
      );
      embedded = await rpc('kb_set_embeddings', {
        payload: waiting.map((c, i) => ({ chunk_id: c.chunk_id, embedding: vectors[i] })),
      });
      console.log(`  embedded ${embedded} chunk(s).`);
    } catch (err) {
      console.log(`  backfill failed: ${redact(err.message)}`);
    }
  }
}

console.log(
  `\n${chunked} document(s) chunked, ${failed} failed` +
  (cfg ? `, ${embedded} chunk(s) embedded in backfill.` : ', embeddings deferred.')
);

/* Same rule as ingestion: total failure is a broken run, partial is normal. */
if (pending.length > 0 && failed === pending.length) {
  console.error('\nEvery pending document failed to process.');
  process.exit(1);
}
