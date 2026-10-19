/* ---------------------------------------------------------------------------
 * Reading one Spyglass media row into a card on creators.html.
 *
 * Split out from pull-creators.mjs so these can be exercised against captured
 * responses without a key and without spending credits. Every rule in here was
 * written against a real 2026-09-08 response, and the shapes are load-bearing:
 * views live under metric, hooks are sometimes null, and the organic/paid
 * marker has already moved once on the sibling creative-wall endpoint.
 * ------------------------------------------------------------------------ */

const AD_ENUM = /(^|_)AD$/i;

export const tags = (c) => [c.platform, c.type, ...(Array.isArray(c.platforms) ? c.platforms : [])];

/* Inverse of the creative wall's isPaid(), and deliberately stricter: there,
 * an unreadable row was assumed organic so a card was not lost. Here an
 * unreadable row is assumed paid, because putting an ad on a page about
 * organic teaching is the worse error. */
export function isOrganic(c) {
  if (typeof c.isOrganic === 'boolean') return c.isOrganic === true;
  const marks = tags(c).filter((t) => typeof t === 'string' && t.trim());
  if (!marks.length) return false;
  return !marks.some((t) => AD_ENUM.test(t.trim()));
}

/* Views arrive as {metric:{label:'Views', value:'40.3K'}} on the REST surface.
 * Accept a flat field too rather than assume the shape is fixed — this file
 * exists partly because isOrganic vanished from the wall's response once. */
export function views(c) {
  if (c.metric && /view/i.test(String(c.metric.label ?? '')) && c.metric.value) {
    return String(c.metric.value);
  }
  for (const k of ['views', 'viewCount', 'plays']) {
    if (c[k] !== undefined && c[k] !== null && String(c[k]).trim()) return String(c[k]);
  }
  return null;
}

/* Captions open with an emoji headline and close with a hashtag tail; neither
 * is a sentence. Take the first line with real words in it and cap it at card
 * length. */
export function fromTitle(title) {
  const first = String(title ?? '')
    .split('\n')
    .map((l) => l.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim())
    .find((l) => l.replace(/[^a-z]/gi, '').length > 12);
  if (!first) return null;
  const clean = first.replace(/(\s#[^\s#]+)+\s*$/, '').replace(/\s+/g, ' ').trim();
  return clean.length > 180 ? `${clean.slice(0, 177).trimEnd()}…` : clean;
}

/* A card shows the hook as its only text, so a null hook would publish a blank
 * card. Fall back to the caption for display, but record that we did: a
 * caption headline is not a spoken opening, and the hook library must not mine
 * it as one. */
export function toVideo(c) {
  const hook = String(c.hook ?? '').replace(/\s+/g, ' ').trim();
  const display = hook || fromTitle(c.title);
  if (!display) return null;
  return {
    id: c.id ?? null,
    hook: display,
    hookSource: hook ? 'hook' : 'title',
    category: (Array.isArray(c.categories) && c.categories[0]) || null,
    views: views(c),
    postedAt: c.startAt ? String(c.startAt).slice(0, 10) : null,
    thumbnailUrl: c.thumbnailUrl,
    mediaUrl: c.mediaUrl,
  };
}

/* The full read of one creator's media response: organic video only, with the
 * caption kept alongside for the relevance screen and dropped before writing. */
export function toCards(list) {
  return list
    .filter(isOrganic)
    .filter((m) => !m.mediaType || String(m.mediaType).toUpperCase() === 'VIDEO')
    .filter((m) => m.mediaUrl && m.thumbnailUrl)
    .map((m) => {
      const v = toVideo(m);
      return v && { ...v, title: m.title };
    })
    .filter(Boolean);
}
