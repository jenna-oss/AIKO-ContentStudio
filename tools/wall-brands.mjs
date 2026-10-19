/* ---------------------------------------------------------------------------
 * The lenders on the creative wall, in wall order.
 *
 * Shared because two tools have to agree on it exactly: render.mjs decides
 * which brands need topping up from our own Ad Library sweep, and
 * adlib-thumbs.mjs has to fetch artwork for precisely those ads and no others.
 * A copy in each file would drift, and the failure would be silent — thumbnails
 * fetched for cards that never render, cards rendered with no thumbnail.
 * ------------------------------------------------------------------------ */

/* `corpus` is the prefix that matches our Ad Library records, which carry legal
 * names — 'Lima One Capital, LLC' against a wall that reads 'Lima One'. */
export const WALL_BRANDS = [
  { slug: 'kiavi',  label: 'Kiavi',        corpus: 'kiavi' },
  { slug: 'lima',   label: 'Lima One',     corpus: 'lima one' },
  { slug: 'visio',  label: 'Visio',        corpus: 'visio lending' },
  { slug: 'anchor', label: 'Anchor',       corpus: 'anchor loans' },
  { slug: 'silver', label: 'New Silver',   corpus: 'new silver' },
  { slug: 'rcn',    label: 'RCN',          corpus: 'rcn capital' },
  { slug: 'l1',     label: 'LendingOne',   corpus: 'lendingone' },
  { slug: 'renovo', label: 'Renovo',       corpus: 'renovo financial' },
  { slug: 'temple', label: 'Temple View',  corpus: 'temple view capital' },
];

/* How many cards a brand should have before we stop topping it up. */
export const TOP_UP_TO = 3;

/* The ads render.mjs will use to top a brand up, newest first. Both tools call
 * this rather than each writing the sort out. */
export function topUpAds(ads, brand, want) {
  return ads
    .filter((x) => String(x.advertiser).toLowerCase().startsWith(brand.corpus))
    .sort((x, y) => Date.parse(y.started || 0) - Date.parse(x.started || 0))
    .slice(0, want);
}
