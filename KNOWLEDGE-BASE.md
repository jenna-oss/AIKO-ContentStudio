# The knowledge base

A fourth corpus, in its own schema, built to answer one question for the
planning agent: **what relevant knowledge do we have?** What to make with that
knowledge is the planner's job and is deliberately not this layer's.

Where `adspy` and `content` are keyword-only, this one is hybrid — semantic and
keyword together, reranked, diversity-filtered, and cut to a token budget.

| | `adspy` | `content` | `kb` |
| --- | --- | --- | --- |
| Holds | competitor ads | Trilith's website | transcripts, research, published record, ideas, hooks |
| Retrieval | keyword | keyword | **hybrid + rerank** |
| Written by | daily ad pull | daily content crawl | `npm run kb` |

`adspy` and `content` are untouched by any of this. Nothing here alters a table
the 06:00 harvest writes to.

---

## What is in it

Four classes of information, handled four different ways — which is the whole
design, not an implementation detail.

**Stable structured context** — brand, audience, positioning, goals, beliefs,
pillars. Relational, small, handed to the planner whole. Never retrieved
against, never embedded. `kb.brands`, `kb.content_strategies`,
`kb.content_pillars`. **All three are empty**, and that has consequences — see
[Strategic relevance is off](#strategic-relevance-is-off).

**Large unstructured knowledge** — transcripts, research, articles, reports.
Chunked and embedded. `kb.documents`, `kb.document_chunks`.

**Historical content** — what has already been published, as topic and angle
rather than as prose. `kb.published_content`. Retrieved for repetition
detection, not for quoting.

**Session context** — the current week's goal, locked videos, rejected ideas.
Lives in the planning session, not here. The one thing that crosses over is an
idea worth keeping, which is written to `kb.content_ideas`.

---

## Retrieval

```
                 query
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
 semantic (pgvector)    keyword (tsvector)
        │                     │
        └──────────┬──────────┘
                   ▼
              merge + score
                   ▼
            diversity penalty
                   ▼
             token budget
                   ▼
          retrieval_context
```

One function does the work — `kb.search_chunks` — and every named tool is a thin
wrapper on it.

### Ranking

```
final = semantic·0.60 + keyword·0.20 + recency·0.20 + strategic·0.00
```

The spec's weights are `.45/.15/.15/.25`. Strategic relevance is held at zero
because there is no strategy to be relevant to, and the remaining `.75` is
renormalised. Weights live in `kb.ranking_weights`, one row per query intent, and
are changed with an `UPDATE` — not a deploy.

Intents tune the same formula for different jobs:

| Intent | Leans on | Chunks per document |
| --- | --- | ---: |
| `DISCOVERY` | recency, wide spread | 1 |
| `SUPPORT` | precision | 3 |
| `REPETITION` | recall | 5 |
| `SOURCE` | keyword — you want the exact phrase | 5 |
| `TIMELY` | recency, heavily | 2 |

**Scores are never shown to the user.** They are returned to the model and
logged; nothing renders them.

### Recency decays, it does not filter

`kb.recency_curve` holds the spec's control points and interpolates between
them. No clean exponential passes through all five — fitting the 90-day point
puts one year at 0.17, fitting one year puts 90 days at 0.74 — so the knots are
stored rather than approximated by a formula that misses them.

Each document type divides its age by a `tau` first, which is how "research
decays fast, evergreen transcripts do not" is expressed against one shared
curve:

| Age | research (τ=1) | transcript (τ=3) |
| ---: | ---: | ---: |
| 7 days | 0.95 | 0.98 |
| 30 days | 0.85 | 0.94 |
| 90 days | 0.65 | 0.85 |
| 1 year | 0.30 | 0.61 |

**An undated document scores 0.50.** Not zero, which would bury 22 real pages
for a reason that is about our metadata rather than their merit; not one, which
would let them beat everything written this week.

### Diversity is applied during reranking

Five consecutive chunks of one podcast is a bad answer even when all five score
well. Each additional chunk from a document already represented is penalised,
and `max_per_document` caps it outright — so `DISCOVERY` returns five different
sources and `SUPPORT` is allowed to go deep on one.

### Keyword matching is OR, not AND

`websearch_to_tsquery` ANDs every term, so *"DSCR loans for new investors"*
demands the word "new" and returns nothing. Matching is therefore OR across
terms with a 1.6× multiplier for rows carrying every term — the same rule
`adspy.search_ads` and `content.search_content` already use, so all four corpora
now behave alike.

---

## What is switched off, and why

Three things are built, wired, and deliberately not on. Each is one `UPDATE`
away in `kb.retrieval_settings` or `kb.ranking_weights`.

### Strategic relevance is off

Weight `0.00`. The spec scores a candidate against the brand's current strategy
(§23), and `kb.content_strategies` and `kb.content_pillars` are empty — there is
nothing in the database describing what Trilith is trying to be known for.

**This is the biggest gap in the system**, because it is a quarter of the
intended ranking formula. Until it is filled, retrieval answers "what is
relevant to this query" but not "what is relevant to what we are trying to
build". To turn it on: populate the two tables, embed the pillars, then
`update kb.ranking_weights set strategic = 0.25, semantic = 0.45, keyword = 0.15,
recency = 0.15`.

### Hierarchical retrieval is off

§36 says not to implement it until the dataset warrants it. Over a few hundred
chunks a two-stage search is slower *and* less accurate than searching them
directly. `hierarchical_min_chunks` records 25,000 as the point worth revisiting.
Nothing turns it on automatically.

### Performance-aware ranking is off

`kb.published_content.performance` is empty on every row. Turning it on would
rank everything identically while looking like it was doing something.

---

## The pipeline

```
kb/files/  kb/sources.json
       │
       ▼
  kb-ingest      parse, hash, upsert       ← fast, safe to repeat
       │
       ▼
  kb-process     chunk, embed              ← the expensive half
       │
       ▼
   retrievable
```

Two steps, on purpose. Ingestion is fast and idempotent — an unchanged document
is recognised by its content hash and is neither re-chunked nor re-embedded, so
a daily run costs nothing. Processing is where the money goes, and it is
separate so that a Voyage outage cannot lose a harvest: documents stay queued
and the next run picks them up.

```bash
npm run kb              # ingest, then process
npm run kb:ingest
npm run kb:process
npm run kb:mirror       # derive topic/angle for published pages
npm run kb:summarise    # phase 3: summaries and topic insights
npm run kb:seed-hooks   # build the hook library from adspy.hook_patterns
```

Scheduled daily at 14:00 UTC by `.github/workflows/knowledge-base.yml`, an hour
after the creator pull and two after the ad pull. It writes nothing to git —
everything lands in Postgres — so there is no push to race over.

Getting material in is documented in [`kb/README.md`](kb/README.md).

### Uploading from the Plan page

There is a third way in, for a transcript you want searchable now rather than at
the next run: stage a text file in the planner's composer and press **Add to
library**. The Worker chunks it, embeds it, and it is retrievable in seconds.

Two deliberate limits.

**Text only** — `.txt` `.md` `.vtt` `.srt` `.json` `.csv` `.tsv`. PDFs and Word
documents keep going through `kb/files/`, where the Actions runner has
`pdf-parse` and `mammoth`. A Worker cannot run either, and half-extracting a PDF
would be worse than refusing it: the gaps would be invisible and the citations
would still look sound.

**A shared token is required.** `/kb/upload` is the only route that writes, and
the CORS allowlist is a browser control, not a security boundary — `curl` sends
whatever `Origin` it likes. Without a token, anyone who found the Worker URL
could put text into the corpus the planner is instructed to trust, which would
defeat every traceability guarantee here. Set it with
`npx wrangler secret put KB_UPLOAD_TOKEN`; the page asks for it once and keeps it
in `localStorage`. With no token set, the route returns 503 rather than running
unguarded.

Uploads are contained in the database as well as at the door. Every uploaded
document is forced into an `upload:` source-key namespace, and
`kb_upload_chunks` refuses any document outside it — so an uploader cannot
overwrite, re-chunk or empty a harvested transcript even knowing its id. The
worst it can do is add to its own namespace, which is the feature.

The route answers before the work finishes, per §12 and §40: the document is
written, the response goes out, and chunking and embedding continue under
`ctx.waitUntil`.

### Chunking

Transcripts and prose are chunked differently, per §13.

**Transcripts** break at speaker changes and pauses, inside a 300–800 token
band, keeping the speaker and the timestamps so a passage can be cited to the
second. A handover *plus* a real silence is treated as a change of subject and
breaks at a third of the usual floor — otherwise a short episode comes back as
one chunk covering two unrelated arguments, which is exactly the failure §14
describes.

**Prose** breaks at headings, then at paragraphs, never mid-paragraph, so a
table or a numbered finding stays whole. Undersized neighbours are packed
together; a short section is merged into its predecessor rather than dropped,
because "Conclusion: rates ease into Q4" is the most quotable line in a report
and losing it for being brief loses a finding.

### Embeddings

Voyage `voyage-3.5` at 1024 dimensions, recorded in `kb.embedding_config`.
Application code reads the dimension from there and **never hard-codes it**; a
trigger rejects any vector whose width disagrees, because a silently truncated
vector produces retrieval that is wrong rather than retrieval that is broken.

Chunks are embedded as `document`, queries as `query`. Voyage encodes the two
asymmetrically and using the wrong one costs real recall.

**Without `VOYAGE_API_KEY` the system still works.** Chunks are stored
unembedded, retrieval runs the keyword half alone, and every result carries
`degraded: true` so the planner says the search was partial rather than
concluding nothing exists. Run `npm run kb:process` again once the key is set
and the backfill vectorises what is waiting.

---

## The tools the planner gets

| Tool | Backed by | For |
| --- | --- | --- |
| `search_transcripts` | `kb_search_transcripts` | what was said, with speaker and timestamp |
| `search_research` | `kb_search_research` | reports and studies, with source and date |
| `search_previous_content` | `kb_search_previous_content` | what has already been published |
| `check_repetition` | `kb_assess_repetition` | new / related / repetitive / duplicate |
| `search_content_ideas` | `kb_search_content_ideas` | the idea memory |
| `save_idea` | `kb_save_idea` | keep an idea past the conversation |
| `search_hooks` | `kb_search_hooks` | hook forms by category and topic |

They sit alongside the five existing tools on the `/ideas` route, and every
search is streamed to the page as it runs. The wiring between the page, the
Worker and Postgres is documented in [PLAN-PAGE.md](PLAN-PAGE.md).

`kb.retrieve` also exists — one call across several corpora returning the §29
normalised context object under a hard token budget. The Worker does not use it;
the per-corpus tools give the model finer control, and the budget is enforced by
the limits on each. It is there for a caller that wants one shot at "everything
relevant to this".

### Attribution

The system prompt now separates three kinds of statement and forbids blurring
them: something a source says, something research shows, and something the model
thinks. The model may not say something came from a transcript unless a
transcript search returned it.

### Repetition detection

Semantic similarity alone cannot tell "we made this exact video" from "we
covered this topic from the opposite side". Topic and angle are compared by
trigram alongside the embedding, and a strong topic match with a weak angle
match is downgraded from *repetitive* to *related* — which stays recommendable,
because §33 says a related topic is still worth making when the angle differs.

**Without embeddings this check is materially weaker.** Trigram catches a
restatement in the same words and misses a paraphrase, and the tool says so in
its result rather than letting the planner over-trust it.

---

## Traceability

Every passage the planner is given carries a `chunk_id` and a `document_id`, and
transcripts carry timestamps. An idea saved to `kb.content_ideas` keeps
`source_ids` — all of them, not one — so "you talked about this in your podcast"
stays checkable months later.

Topic insights are held to the same rule and it is enforced rather than
requested: the summariser checks every chunk id the model cites against the
chunks actually sent, drops any insight whose citations are all invented, and
`kb_save_insight` refuses a row with no supporting sources at all. An insight
with a fabricated citation is a hallucination pre-baked into the database, where
it would be trusted later.

---

## Security

`kb` is **not** exposed over PostgREST. Wrappers in `public` are the only doors,
following the pattern `adspy` and `content` already use.

| | anon / authenticated | service_role |
| --- | --- | --- |
| Read corpora (`kb_search_*`, `kb_retrieve`) | ✅ `SECURITY INVOKER`, RLS in path | ✅ |
| Insert a retrieval log row | ✅ insert only, **cannot read** | ✅ |
| Insert / update ideas | ✅ | ✅ |
| Write documents, chunks, published, hooks | ❌ | ✅ `SECURITY DEFINER` |

Two deliberate exceptions to "anon reads, service_role writes":

- **`retrieval_log`** — anon may insert, because every search logs itself, but
  may not select. A log anon could read back is a log of everyone's planning.
- **`content_ideas`** — anon may insert and update. Idea memory is written
  during a session by the Worker, which holds the anon key. The harvested corpus
  stays read-only; the scratchpad does not need to be.

The Worker reads with the anon key, so the `/ideas` route physically cannot
rewrite a corpus.

---

## Cost

Voyage bills per token embedded. The corpus is embedded **once**: the content
hash means an unchanged document is never re-embedded, so a daily run over a
static library costs nothing. Re-chunking — changing the chunker — re-embeds
everything it touches, which is the one operation worth thinking about before
running.

Queries embed one short string per search. Anthropic tokens are spent only by
`kb:mirror`, `kb:summarise` and `kb:seed-hooks`, all of which are bounded per
run and skip work already done.

---

## What this will not tell you

**The website corpus counts every page twice.** `content.documents` holds 80
rows for 41 real pages — each one crawled as both `trilithfunding.com` and
`www.trilithfunding.com`. The mirror into `published_content` canonicalises on
the `www` form, so repetition detection sees each piece once. `search_trilith_content`
does not: it still returns both copies of a passage, which inflates any count
taken from it and wastes half of every result set. Fixing that means
de-duplicating the content harvest, which is outside this schema.

**An empty result is not an empty world.** It means nothing in *our* corpus
matched. The corpus is whatever has been dropped in `kb/files/` and listed in
`kb/sources.json` — nothing arrives on its own.

**A derived topic or angle is not the author's.** Every row the mirror writes is
marked `derivation: model-inferred` in metadata. Nobody at Trilith wrote "angle:
lower rates don't mean cheaper homes" on that post; a model read the post and
said so.

**A hook from the pattern library is not a competitor's hook.** Those forms come
from seven advertisers outside lending. Every row carries `origin:
hook_patterns` and `out_of_category: true`, and the planner is instructed to
describe them as adapted forms.

**Token counts are estimates.** Four characters to a token. Voyage publishes no
local tokenizer, and the number is only used to size a chunk and spend a budget.

**YouTube ingestion is the fragile part.** There is no public captions API that
does not require OAuth on the channel, so it reads the watch page — which
YouTube changes freely and which challenges datacenter IPs the same way Meta
does. Failures there are per-video and never stop a run.
