# The corpora, for agents

Three bodies of text live in Postgres, each behind one retrieval function. An
agent answering a question should query these rather than be handed a corpus in
a prompt.

| Schema    | What it holds                                    | Entry point                  |
| --------- | ------------------------------------------------ | ---------------------------- |
| `adspy`   | competitor ads: AI content tools, video and scheduling apps, agencies | `adspy.search_ads` |
| `content` | AIKO's own content, split into passages           | `content.search_content`     |
| `adspy`   | hook and ad-angle patterns from founder and creative creators | `adspy.search_hook_patterns` |

The first two answer *what to say*: what competitors are saying, and what
AIKO has already said. The third answers *what shape to say it in*, and is
the only one not sourced from the AI content tool category — read its caveats
before using it.

A fourth schema, `kb`, holds the content intelligence knowledge base —
transcripts, research, the published record as topic and angle, idea memory and
hooks. It is the only one with a vector layer, and it is documented separately
in [KNOWLEDGE-BASE.md](KNOWLEDGE-BASE.md). Nothing in it writes to the two
corpora described here.

---

# Competitor ads — `adspy`

## One function

```sql
select * from adspy.search_ads(
  q             => 'faceless videos',         -- relevance search over ad copy
  advertiser    => 'opus',                    -- fuzzy, partial names are fine
  category      => 'ai-video',                -- ai-video | ai-writing |
                                              -- scheduling | repurposing |
                                              -- all-in-one | agency
  seen_since    => '2026-08-01',              -- when *we* first saw it
  started_since => '2026-08-01',              -- when Meta says it launched
  max_rows      => 40                         -- capped at 500
);
```

Every argument is optional. Omit `q` and it becomes a filtered browse with
`relevance` returned as 0. Supply `q` and it matches on **any** query term, so a
natural-language question still returns something, then ranks ads carrying every
term above ads carrying one. A word-similarity fallback catches misspellings.

Each row carries an `ad_library_url` pointing at the live ad on Meta, so an
agent can cite the primary source instead of asking the reader to take its word.

Over PostgREST the same function is `public.adspy_search_ads` — the `adspy`
schema itself is not exposed.

## Roster

```sql
select * from adspy.advertiser_summary order by ad_count desc;
select name, fb_page_id from adspy.advertisers where is_tracked;
```

Tracked advertisers are under deliberate daily watch by page id; the rest
surface through keyword sweeps. A tracked advertiser with zero ads is data, not
a gap. `category` says what an ad sells and is null until the ad is classified.

## Two things the data will not tell you

**`started` is not `first_seen`.** `started` is Meta's launch date; `first_seen`
is the day our sweep first observed the ad. Only `first_seen` supports a claim
like "new this week", and even then the first sweep has to be excluded, because
everything running that day shares that date without being new.

**Ad count is not spend.** An advertiser running a hundred creatives is not
necessarily outspending one running thirty. The Ad Library reports creatives,
never budget.

---

# Hook patterns — `adspy.hook_patterns`

Searchable creative structures from founder, business and marketing creators
outside the AI-tool category, via the Spyglass API. `HOOK` is how a piece opens; `AD_ANGLE` is the
claim it leads with. Rows from before October 2026 call that `USP`: Spyglass
dropped that type in September 2026, and those rows are kept but no longer refresh.

Two volume-ish fields, and they are not the same thing:

- **`total`** — times the pattern was used. Only on rows seeded from the
  Spyglass MCP surface; the REST endpoint does not report it, so it is null
  elsewhere. Null means *unknown*, never zero, and `min_total` skips those rows
  rather than dropping them.
- **`weeks_active`** — weekly buckets the pattern appeared in, from the API. A
  hook running every week for two months is a different signal from one that
  spiked once.

The pinned list is in `tools/pull-spyglass.mjs`:

| Brand | Category |
| --- | --- |
| Justin Welsh | Founder brand |
| Matt Gray | Founder brand |
| Dan Koe | Founder brand |
| Chris Do | Creative and agency |
| Gary Vaynerchuk | Creative and agency |

Their Spyglass ids are not resolved yet — the subscription was inactive when the
list was chosen — and a brand without an id is skipped, so the table fills only
once ids are pinned and `SPYGLASS_API_KEY` is set on an active subscription.

```sql
select * from adspy.search_hook_patterns(
  q            => 'contrarian opener about time',
  insight_type => 'HOOK',        -- HOOK | AD_ANGLE | USP (older rows)
  brand        => 'justin welsh',
  min_total    => 10,            -- only patterns used at least this often
  max_rows     => 25
);
```

