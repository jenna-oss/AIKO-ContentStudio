/* ---------------------------------------------------------------------------
 * Phase 3 — document summaries and topic knowledge (spec section 35).
 *
 * Builds the layer above the chunks: a summary per document, and a set of
 * insights per topic, each carrying the chunk ids it was drawn from. These are
 * an additional retrieval layer and never a replacement for the source — the
 * planner can always descend from an insight to the exact passage behind it.
 *
 * The one rule that matters here is traceability. The model is asked to cite
 * the chunks supporting every insight, and every id it returns is checked
 * against the chunks actually sent. An insight citing an id that does not exist
 * is dropped, not stored: spec section 31 says the planner must never claim
 * something came from a source unless retrieval supports it, and an insight
 * with a fabricated citation is exactly that failure, pre-baked into the
 * database where it would be trusted later.
 *
 * Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ANTHROPIC_API_KEY.
 * ------------------------------------------------------------------------ */

import { SUPABASE_URL, SERVICE_KEY, VOYAGE_KEY, rpc, redact, embed, embeddingConfig } from './kb-lib.mjs';
import { claudeJson, hasKey } from './claude-json.mjs';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.log('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping summaries.');
  process.exit(0);
}
if (!hasKey()) {
  console.log('ANTHROPIC_API_KEY not set — skipping summaries.');
  process.exit(0);
}

const LIMIT = Number(process.env.KB_SUMMARY_LIMIT || 10);
const MODEL_LABEL = 'claude-opus-5';

const SYSTEM = `You are building a retrieval layer over one document. You are given its chunks, each with an id.

Return:

summary      — what this document is and what it establishes. 3-5 sentences.
key_points   — the points a content planner would want to know it contains. Up to 8 strings.
topics       — the subjects it covers, as short noun phrases. Up to 6.
insights     — durable, checkable claims the document supports. For each, list the
               chunk ids that actually contain it.

Rules on insights, which matter more than the rest:
- An insight must be supported by the chunks you cite. Cite the ids you actually
  read it in. Do not cite a chunk because it is nearby or on the same subject.
- Only use ids from the list you were given. Never invent one.
- If the document supports no durable claim, return an empty insights array.
  An empty array is a correct answer; a padded one is not.
- confidence is 0 to 1: how firmly the cited chunks support the claim.

Return bare JSON, no prose, no code fence:
{"summary":"...","key_points":["..."],"topics":["..."],
 "insights":[{"insight":"...","supporting_chunk_ids":["..."],"confidence":0.8,"topic":"..."}]}`;

const docs = await rpc('kb_documents_needing_summary', { p_limit: LIMIT });

if (!docs.length) {
  console.log('Every ready document already has a summary.');
  process.exit(0);
}

console.log(`${docs.length} document(s) to summarise.`);

let cfg = null;
if (VOYAGE_KEY) cfg = await embeddingConfig();

let summarised = 0;
let insightsStored = 0;
let insightsDropped = 0;
let failed = 0;

for (const doc of docs) {
  const label = `${doc.document_type}: ${doc.title}`;
  const chunks = await rpc('kb_document_chunks', { p_document_id: doc.id });

  if (!chunks.length) { console.log(`  skipped  ${label} — no chunks`); continue; }

  let parsed;
  try {
    parsed = await claudeJson({
      system: SYSTEM,
      user: JSON.stringify(
        {
          title: doc.title,
          document_type: doc.document_type,
          chunks: chunks.map((c) => ({ id: c.chunk_id, heading: c.heading, text: c.content })),
        },
        null,
        1
      ),
      /* The largest reply of the three: a summary, up to eight key points, six
       * topics, and every insight with its citations. 4096 would truncate a
       * long document and lose the insights, which are the valuable half. */
      maxTokens: 8192,
    });
  } catch (err) {
    failed += 1;
    console.log(`  failed   ${label} — ${redact(err.message)}`);
    continue;
  }

  if (!parsed?.summary) { failed += 1; console.log(`  failed   ${label} — no summary returned`); continue; }

  let summaryEmbedding;
  if (cfg) {
    try {
      [summaryEmbedding] = await embed([parsed.summary], {
        inputType: 'document', model: cfg.model, dimensions: cfg.dimensions,
      });
    } catch { /* a summary without a vector is still worth storing */ }
  }

  try {
    await rpc('kb_save_summary', {
      payload: {
        document_id: doc.id,
        summary: parsed.summary,
        key_points: (parsed.key_points || []).slice(0, 8),
        topics: (parsed.topics || []).slice(0, 6),
        model: MODEL_LABEL,
        ...(summaryEmbedding ? { embedding: summaryEmbedding } : {}),
      },
    });
    summarised += 1;
  } catch (err) {
    failed += 1;
    console.log(`  failed   ${label} — ${redact(err.message)}`);
    continue;
  }

  /* Citation check. Every id must be one we actually sent. */
  const valid = new Set(chunks.map((c) => c.chunk_id));

  for (const ins of parsed.insights || []) {
    const cited = (ins.supporting_chunk_ids || []).filter((id) => valid.has(id));
    const invented = (ins.supporting_chunk_ids || []).length - cited.length;

    if (!cited.length) {
      insightsDropped += 1;
      console.log(`    dropped an insight with no verifiable source: "${String(ins.insight).slice(0, 60)}..."`);
      continue;
    }
    if (invented) {
      console.log(`    ${invented} unrecognised chunk id(s) removed from an insight's citations`);
    }

    let insEmbedding;
    if (cfg) {
      try {
        [insEmbedding] = await embed([ins.insight], {
          inputType: 'document', model: cfg.model, dimensions: cfg.dimensions,
        });
      } catch { /* store it uncited-by-vector rather than not at all */ }
    }

    try {
      await rpc('kb_save_insight', {
        payload: {
          brand_slug: 'trilith',
          topic: ins.topic || (parsed.topics || [])[0] || doc.title,
          insight: ins.insight,
          supporting_chunk_ids: cited,
          supporting_document_ids: [doc.id],
          confidence: typeof ins.confidence === 'number' ? Math.max(0, Math.min(1, ins.confidence)) : null,
          model: MODEL_LABEL,
          ...(insEmbedding ? { embedding: insEmbedding } : {}),
        },
      });
      insightsStored += 1;
    } catch (err) {
      insightsDropped += 1;
      console.log(`    insight rejected: ${redact(err.message)}`);
    }
  }

  console.log(`  done     ${label} — ${chunks.length} chunks read`);
}

console.log(
  `\n${summarised} summarised, ${failed} failed. ` +
  `${insightsStored} insight(s) stored, ${insightsDropped} dropped for want of a verifiable source.`
);
