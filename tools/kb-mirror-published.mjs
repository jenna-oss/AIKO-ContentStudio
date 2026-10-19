/* ---------------------------------------------------------------------------
 * Mirror Trilith's published website content into kb.published_content.
 *
 * The content schema already holds 80 pages split into 561 passages, and it
 * answers "what has Trilith written about X" well. It cannot answer "have we
 * already made this argument", because it records no topic, angle or hook —
 * those are the fields repetition detection compares, and a web page does not
 * state them anywhere a parser could read.
 *
 * So they are derived. Each page is read once by the model, which returns the
 * topic, the angle, and the opening hook as the page itself states them. The
 * derivation is marked in metadata as inferred, because it is: nobody at
 * Trilith wrote "angle: lower rates don't mean cheaper homes" on that post.
 *
 * The two tables are not redundant. This one is deliberately shallow — one row
 * per piece, no body — because repetition detection compares arguments, not
 * paragraphs.
 *
 * Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ANTHROPIC_API_KEY.
 * VOYAGE_API_KEY is optional but strongly wanted: without an embedding,
 * repetition detection falls back to trigram matching on topic and angle, which
 * catches an exact restatement and misses a paraphrase.
 * ------------------------------------------------------------------------ */

import { SUPABASE_URL, SERVICE_KEY, VOYAGE_KEY, rpc, redact, embed, embeddingConfig } from './kb-lib.mjs';
import { claudeJson, hasKey } from './claude-json.mjs';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.log('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping the mirror.');
  process.exit(0);
}
if (!hasKey()) {
  console.log('ANTHROPIC_API_KEY not set — skipping the mirror (topic and angle cannot be derived without it).');
  process.exit(0);
}

const BATCH = Number(process.env.KB_MIRROR_BATCH || 8);
const LIMIT = Number(process.env.KB_MIRROR_LIMIT || 40);

const SYSTEM = `You read a published article and state what it is, in three fields.

topic  — the subject, as a short noun phrase. "DSCR loans", "appraisal gaps".
angle  — the specific argument the piece makes about that topic. Not a summary
         of the whole article: the claim that makes this piece different from
         every other piece on the same topic. One sentence.
hook   — the opening line or the first claim the piece leads with, quoted from
         the text where there is one to quote. Null if the piece opens with
         nothing quotable.

Rules:
- Use only what the article actually says. Do not infer a claim it does not make.
- If the piece makes no distinct argument — a product page, an FAQ — set angle
  to null rather than inventing one.
- hook must be verbatim from the text, or null. Never paraphrase into it.

Return bare JSON, no prose, no code fence:
{"results":[{"url":"...","topic":"...","angle":"..."|null,"hook":"..."|null}]}`;

const pages = await rpc('kb_content_mirror_source', { p_limit: LIMIT });

if (!pages.length) {
  console.log('Nothing to mirror — every content page already has a published_content row.');
  process.exit(0);
}

console.log(`${pages.length} page(s) to mirror.`);

let cfg = null;
if (VOYAGE_KEY) cfg = await embeddingConfig();
else console.log('VOYAGE_API_KEY not set — mirroring without embeddings; repetition detection will be trigram-only.');

const rows = [];
let failed = 0;

for (let i = 0; i < pages.length; i += BATCH) {
  const batch = pages.slice(i, i + BATCH);
  const label = `batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(pages.length / BATCH)}`;

  let parsed;
  try {
    parsed = await claudeJson({
      system: SYSTEM,
      user: JSON.stringify(
        batch.map((p) => ({ url: p.url, kind: p.kind, title: p.title, body: p.body })),
        null,
        1
      ),
      /* Raised with kb-seed-hooks: same failure shape, one long batch away. */
      maxTokens: 8192,
    });
  } catch (err) {
    failed += batch.length;
    console.log(`  ${label} failed — ${redact(err.message)}`);
    continue;
  }

  const byUrl = new Map((parsed.results || []).map((r) => [r.url, r]));

  for (const page of batch) {
    const got = byUrl.get(page.url);
    if (!got?.topic) { failed += 1; console.log(`  no topic returned for ${page.url}`); continue; }

    /* A hook is only stored when it is genuinely in the text. The model is
     * asked for verbatim, and this checks: a reworded opening under the
     * brand's name is a fabricated quotation, and the creator pipeline in this
     * repo already refuses those for the same reason. */
    const hook =
      got.hook && page.body && page.body.replace(/\s+/g, ' ').includes(got.hook.replace(/\s+/g, ' ').trim())
        ? got.hook.trim()
        : null;

    rows.push({
      brand_slug: 'trilith',
      source_key: page.url,
      title: page.title,
      topic: got.topic,
      angle: got.angle || null,
      hook,
      format: 'article',
      platform: 'website',
      /* Only a publisher-stated date is a publication date. A sitemap lastmod
       * is a build stamp, and the content harvester already refuses to present
       * one as the other — that judgement is carried across, not re-litigated. */
      published_at: page.date_source === 'json-ld' && page.published ? `${page.published}T00:00:00Z` : null,
      metadata: {
        kind: page.kind,
        mirrored_from: 'content.documents',
        derivation: 'model-inferred',
        derived_fields: ['topic', 'angle', ...(hook ? ['hook'] : [])],
        ...(got.hook && !hook ? { hook_rejected: 'not found verbatim in the page body' } : {}),
        ...(page.published && page.date_source !== 'json-ld'
          ? { undated_reason: `only a ${page.date_source} timestamp exists, which is not a publication date` }
          : {}),
      },
    });
  }

  console.log(`  ${label} — ${byUrl.size} of ${batch.length} read`);
}

if (!rows.length) {
  console.error('Nothing could be derived. Not writing.');
  process.exit(1);
}

if (cfg) {
  try {
    const vectors = await embed(
      rows.map((r) => [r.topic, r.angle, r.hook].filter(Boolean).join(' — ')),
      { inputType: 'document', model: cfg.model, dimensions: cfg.dimensions }
    );
    rows.forEach((r, i) => { r.embedding = vectors[i]; });
  } catch (err) {
    console.log(`  embedding failed, writing without vectors: ${redact(err.message)}`);
  }
}

const written = await rpc('kb_upsert_published', { payload: rows });

console.log(`\nMirrored ${written} row(s); ${failed} page(s) could not be read.`);
console.log('Every topic and angle here is model-derived and marked as such in metadata.');