**These creators are not AIKO competitors, and this is not competitor
intelligence.** What it offers is *form*: the shape a piece of creative takes,
abstracted into something reusable. Substance has to come from the ad corpus,
AIKO's own content or the knowledge base. The agent is instructed never to claim a competitor uses a hook on the
strength of this table, and to say plainly when it is adapting a form from
outside the category.

`percent_delta` is Spyglass's own change figure against the previous window.
Negative means the brand is leaning on that pattern less than it was.

## Refreshing it

`.github/workflows/weekly-hook-patterns.yml`, Mondays 12:00 UTC once its
`schedule:` block is uncommented (it is off until the repository secrets are
added).
`tools/pull-spyglass.mjs` calls `GET /brands/{id}/insights` on
`https://app.spyglass.so/api/v1` for a pinned brand list;
`tools/push-hook-patterns.mjs` sends the result through `hook_patterns_upsert`.
Needs `SPYGLASS_API_KEY` as a repository secret, alongside the two Supabase
ones. Both scripts skip themselves, without failing, when their secret is
absent.

Three deliberate choices, all driven by Spyglass billing **credits per row
returned**:

- **Weekly, not daily.** Creative structure moves far more slowly than ad
  inventory. Five brands x two insight types is ten calls a week.
- **Not a live agent tool.** Wiring Spyglass into the agent directly would spend
  credits on every question anyone asks, with no ceiling. The agent reads the
  Postgres copy instead.
- **Brand ids are pinned, not re-searched.** Re-resolving names each run would
  spend credits rediscovering ids that never change, and risks latching onto a
  different brand when a name is ambiguous.

Only `HOOK` and `AD_ANGLE` are pulled. `TARGET_PERSONA` and `MEDIA_MIX` exist and
answer a different question; add them to `TYPES` in the harvester if you want
them, and expect the credit cost to rise accordingly.

### Muting instead of deleting

The scheduled refresh loads whatever the API returns, which will include the
creator-content noise that was filtered by hand on the first load. Rather than
re-delete those rows every week, set `muted = true`:

```sql
update adspy.hook_patterns set muted = true
where brand_id = '<spyglass id>' and label ilike '%giveaway%';
```

Muted rows are excluded from search and the refresh never clears the flag, so
the judgement survives and stays visible instead of being reapplied by hand.
Mute rather than delete a paraphrase that carries a `total`, because the API
cannot supply one again.

---

# AIKO's own content — `content`

AIKO has no site yet, so this corpus is read from Markdown files in
`content/own/` — the positioning and the product copy — which are gitignored
because this repository is public. Once there is a site, set `OWN_SITE_SITEMAP`
to its sitemap URL and its pages are harvested alongside the files. Everything
is split into passages, because the unit of retrieval is the passage, not the
article — a post runs a thousand words and an agent wants the paragraph that
answers its question.

```sql
select * from content.search_content(
  q        => 'approve before posting',   -- passage-level relevance search
  kind     => 'blog',                     -- positioning | page | faq | blog
  since    => '2026-06-01',               -- published on or after
  until    => '2026-08-01',
  max_rows => 20                          -- capped at 200
);
```

Each row returns the full `passage` plus a `snippet` with matched terms wrapped
in `**`, so an agent can judge relevance before reading the whole thing, and the
`url` and `title` to cite. When a passage is not enough:

```sql
select * from content.get_document('<url>');                     -- full body
select * from content.document_index order by published desc;    -- coverage map
```

Over PostgREST the search is `public.content_search`.

## How ranking works, and where it is weak

Matching is OR across query terms for recall. Ranking then combines inverse
document frequency (rare terms count for more), term proximity, a bonus for
passages carrying every term, and a bonus for a hit in the heading — headings are
where these posts state their arguments.

The weak spot is worth knowing: the corpus is small and topically narrow, so IDF
misjudges domain vocabulary. A word central to the product — *video*, say —
appears in so many passages that the retriever treats an ordinary word beside it
as the rarer, more meaningful one. Proximity is what rescues the ranking there.
Lean on `kind` and date filters when a query is built entirely from house
vocabulary.

## Two things the content data will not tell you

**Only blog posts have publisher-stated dates.** `date_source` says where a date
came from: `json-ld` means the publisher stated it, `sitemap-lastmod` means it was
inferred from a file timestamp, and `front-matter` means a file in
`content/own/` set `published` itself. A file without it has no date. Product pages have no date at all — every static
page shares one sitemap timestamp, which is the site build stamp, and the
harvester discards it rather than presenting a build as a publication.

**No author is recorded**, because the site's structured data does not name one.

---

## Keeping it current

Both corpora refresh from the same daily job.

