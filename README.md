# End-to-End Content Creation Automation

**Show up on social every week with on-brand educational videos, without
hiring a marketing team.**

Built for founders and small businesses who know their field but don't have
the time to research, script, film, edit and post. You make a few decisions.
The automation does the rest.

See it step by step in the [demo page](demo/content-studio-demo.html).

## What you get

- **A full content calendar from one conversation.** Plan a week or a month of
  videos at once, so you're never asking "what should I post today?"
- **Finished videos, not drafts.** Faceless educational videos come back ready
  to post: voiced, captioned and in your brand's look.
- **Your own voice, multiplied.** Talk to the camera once and get several short
  clips, each opening on its strongest line.
- **A consistent presence on every platform.** TikTok, Instagram, YouTube and
  Facebook, posted on schedule.
- **Topics that are timely.** Ideas come from your industry's news, newsletters
  and what competitors are saying, so your content stays current.
- **Hours back every week.** Your time goes into ideas and approvals, not
  editing software or spreadsheets.

## What it feels like to use

**You chat, it plans.**
Ask "what should I post this week?" The agent suggests topics from what's
happening in your industry. Swap anything you don't like in plain words, then
lock the plan.

**You wait a few minutes, videos appear.**
Each topic comes back as a complete video. There's nothing to assemble.

**You say what to change, it changes.**
"Make the opening punchier." "Bigger captions." Type it and the video updates.
No timeline, no editing skills.

**You approve, it posts.**
Pick the days. Videos go out automatically to every connected platform.
Nothing is posted without your approval.

**Prefer to be on camera?**
Upload one long talking-head video and short, captioned clips come back. They
go through the same edit, approve and post steps.

## You stay in control

- Nothing is made until you lock the plan.
- Nothing is posted until you approve it.
- Every video matches your brand's colours, fonts and voice.

---

*The rest of this README is the technical reference.*

## Competitive briefing

