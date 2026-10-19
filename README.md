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

## The system

AIKO Content Studio is built by AIKO Group (@aikogroup.ai). AIKO also uses it
for its own channel: the videos it makes advertise the tool to owner-operators
of expertise-led, high-ticket businesses — M&A advisors, business brokers, CRE
brokers, CPAs.

| Part | Where |
|---|---|
| Pages | static HTML on GitHub Pages, https://jenna-oss.github.io/AIKO-ContentStudio/ |
| Worker | Cloudflare Worker `aiko-studio`, https://aiko-studio.jenna-cbd.workers.dev (`worker/`) |
| Database | Supabase project `kgagmkodufrmxrafthre`; schema in `supabase/migrations/`, see [db/README.md](db/README.md) |
| Sign-in | Clerk; the Worker only answers emails on the allowlist in `kb.app_users` |
| Jobs | GitHub Actions workflows in `.github/workflows/` |
| Video | the render pipeline in `video/`, see [video/README.md](video/README.md) |

The pages are public files. The lock is the Worker: every route needs a Clerk
session whose email is in `kb.app_users`.

**The scheduled workflows are switched off.** The ad pull, the creator pull, the
knowledge-base refresh and the weekly hook-pattern refresh all have their
`schedule:` blocks commented out until the repository secrets are added. Each
can still be run by hand from the Actions tab (`workflow_dispatch`). The times
given below are what each runs at once its schedule is restored.

## Research

The Research menu has two pages.

- **Competitors** (`competitors.html`) — what AI content tools, video and
  scheduling apps and agencies advertise on Meta. Harvested daily from the Meta
  Ad Library by `tools/pull.mjs` and classified by category: `ai-video`,
  `ai-writing`, `scheduling`, `repurposing`, `all-in-one`, `agency`. The page
  reads `data/ads.json` directly; nothing goes through the Worker.