**Ads.** `tools/to-sql.mjs` shapes `data/ads.json` into `data/ads-load.json`,
deriving `product_lines` and `audience` from the copy. Those two columns are
kept so the older loaders still insert cleanly, but the search and count
functions no longer filter on them: they filter on `category`, what the ad
sells. `tools/push-supabase.mjs` sends it through the
`adspy_upsert_ads` RPC, which owns the merge: `first_seen` is never overwritten
and `last_seen` only moves forward.

**Content.** `tools/pull-content.mjs` reads `content/own/` (and walks the
sitemap when `OWN_SITE_SITEMAP` is set) and re-chunks every document into
`data/content.json`. `tools/push-content.mjs` sends it through
`content_upsert_docs`, which upserts each document by URL and replaces its
chunks wholesale — chunk boundaries move whenever a post is edited or the
chunker changes, so ordinals cannot be merged in place.

The content steps are marked `continue-on-error`: AIKO's writing changes
slowly and can be re-harvested tomorrow, but a missed ad sweep is gone for good,
so a site hiccup must not take the ad pull down with it.

Both push steps need `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as
repository secrets and skip themselves, without failing, when those are absent.
The service key bypasses RLS — it belongs in secrets and nowhere else.

## The agent

`index.html` is the front page — Ask & brainstorm. It answers questions about the category and
proposes content, talking to the `/ideas` route on the Worker, which gives the
model five tools rather than a corpus:

| Tool                     | Backed by                    |
| ------------------------ | ---------------------------- |
| `search_competitor_ads`  | `public.adspy_search_ads`    |
| `count_ads`              | `public.adspy_count_ads`     |
| `search_aiko_content`    | `public.content_search`      |
| `search_hook_patterns`   | `public.hook_patterns_search` |
| `aiko_coverage`          | `public.content_coverage`    |

Seven more come from the knowledge base — `search_transcripts`,
`search_research`, `search_previous_content`, `check_repetition`,
`search_content_ideas`, `save_idea` and `search_hooks`. Those are described in
[KNOWLEDGE-BASE.md](KNOWLEDGE-BASE.md).

It runs up to six rounds of searching before answering, and streams every
search it makes to the page as it goes — an idea claiming a gap in the market
is only worth anything if you can see the query behind it.

### Why `count_ads` exists

There was a second page, `ask.html`, that answered questions by putting the
whole ad corpus — ~135K tokens — in a cached system prompt, rewritten whenever
the cache lapsed. Retrieval replaced it, and `ask.html` is now a redirect.

The one thing that design did better was exhaustive counting: it saw every ad
at once, where a search returns 40. `count_ads` restores that property and
improves on it — the count is computed by Postgres over every row, so it is
exact rather than a model tallying text, and it costs a few hundred tokens. The
system prompt tells the agent that counting search results undercounts and that
any "how many" question must go through this tool.

The Worker reads Supabase with the **anon** key, so this route physically
cannot write to either corpus. The system prompt carries the same caveats
recorded here: ad count is not spend, `started` is not `first_seen`, absence
from the corpus is not absence from the market, and a `sitemap-lastmod` date is
not a publication date.

Deploy:

```
cd worker && npm install
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler deploy
```

Then set `WORKER_URL` at the top of the script in `index.html`. The page shows
setup instructions and disables its input until it is set.

## Security

Neither `adspy` nor `content` is exposed over PostgREST. Four wrappers in
`public` are the only doors:

| Function                      | Who can call it |
| ----------------------------- | --------------- |
| `public.adspy_search_ads`     | anon, authenticated, service_role |
| `public.content_search`       | anon, authenticated, service_role |
| `public.adspy_count_ads`      | anon, authenticated, service_role |
| `public.hook_patterns_search` | anon, authenticated, service_role |
| `public.adspy_upsert_ads`     | service_role only |
| `public.content_upsert_docs`  | service_role only |

The read wrappers run as `SECURITY INVOKER`, so the RLS policies on the
underlying tables stay in the path. The write wrappers are `SECURITY DEFINER`
and have `EXECUTE` revoked from `public`, `anon` and `authenticated` — a definer
function callable by anon would let anyone rewrite either corpus.

## On embeddings

There is still no vector column on **either of these two corpora**. At their
size, full-text with IDF and proximity ranking answers the questions
being asked, and both schemas leave room to add one later.

The reasoning has partly moved on, though. The objection was a third-party
embedding dependency — Anthropic provides no embeddings API — and the `kb`
schema now carries one anyway: Voyage `voyage-3.5`, at 1024 dimensions, behind
`kb.embedding_config`. So the dependency exists in the project regardless, and
the remaining question for these two is only whether their size justifies using
it.

Revisit the content corpus first. It is the one where a question can be phrased
with none of the words the passage uses, which is exactly what keyword retrieval
cannot fix, and the machinery to embed it is now sitting next door in
`tools/kb-lib.mjs`.