Competitive intelligence briefing on the private real estate lending category,
prepared by [AIKO](https://aikogroup.io) for Trilith Funding.

`briefing.html` is a self-contained page — no build step, no dependencies. Open it
directly, or serve the repo root with any static host.

### What it covers

- **The board** — five competing lenders (Kiavi, Lima One, Visio, Anchor Loans,
  New Silver) with paid presence, landing page count, social reach, and the
  position each is buying.
- **The creative wall** — 21 live and recently-live ad creatives, verbatim, each
  linking to the asset that ran. Filterable by lender.
- **Hook taxonomy** — the nine angles the category advertises on, ordered by how
  heavily it leans on each.
- **Pain map** — ten borrower pains scored by competitive pressure.
- **Conversion** — button text, landing page destinations, and offer mechanics.
- **Where the room is** — seven positions nobody in the category has taken.

### Sourcing

Drawn from the Spyglass advertising corpus (Meta, Instagram, TikTok), cross-read
against each lender's live site and landing pages. 130 creatives across five
brands, trailing 90 days to August 2026.

Three limits are stated on the page itself and repeated here:

1. **Days-in-market is a proxy, not a metric.** Platforms do not publish spend or
   performance figures. A long-running ad is probably working; it is not proof.
2. **Absence is not proof of absence.** A brand returning no results means no
   indexed paid social — not that no marketing exists.
3. **The Spanish-language demand signal needs validating.** It comes from creator
   accounts whose audience geography is not verified in this data.

## Ask the corpus (chat)

`ask.html` is a chat interface over the tracked ads, backed by a Cloudflare Worker
(`worker/`) that holds the Anthropic API key. The key never reaches the browser.

**There is deliberately no retrieval layer.** The whole corpus — 774 ads, ~70K
tokens — fits inside the context window, so every question is answered against
every ad rather than against whatever a search step happened to surface. Prompt
caching (1-hour TTL) makes the repeat cost of that small: the corpus sits in a
cached system prefix and only the question is billed at full rate.

### Deploying the backend

```
cd worker
npm install
npx wrangler secret put ANTHROPIC_API_KEY   # prompts — never type the key into a file
npx wrangler deploy
```

Then set `WORKER_URL` at the top of the script in `ask.html` to the deployed URL
and commit. Until that constant is set, the page loads and shows setup instructions
rather than failing.

### Guards

- **Origin allowlist** — the Worker only answers requests from the Pages origin.
  It holds a spendable API key, so an open endpoint would let anyone use it.
- **Input caps** — 2,000 characters per question, 12 turns of history.
- **Refusals handled** — `stop_reason: "refusal"` is surfaced as a readable message,
  and server-side fallbacks are enabled so a declined request reroutes automatically.
- **Token usage is shown per answer** so cost stays visible rather than invisible.

### What it cannot do

Spyglass is an authenticated connector tied to a Claude account, not a public API,
so the chat cannot query it live. It reads the corpus snapshot that the daily job
maintains — same data, refreshed on a schedule.

**A public endpoint spends real money.** Add a Cloudflare rate-limiting rule on the
Worker route before sharing the link widely.

## Knowledge base

`kb` is a fourth schema holding the content intelligence corpus: transcripts,
research, the published record as topic and angle, idea memory, and a hook
library. It is the only corpus here with a vector layer — hybrid retrieval,
reranked and diversity-filtered — and it is what the planning agent searches
when it needs to know what has already been said, written, or read.

Drop files in `kb/files/`, add URLs to `kb/sources.json`, then:

```
npm run kb
```

Full documentation, including the ranking formula, what is deliberately
switched off and why, and the limits of the data:
[KNOWLEDGE-BASE.md](KNOWLEDGE-BASE.md). How the Plan page, the Worker and
Postgres connect — the request path, the twelve tools, the streaming protocol,
and every secret and what breaks without it: [PLAN-PAGE.md](PLAN-PAGE.md). How to
get material in: [kb/README.md](kb/README.md).

Refreshed daily at 14:00 UTC by `.github/workflows/knowledge-base.yml`, which
writes only to Postgres and never to git.

Needs `VOYAGE_API_KEY` alongside the Supabase secrets, as a repository secret
and as a Worker secret. **Without it the system still answers**, using keyword
search alone, and marks every result degraded so the agent says the search was
partial rather than concluding nothing exists.

## Daily automation

`.github/workflows/daily-ad-pull.yml` runs at 11:00 UTC (06:00 ET) and can also be
triggered by hand from the Actions tab. Three stages:

| Stage | Script | Does |
|---|---|---|
| Pull | `tools/pull.mjs` | Drives Chromium over 4 keyword sweeps and 9 lender page IDs, writes `data/raw/<date>.json` |
| Merge | `tools/merge.mjs` | Folds into `data/ads.json`, stamping a **firstSeen** date per ad |
| Render | `tools/render.mjs` | Rewrites only the `AUTO:*` regions of `briefing.html` |

Then it commits and pushes; Pages rebuilds itself.

**Why `firstSeen` matters.** Meta reports when an ad *started* but offers no recency
sort, and its date filter matches ads *active during* a window rather than *started*
in one. Watching daily gives a first-seen date of our own, so "new this week" means
new to us — which is both honest and more useful than anything a single query returns.

### Guards

Publishing is automatic, so two things are gated:

- **Unhealthy harvest fails the run.** `pull.mjs` exits non-zero unless it finds at
  least 15 ads and at least 2 keyword sweeps returned rows. A blocked or broken run
  commits nothing and leaves the previous good data and page in place. A page-ID
  target returning zero is *not* treated as failure — six lenders genuinely have no
  ads.
- **Render refuses to shrink the page.** If the output is under 60% of the input it
  aborts, on the assumption something outside the markers got clobbered.

The feed section also shows a staleness warning on the page itself if the last
successful run is more than three days old.

### Known risk

Meta frequently challenges datacenter IPs and a headless runner cannot clear a
challenge, so expect some failed runs. Failures are safe — they just skip a day. If
it fails for several consecutive days, run the job somewhere with a residential IP,
or use `tools/recency-pull.js` by hand in the meantime.

### Careful: two writers touch briefing.html

`render.mjs` writes the `AUTO:FEED` region. Regenerating the whole page from the
design source overwrites that region with the placeholder. If you regenerate the
page, run `node tools/render.mjs` afterwards to restore the feed — it is idempotent
and safe to run any time `data/ads.json` exists.

### Running it locally

```
npm install
npx playwright install chromium
npm run daily
```

If a cached Chromium already exists but its build number lags the npm package, point
at it instead of downloading another: set `PW_CHROMIUM_PATH` to the `chrome.exe`
path. CI does not need this.

## Creator automation

`.github/workflows/daily-creator-pull.yml`, 13:00 UTC daily, an hour after the ad
pull so the two do not race for the same push. `creators.html` fetches its JSON in
the browser, so there is no render step — rewriting the data files is the publish.

| Stage | Script | Does |
|---|---|---|
| Harvest | `tools/pull-creators.mjs` | Organic clips per pinned creator, relevance screen, discovery |
| Mine | `tools/creator-hooks.mjs` | Rebuilds the hook library from that day's hooks |

Needs `SPYGLASS_API_KEY` and `ANTHROPIC_API_KEY` as repository secrets. Each script
skips itself, without failing, when its key is absent.

### Why this one needs a model

Two judgments on this page cannot be made with a keyword rule.

**The corpus drifts off-thesis.** Spyglass returns a creator's *recent* posts, not
their *real estate* posts. On 2026-09-08, Sean Pan's most recent organic videos were
tax-free shopping in Japan, index funds, and compound interest — none of them
publishable on a page premised on residential real estate investing. Every candidate
clip is screened before it lands, and without the Anthropic key the harvest keeps the
existing clips rather than publishing unscreened ones.

**Spyglass has no pattern data for organic posts.** Its `HOOK`/`AD_ANGLE` aggregation is
tuned to paid campaigns and comes back empty for these creators, which is why the
library was hand-mined at first. `creator-hooks.mjs` reproduces that reading each run.

### Guards

- **Organic only, strictly.** The inverse of `pull-creatives.mjs`, and stricter: a row
  whose paid/organic marker cannot be read is treated as **paid** and dropped. The
  creative wall assumes the opposite, because there a misread costs one card and here
  it puts an ad on a page about what people post for free.
- **Clips are replaced, never emptied.** A creator whose harvest fails, or who has
  fewer than two on-thesis clips that day, keeps yesterday's. An empty card is worse
  than a stale one.
- **Quotes are verified before publishing.** Every hook the model puts in the library
  must match a harvested hook exactly, and be attributed to the creator who actually
  said it. Anything else is dropped — a reworded quote under a real person's name is a
  fabricated citation.
- **Caption fallbacks never enter the library.** When Spyglass returns no hook, the
  caption's first line is shown on the card and marked `hookSource:"title"`. The miner
  skips those: a caption headline is not a spoken opening.
- **Discovery is capped.** Creators publish automatically once at least two of their
  recent clips pass the screen, gated on 25K+ followers and a creator-category match,
  at most 2 per run, to a roster ceiling of 16.

### Known gap: discovery is unproven

New creators are found with a search call, and `searchBrands` is documented only on
the Spyglass **MCP** surface — tied to a Claude account and unreachable from a runner.
No REST equivalent is documented anywhere we have. `pull-creators.mjs` therefore tries
the plausible spellings, logs which one answered, and treats total failure as
survivable: the roster refreshes but does not grow.

**Until a run prints a `discovery route ... answered` line, assume discovery is off.**
If none of the routes work, put the real path in `SEARCH_ROUTES` — everything else in
the job runs without it.

### Cost

Spyglass bills credits per row returned. The ceiling is 12 rows per creator per day
against a roster capped at 16. The hook-pattern job stayed *weekly* for this reason,
so if credits get tight, this schedule is the first thing to loosen.

## Tools

`tools/recency-pull.js` — a no-install version of the same sweep for ad-hoc checks,
pasted into the browser console.

Meta's Ad Library has **no recency sort**. Keyword searches are forced to
`sort_data[mode]=total_impressions`, and passing `creation_time` is silently
overridden back to impressions. Its date filter matches ads *active during* a
window rather than ads that *started* in it, so long-running 2024 ads still
surface inside a 2026 window.

The script works around that: it scrolls the results, reads the "Started running
on" date off each ad, de-duplicates creative variants, sorts newest-first, and
copies a CSV to the clipboard. It has to run in the browser console — the Ad
Library is a JavaScript app and returns an empty shell to `curl`.

Usage, the working search URLs, and pre-resolved lender page IDs are in the file
header. Last verified 2026-08-15: 29 unique ads across 27 advertisers in a single
sweep, 7 of them started within the prior 45 days.

## Notes

- Figures and metrics use a monospace face; competitor ad copy is set in serif
  italic to mark it as quoted material rather than authored copy.
- The page renders in both light and dark themes.
- Typography falls back through `Poppins → Century Gothic → Avenir Next`. Poppins
  is not bundled, so install it locally for the intended rendering.
