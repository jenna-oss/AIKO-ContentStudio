/* ---------------------------------------------------------------------------
 * Is this ad about making or posting content? The Ad Library's keyword search
 * matches any word, so a sweep for "repurpose content AI" also returns
 * serialised fiction, settlement claims and realtor listings. merge.mjs drops
 * those before they reach the corpus.
 *
 * Measured on the first sweep (2026-10-19): 2,048 ads in, 1,420 kept from 300
 * advertisers. What it drops is overwhelmingly noise; what slips through is a
 * consumer AI app now and then. A rule, not a judge: cheap, the same every
 * day, and it needs no key.
 * ------------------------------------------------------------------------ */

/* Topic groups. An ad needs at least two: "AI" alone is every app on earth,
 * "video" alone is the fiction ads. */
const GROUPS = [
  /\bAI\b|artificial intelligence/i,
  /\bcontent\b/i,
  /\bvideos?\b|\bclips?\b|\breels?\b|\bshorts\b/i,
  /\bpost(s|ing)?\b|\bschedul/i,
  /social media|instagram|tiktok|linkedin|youtube|facebook/i,
  /\bcaptions?\b|\bediting\b|\beditor\b/i,
  /\bbrand(ing)?\b|\bagency\b|ghostwrit|marketing/i,
  /\bcreators?\b|\baudience\b|followers|engagement/i,
];

/* The audience is English-speaking; an ad mostly in another script is a
 * different market. */
function mostlyLatin(s) {
  const letters = (s.match(/\p{L}/gu) || []).length;
  if (!letters) return true;
  return (s.match(/[A-Za-z]/g) || []).length / letters > 0.8;
}

export function isRelevant(ad) {
  const copy = String(ad.copy || '');
  const text = `${copy} ${ad.advertiser || ''}`;
  return mostlyLatin(copy) && GROUPS.filter((re) => re.test(text)).length >= 2;
}
