/* ---------------------------------------------------------------------------
 * Build the hook library from the Spyglass hook patterns (spec section 20).
 *
 * adspy.hook_patterns holds creative structures from founder, creative and
 * agency voices on social (tools/pull-spyglass.mjs lists them). None of them
 * sells an AI content tool, so none of it is competitor intelligence, and the
 * planner is told so in two places: the system prompt, and the origin field on
 * every row this writes.
 *
 * What those rows are is labels — "Personal discovery narrative (I [found] a
 * [sign])". What section 20 asks for is a template and an example. Turning one
 * into the other is a rewrite into AIKO's context, which is why this needs a
 * model and is a separate, occasional job rather than part of the daily run.
 *
 * Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ANTHROPIC_API_KEY.
 * ------------------------------------------------------------------------ */

import { SUPABASE_URL, SERVICE_KEY, VOYAGE_KEY, rpc, redact, embed, embeddingConfig, hookText } from './kb-lib.mjs';
import { claudeJson, hasKey } from './claude-json.mjs';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.log('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping the hook seed.');
  process.exit(0);
}
if (!hasKey()) {
  console.log('ANTHROPIC_API_KEY not set — skipping the hook seed.');
  process.exit(0);
}

const LIMIT = Number(process.env.KB_HOOK_LIMIT || 40);
/* Six, not ten. A batch of ten adapted hooks — each a category, a template, an
 * example and topics — overran a 4096-token reply on the first real run and
 * lost the whole batch. The reply grows with the batch, so the batch is the
 * lever; the ceiling below is the safety net, not the fix. */
const BATCH = 6;

const SYSTEM = `You adapt hook patterns into reusable opening-line templates for AIKO Group, whose short faceless videos advertise AIKO Content Studio: a self-serve tool that turns one planning conversation into a week of finished, on-brand educational videos. The audience is owner-operators of expertise-led, high-ticket businesses — M&A advisors, business brokers, CRE brokers, CPAs — who know social media decides who gets the call and have no time for it.

You are given patterns observed on founder, creative and agency accounts. You are taking the FORM, not the content. Never write a template that names or claims anything about another company.

For each pattern return:

category — a short snake_case family name. Reuse these where they fit:
           myth_busting, cost_of_invisibility, contrarian, personal_discovery,
           speed_or_ease, hidden_cost, qualification, comparison,
           objection_handling, proof_or_receipts, warning, question_open
template — the reusable shape, with {placeholders} for the parts that change.
           It must read as a spoken opening line for a 30-60 second vertical
           video, not as a headline or a banner: short and declarative, then
           the turn.
example  — the template filled in for AIKO, on a real subject like buyers
           researching an advisor for a year before calling, the referral that
           arrives already convinced, or a week of videos from one conversation.
           One sentence, natural spoken English. Name something concrete — a
           time cost, a client, a call. No hype, no exclamation marks, no
           follower or view counts, no promise of results.
topics   — up to 3 subjects this shape suits (visibility, trust, time, AI, referrals, niche authority).

Drop a pattern rather than force it. If a pattern is specific to the source
account's own product or life — a course launch, a giveaway, a gym routine —
return "skip": true for it and nothing else. A padded library is worse than a
short one: every row here is something a planner may put in front of AIKO's
audience.

Return bare JSON, no prose, no code fence:
{"hooks":[{"pattern_ref":"...","skip":false,"category":"...","template":"...","example":"...","topics":["..."]}]}`;

const patterns = await rpc('kb_hook_seed_source', { p_limit: LIMIT });

if (!patterns.length) {
  console.log('Every unmuted hook pattern is already in the library.');
  process.exit(0);
}

console.log(`${patterns.length} pattern(s) to adapt.`);

const rows = [];
let skipped = 0;
let failed = 0;

for (let i = 0; i < patterns.length; i += BATCH) {
  const batch = patterns.slice(i, i + BATCH);
  const label = `batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(patterns.length / BATCH)}`;

  let parsed;
  try {
    parsed = await claudeJson({
      system: SYSTEM,
      user: JSON.stringify(
        batch.map((p) => ({
          pattern_ref: p.pattern_ref,
          observed_on: p.brand_name,
          category_hint: p.category,
          pattern: p.label,
        })),
        null,
        1
      ),
      maxTokens: 8192,
    });
  } catch (err) {
    failed += batch.length;
    console.log(`  ${label} failed — ${redact(err.message)}`);
    continue;
  }

  const source = new Map(batch.map((p) => [p.pattern_ref, p]));

  for (const h of parsed.hooks || []) {
    const origin = source.get(h.pattern_ref);
    if (!origin) continue;
    if (h.skip || !h.template || !h.category) { skipped += 1; continue; }

    rows.push({
      brand_slug: 'aiko',
      category: String(h.category).toLowerCase().replace(/[^a-z0-9_]+/g, '_'),
      template: h.template,
      example: h.example || null,
      topics: Array.isArray(h.topics) ? h.topics.slice(0, 3) : [],
      origin: 'hook_patterns',
      origin_ref: h.pattern_ref,
      metadata: {
        /* Kept verbatim so a reader can always see what was adapted, and from
         * whom. The planner is instructed never to present one of these as a
         * competitor's hook; this is the record that makes that checkable. */
        adapted_from: origin.label,
        observed_on: origin.brand_name,
        observed_uses: origin.total,
        weeks_active: origin.weeks_active,
        out_of_category: true,
      },
    });
  }

  console.log(`  ${label} — ${(parsed.hooks || []).length} returned`);
}

if (!rows.length) {
  console.log(`\nNothing usable came back. ${skipped} skipped, ${failed} failed.`);
  process.exit(0);
}

if (VOYAGE_KEY) {
  try {
    const cfg = await embeddingConfig();
    const vectors = await embed(rows.map(hookText), {
      inputType: 'document', model: cfg.model, dimensions: cfg.dimensions,
    });
    rows.forEach((r, i) => { r.embedding = vectors[i]; });
  } catch (err) {
    console.log(`  embedding failed, writing without vectors: ${redact(err.message)}`);
  }
}

const written = await rpc('kb_upsert_hooks', { payload: rows });

console.log(
  `\n${written} hook(s) added. ${skipped} pattern(s) skipped as brand-specific, ${failed} failed.`
);
console.log('Every row is marked out_of_category — these are adapted forms, not competitor hooks.');
