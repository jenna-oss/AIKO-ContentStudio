/* ---------------------------------------------------------------------------
 * Mirror the channel's own videos into kb.published_content.
 *
 * Repetition detection compared every new idea against the website and
 * nothing else, so it could not see the videos this tool had already made. On
 * 2026-09-20 the planner proposed "rehab money is reimbursed, not handed over
 * at closing", check_repetition called it new, and it was rendered a second
 * time — the same argument had been made on 2026-09-13.
 *
 * Every rendered video (and every cut clip) becomes one row, keyed by its
 * planning slot so a re-render updates the row rather than adding a second.
 * Rejected videos are left out: an argument nobody approved has not been made.
 *
 * Unlike the website mirror, nothing is inferred. Topic, angle and hook are
 * what the planner wrote into the slot, so no model is called and the rows
 * are marked `planner-stated`. No posting record exists yet (kb.posts is
 * empty), so "made" is the bar, not "posted" — which is the right bar for a
 * planner deciding whether to make something again.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. VOYAGE_API_KEY is optional
 * but strongly wanted, for the same reason as in kb-mirror-published.mjs.
 * ------------------------------------------------------------------------ */

import { SUPABASE_URL, SERVICE_KEY, VOYAGE_KEY, rpc, redact, embed, embeddingConfig } from './kb-lib.mjs';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.log('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping the video mirror.');
  process.exit(0);
}

/* kb_video_library caps itself at 200 and already returns only the latest
 * render of each slot. */
const library = await rpc('kb_video_library', { p_limit: 200 });

const rows = library
  .filter((v) => v.review_status !== 'rejected' && v.topic)
  .map((v) => ({
    brand_slug: 'trilith',
    source_key: v.kind === 'clip' ? `clip:${v.id}` : `video:${v.session_id}:${v.slot}`,
    title: v.topic,
    topic: v.topic,
    angle: v.angle || null,
    hook: v.hook || null,
    format: v.kind === 'clip' ? 'clip' : 'short',
    platform: 'video',
    published_at: v.rendered_at,
    metadata: {
      mirrored_from: v.kind === 'clip' ? 'kb.clips' : 'kb.video_renders',
      derivation: 'planner-stated',
      kind: v.kind,
      session_id: v.session_id,
      slot: v.slot,
      review_status: v.review_status,
      ...(v.product ? { product: v.product } : {}),
      ...(v.audience ? { audience: v.audience } : {}),
    },
  }));

if (!rows.length) {
  console.log('No rendered videos to mirror.');
  process.exit(0);
}

if (VOYAGE_KEY) {
  try {
    const cfg = await embeddingConfig();
    /* Same text shape as the website rows, so the two compare like for like. */
    const vectors = await embed(
      rows.map((r) => [r.topic, r.angle, r.hook].filter(Boolean).join(' — ')),
      { inputType: 'document', model: cfg.model, dimensions: cfg.dimensions }
    );
    rows.forEach((r, i) => { r.embedding = vectors[i]; });
  } catch (err) {
    console.log(`  embedding failed, writing without vectors: ${redact(err.message)}`);
  }
} else {
  console.log('VOYAGE_API_KEY not set — mirroring without embeddings; repetition detection will be trigram-only.');
}

const written = await rpc('kb_upsert_published', { payload: rows });
const skipped = library.length - rows.length;
console.log(`Mirrored ${written} video(s); ${skipped} rejected or untitled left out.`);
