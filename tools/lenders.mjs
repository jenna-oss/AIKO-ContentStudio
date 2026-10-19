/* ---------------------------------------------------------------------------
 * The nine board lenders, resolved once and pinned.
 *
 * Shared because two harvesters need the same list and for opposite reasons:
 * pull-creatives.mjs wants their PAID ads for the creative wall, pull-reach.mjs
 * wants their ORGANIC posts for the reach comparison. Two copies of nine ids
 * would drift the first time the board changed, and the two sections would
 * quietly stop describing the same set of companies.
 *
 * Ids are pinned rather than re-searched: re-resolving names each run spends
 * credits rediscovering ids that never change, and risks latching onto a
 * different brand when a name is ambiguous.
 * ------------------------------------------------------------------------ */

export const LENDERS = [
  { slug: 'kiavi',  id: '199787047046840',  name: 'Kiavi',               label: 'Kiavi' },
  { slug: 'lima',   id: '248880558512632',  name: 'Lima One',            label: 'Lima One' },
  { slug: 'visio',  id: '1451703848411077', name: 'Visio Lending',       label: 'Visio' },
  { slug: 'anchor', id: '180735095285808',  name: 'Anchor Loans',        label: 'Anchor' },
  { slug: 'silver', id: '355605498348601',  name: 'New Silver',          label: 'New Silver' },
  { slug: 'rcn',    id: '265616356813717',  name: 'RCN Capital',         label: 'RCN' },
  { slug: 'l1',     id: '1488778371407976', name: 'LendingOne',          label: 'LendingOne' },
  { slug: 'renovo', id: '232025073545293',  name: 'Renovo Financial',    label: 'Renovo' },
  { slug: 'temple', id: '1790851891232875', name: 'Temple View Capital', label: 'Temple View' },
];
