/* ---------------------------------------------------------------------------
 * Embed every hook in the library that has no vector yet.
 *
 * Hook search ranks by meaning when it has a query embedding, and a hook with
 * no vector of its own can only score on its topic, so it sinks below every
 * hook that has one. New hooks are embedded as they are seeded; this catches
 * the rest — the backlog from before that, and any whose embedding failed.
 *
 * Cheap: one short string per hook, and only hooks without a vector are read,
 * so it is safe in the daily run.
 *
 * Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and VOYAGE_API_KEY.
 * ------------------------------------------------------------------------ */

import { SUPABASE_URL, SERVICE_KEY, VOYAGE_KEY, rpc, embed, embeddingConfig, hookText } from './kb-lib.mjs';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.log('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping hook embeddings.');
  process.exit(0);
}
if (!VOYAGE_KEY) {
  console.log('VOYAGE_API_KEY not set — skipping hook embeddings.');
  process.exit(0);
}

const hooks = await rpc('kb_hooks_pending_embedding', { p_limit: 1000 });

if (!hooks.length) {
  console.log('Every hook already has an embedding.');
  process.exit(0);
}

const cfg = await embeddingConfig();
const vectors = await embed(hooks.map(hookText), {
  inputType: 'document', model: cfg.model, dimensions: cfg.dimensions,
});

const written = await rpc('kb_set_hook_embeddings', {
  payload: hooks.map((h, i) => ({ id: h.id, embedding: vectors[i] })),
});

console.log(`${written} hook(s) embedded.`);