- **Creators** (`creators.html`) — founder and marketing educators, via
  Spyglass. Needs `SPYGLASS_API_KEY` and an active Spyglass subscription. See
  [Creator automation](#creator-automation).

Two limits apply to both, and the Competitors page states them itself: the Ad
Library reports creatives, never spend, so ad count is not spend; and absence
means not observed, not that nothing exists.

## The Worker

`worker/` holds every key. The pages hold none — they know the Worker's URL and
nothing else. The Worker answers the planner (`/ideas`), knowledge-base uploads
(`/kb/upload`), plans, renders, edits, recordings, links and scheduled posts,
and runs every five minutes on a cron trigger to publish anything due on
Instagram or Facebook.

```
cd worker
npm install
npx wrangler secret put ANTHROPIC_API_KEY   # prompts — never type a key into a file
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler deploy
```

The full list of secrets, and what each one is for, is in the comments of
`worker/wrangler.toml`. `SUPABASE_URL` and `GITHUB_REPO` are `[vars]` there, not
secrets. What breaks when a secret is missing is in [PLAN-PAGE.md](PLAN-PAGE.md).

### Guards

- **Sign-in on every route** — a Clerk session on the `kb.app_users` allowlist.
- **Origin allowlist** — the Worker only answers browsers on the Pages origin
  and local development ports. It is a browser control, not a security
  boundary, which is why sign-in exists.
- **Read-only database key** — the Worker reads Supabase with the anon key, so
  the planner cannot rewrite a corpus. The service-role key belongs in
  repository secrets and never in the Worker.
- **Refusals handled** — `stop_reason: "refusal"` is surfaced as a readable
  message.

**A public endpoint spends real money.** Add a Cloudflare rate-limiting rule on
the Worker route before sharing the link widely.

## Knowledge base

`kb` is a fourth schema holding the content intelligence corpus: transcripts,
research, the published record as topic and angle, idea memory, and a hook
library. It is the only corpus here with a vector layer — hybrid retrieval,
reranked and diversity-filtered — and it is what the planning agent searches
when it needs to know what has already been said, written, or read.

Drop files in `kb/files/`, add URLs to `kb/sources.json`, add feeds to
`kb/feeds.json`, then:

```
npm run kb
```

`kb/feeds.json` follows Seth's Blog, SaaStr, Sahil Bloom, Lenny's Newsletter,
ACG, IBBA, Peak Business Valuation, Commercial Observer, Connect CRE, Bisnow,
The Verge (AI), MIT Technology Review (AI), OpenAI News and Google AI. Each run
fetches their newest posts, bounded per feed.

The planner's other corpora are the competitor ads (`adspy`), AIKO's own
content (`content` — read from gitignored Markdown in `content/own/`, or from a
site's sitemap once `OWN_SITE_SITEMAP` is set) and hook patterns from founder
and creative creators via Spyglass. The positioning lives only in
`content/own/`, never in this public repository.

Full documentation, including the ranking formula, what is deliberately
switched off and why, and the limits of the data:
[KNOWLEDGE-BASE.md](KNOWLEDGE-BASE.md). The ad, content and hook-pattern
corpora: [RETRIEVAL.md](RETRIEVAL.md). How the Plan page, the Worker and
Postgres connect — the request path, the tools, the streaming protocol, and
every secret and what breaks without it: [PLAN-PAGE.md](PLAN-PAGE.md). How to
get material in: [kb/README.md](kb/README.md).

Refreshed daily at 14:00 UTC by `.github/workflows/knowledge-base.yml` (off for
now, see above), which writes only to Postgres and never to git.

Needs `VOYAGE_API_KEY` alongside the Supabase secrets, as a repository secret
and as a Worker secret. **Without it the system still answers**, using keyword
search alone, and marks every result degraded so the agent says the search was
partial rather than concluding nothing exists.

## Daily automation

`.github/workflows/daily-ad-pull.yml` runs at 11:00 UTC (06:00 ET) once its
schedule is restored, and can be triggered by hand from the Actions tab.

| Stage | Script | Does |
|---|---|---|
| Pull | `tools/pull.mjs` | Drives Chromium over keyword sweeps, two phrasings per category, and writes `data/raw/<date>.json` |
| Merge | `tools/merge.mjs` | Folds into `data/ads.json`, stamping a **firstSeen** date per ad and keeping the category of the sweep that first found it |
| Shape | `tools/to-sql.mjs` | Turns `data/ads.json` into the load payload for Postgres |
| Content | `tools/pull-content.mjs` | Re-harvests AIKO's own content; allowed to fail without sinking the ad pull |

Then it commits and pushes — GitHub Pages rebuilds, and the Competitors page
reads the new `data/ads.json` — and only after that sends the ads and content
to Supabase (`tools/push-supabase.mjs`, `tools/push-content.mjs`). Git is the
source of truth; a database problem must never cost the day's harvest.

**Why `firstSeen` matters.** Meta reports when an ad *started* but offers no recency
sort, and its date filter matches ads *active during* a window rather than *started*
in one. Watching daily gives a first-seen date of our own, so "new this week" means
new to us — which is both honest and more useful than anything a single query returns.

### Guards

Publishing is automatic, so the harvest is gated:

- **Unhealthy harvest fails the run.** `pull.mjs` exits non-zero unless it finds at
  least 15 ads and at least 2 keyword sweeps returned rows. A blocked or broken run
  commits nothing and leaves the previous good data and page in place. A page-ID
  target returning zero, once any are added, is *not* treated as failure — a
  company that never advertises is data.
- **Push retries on a moving branch.** A commit landing mid-run is rebased onto
  rather than lost.

### Known risk

Meta frequently challenges datacenter IPs and a headless runner cannot clear a
challenge, so expect some failed runs. Failures are safe — they just skip a day.
Keyword depth is also capped for datacenter IPs: a runner sees roughly a quarter of
what a residential connection does. If it fails for several consecutive days, run
the job somewhere with a residential IP.

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

`.github/workflows/daily-creator-pull.yml`, 13:00 UTC daily once its schedule is
restored, two hours after the ad pull so the two do not race for the same push.
`creators.html` fetches its JSON in the browser, so there is no render step —
rewriting the data files is the publish.

| Stage | Script | Does |
|---|---|---|
| Harvest | `tools/pull-creators.mjs` | Organic clips per pinned creator, relevance screen, discovery; writes `data/education-creators.json` |
| Mine | `tools/creator-hooks.mjs` | Rebuilds the hook library (`data/creator-hook-patterns.json`) from that day's hooks |

Needs `SPYGLASS_API_KEY` (on an active Spyglass subscription) and
`ANTHROPIC_API` as repository secrets; the workflow maps the second to the
`ANTHROPIC_API_KEY` the scripts read. Each script skips itself, without failing,
when its key is absent.

### Why this one needs a model

Two judgments on this page cannot be made with a keyword rule.

**The corpus drifts off-thesis.** Spyglass returns a creator's *recent* posts, not
their posts on the subject. A founder-brand creator's latest video can be about a
gym routine or a holiday. Every candidate clip is screened before it lands, and
without the Anthropic key the harvest keeps the existing clips rather than
publishing unscreened ones.

**Spyglass has no pattern data for organic posts.** Its `HOOK`/`AD_ANGLE` aggregation is
tuned to paid campaigns and comes back empty for organic creators.
`creator-hooks.mjs` reads the hooks from the harvested clips instead, each run.

### Guards

- **Organic only, strictly.** A row whose paid/organic marker cannot be read is
  treated as **paid** and dropped. The Competitors page is the paid side; an ad
  must never appear on a page about what people post for free.
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
against a roster capped at 16. The hook-pattern job (`weekly-hook-patterns.yml`,
Mondays 12:00 UTC once restored) stayed *weekly* for this reason, so if credits get
tight, this schedule is the first thing to loosen.

## Tools

The scripts the workflows run live in `tools/`, grouped by job:

| Job | Scripts |
|---|---|
| Ad corpus | `pull.mjs`, `merge.mjs`, `to-sql.mjs`, `push-supabase.mjs` |
| AIKO's own content | `pull-content.mjs`, `push-content.mjs` |
| Creators and hooks | `pull-creators.mjs`, `creator-media.mjs`, `creator-hooks.mjs`, `hook-verify.mjs` |
| Hook patterns | `pull-spyglass.mjs`, `push-hook-patterns.mjs` |
| Knowledge base | `kb-ingest.mjs`, `kb-process.mjs`, `kb-feeds.mjs`, `kb-sources.mjs`, `kb-web.mjs`, `kb-chunk.mjs`, `kb-summarise.mjs`, `kb-mirror-published.mjs`, `kb-mirror-videos.mjs`, `kb-seed-hooks.mjs`, `kb-embed-hooks.mjs`, `kb-lib.mjs` |
| Shared | `claude-json.mjs` |

Meta's Ad Library has **no recency sort**. Keyword searches are forced to
`sort_data[mode]=total_impressions`, and passing `creation_time` is silently
overridden back to impressions. Its date filter matches ads *active during* a
window rather than ads that *started* in it, so long-running ads from earlier
years still surface inside a current window. `pull.mjs` works around that: it
scrolls the results and reads each ad's Library ID and "Started running on"
date, so ordering by start date happens on our side. It has to drive a real
browser — the Ad Library is a JavaScript app and returns an empty shell to
`curl`.
