/* ---------------------------------------------------------------------------
 * Meta Ad Library — recency pull
 *
 * Meta does NOT offer a recency sort. Keyword searches are forced to
 * sort_data[mode]=total_impressions&direction=desc, and passing
 * sort_data[mode]=creation_time is silently overridden back to impressions.
 * The date filter (start_date[min] / start_date[max]) matches ads ACTIVE
 * during the window, not ads that STARTED in it — so a 2024 ad still shows up
 * in an August 2026 window.
 *
 * So recency has to be done client-side. This script scrolls the results,
 * reads the "Started running on" date off every ad, sorts newest-first, and
 * prints a table plus CSV you can paste into a sheet.
 *
 * It has to run in the browser: the Ad Library is a JavaScript app and returns
 * an empty shell to curl/fetch from outside a page session.
 *
 * ---------------------------------------------------------------------------
 * HOW TO RUN
 *   1. Open one of the URLs below in Chrome.
 *   2. F12 → Console. (First time only, type: allow pasting ⏎)
 *   3. Paste this whole file, press Enter, wait for it to finish scrolling.
 *
 * URLS THAT WORK
 *   Category sweep (best for spotting new entrants):
 *     https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=fix%20and%20flip%20loan&search_type=keyword_unordered&media_type=all
 *     https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=DSCR%20loan%20investor&search_type=keyword_unordered&media_type=all
 *
 *   One lender, by numeric page ID (exact, no fuzzy matching):
 *     https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&view_all_page_id=PAGE_ID&media_type=all
 *
 * KNOWN PAGE IDS (resolved 2026-08-15)
 *   LendingOne ............ 1488778371407976   (advertising)
 *   Renovo Financial ...... 232025073545293    (advertising)
 *   Temple View Capital ... 1790851891232875   (advertising)
 *   CoreVest .............. 550429851723713    (no ads, ever)
 *   Easy Street Capital ... 161927707529642    (no ads, ever)
 *   Roc360 ................ 122866955776216    (no ads, ever)
 *   Upright ............... 405332459610678    (no ads, ever)
 *   Velocity Mortgage ..... 796752613736461    (no ads, ever)
 *   Longhorn Investments .. 126610117257       (no ads, ever)
 *
 * TO RESOLVE A NEW PAGE ID
 *   Find the lender's Facebook link on their own website, open
 *   facebook.com/<their-handle>, then in the console run:
 *     document.documentElement.outerHTML.match(/"delegate_page":\{"id":"(\d+)"/)[1]
 * ------------------------------------------------------------------------ */

(async () => {
  const SCROLLS   = 20;    // raise for a deeper pull
  const PAUSE_MS  = 1100;  // give lazy-loaded results time to arrive
  const SINCE_DAYS = 45;   // "new" threshold for the summary line

  console.log('%cAd Library recency pull', 'font-weight:bold;font-size:14px');
  console.log('Scrolling for more results…');

  let lastCount = -1, stagnant = 0;
  for (let i = 0; i < SCROLLS; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, PAUSE_MS));
    const n = (document.body.innerText.match(/Library ID:/g) || []).length;
    // two consecutive passes with no new results means we have hit the end
    stagnant = (n === lastCount) ? stagnant + 1 : 0;
    lastCount = n;
    if (stagnant >= 2) { console.log(`Reached the end at ${n} ads.`); break; }
  }

  const rows = document.body.innerText
    .split(/Library ID:/).slice(1)
    .map(b => {
      const adv     = (b.match(/\n([^\n]{2,70})\nSponsored/) || [])[1] || null;
      const started = (b.match(/([A-Za-z]{3} \d{1,2}, \d{4})/) || [])[1] || null;
      const libId   = (b.match(/^\s*(\d{6,})/) || [])[1] || null;
      const copy    = ((b.match(/Sponsored\n([\s\S]{0,400})/) || [])[1] || '')
                        .replace(/\s+/g, ' ').trim().slice(0, 240);
      return { libId, adv, started, copy, ts: started ? Date.parse(started) : 0 };
    })
    .filter(r => r.adv && r.started);

  // one ad can appear many times as separate creative variants
  const seen = new Set();
  const uniq = rows.filter(r => {
    const k = r.adv + '|' + r.copy.slice(0, 80);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  uniq.sort((a, b) => b.ts - a.ts);

  const cutoff = Date.now() - SINCE_DAYS * 864e5;
  const fresh  = uniq.filter(r => r.ts >= cutoff);

  console.log(
    `%c${uniq.length} unique ads · ${new Set(uniq.map(r => r.adv)).size} advertisers · ` +
    `${fresh.length} started in the last ${SINCE_DAYS} days`,
    'font-weight:bold'
  );
  console.table(uniq.slice(0, 40).map(r => ({
    started: r.started, advertiser: r.adv, copy: r.copy.slice(0, 90)
  })));

  const esc = s => '"' + String(s).replace(/"/g, '""') + '"';
  const csv = ['started,advertiser,library_id,copy']
    .concat(uniq.map(r => [r.started, r.adv, r.libId, r.copy].map(esc).join(',')))
    .join('\n');

  console.log('%cCSV below — copy from the next log line:', 'font-weight:bold');
  console.log(csv);

  try {
    await navigator.clipboard.writeText(csv);
    console.log('%c✓ CSV copied to clipboard', 'color:#2C785E;font-weight:bold');
  } catch (e) {
    console.log('Clipboard blocked — select the CSV above and copy it manually.');
  }

  window.__adPull = { all: uniq, fresh, csv };
  console.log('Also stored on window.__adPull for further poking.');
})();
