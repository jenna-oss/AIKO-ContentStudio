/* ---------------------------------------------------------------------------
 * Verify a model-proposed hook library against the hooks actually harvested.
 *
 * The page prints each example as a quotation attributed to a named, real
 * person. A quote the model tightened, or put in the wrong mouth, would be a
 * fabricated citation published under that person's name — so nothing reaches
 * the page unless it matches a harvested hook exactly and is credited to the
 * creator who actually said it.
 *
 * Split out from creator-hooks.mjs so this can be exercised without an API key.
 * ------------------------------------------------------------------------ */

export function verifyPatterns(proposed, hooks) {
  const byQuote = new Map(hooks.map((h) => [h.quote.trim(), h]));
  const patterns = [];
  let dropped = 0;

  for (const p of proposed ?? []) {
    if (!p?.label || !p?.description) { dropped += 1; continue; }

    const examples = [];
    for (const ex of p.examples ?? []) {
      const real = byQuote.get(String(ex?.quote ?? '').trim());
      /* Not a hook we harvested — invented, or reworded into something nobody
       * said. Either way it cannot be published as a quotation. */
      if (!real) { dropped += 1; continue; }
      /* Right words, wrong mouth. */
      if (real.creator !== ex.creator) { dropped += 1; continue; }
      /* creatorCount is printed as "N creators", so one person quoted twice
       * must not read as two people converging on a form. */
      if (examples.some((e) => e.creator === real.creator)) { dropped += 1; continue; }
      examples.push({ creator: real.creator, quote: real.quote, views: real.views ?? null });
    }

    if (!examples.length) continue;

    patterns.push({
      slug: p.slug || p.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      label: p.label,
      description: p.description,
      /* Counted from what survived, never taken from the model's claim. */
      creatorCount: examples.length,
      examples,
    });
  }

  patterns.sort((a, b) => b.creatorCount - a.creatorCount);
  return { patterns, dropped };
}
