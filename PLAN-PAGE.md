# The Plan page and the knowledge base

How `index.html` and the retrieval system are wired together: what happens
between typing a brief and reading an answer, and what happens between dropping
a transcript and being able to search it.

Three documents, three jobs, so you know which to open:

| Document | Answers |
| --- | --- |
| [RETRIEVAL.md](RETRIEVAL.md) | What is in the ad and website corpora, and their caveats |
| [KNOWLEDGE-BASE.md](KNOWLEDGE-BASE.md) | How the `kb` schema retrieves — ranking, chunking, what is switched off |
| **This one** | How the page, the Worker and Postgres connect |

---

## The shape of it

```text
                        Plan page  (index.html)
                    static, no build step, no key
                                 │
                    ┌────────────┴────────────┐
                    │                         │
              POST /ideas               POST /kb/upload
              read path                  write path
                    │                         │
                    ▼                         ▼
        ┌───────────────────────────────────────────────┐
        │        Cloudflare Worker  (trilith-ask)        │
        │  holds every key · anon Supabase · CORS gate   │
        └───────────────────────────────────────────────┘
                    │                         │
        ┌───────────┼───────────┐             │
        ▼           ▼           ▼             ▼
    Anthropic    Voyage      Postgres      Postgres
    (the model) (embed the  (12 search    (kb_upload_*,
                 query)      RPCs)         upload: namespace)
```

The page holds **no keys of any kind**. It knows one constant, `WORKER_URL`, set
at the top of the inline script. Everything spendable — Anthropic, Voyage, the
Supabase anon key, the upload token — lives as a Worker secret. That is the
whole reason the Worker exists.

---

## The read path: asking a question

### 1. The page posts a brief

```jsonc
POST <WORKER_URL>/ideas
{
  "brief":       "what should we make about DSCR this week",
  "history":     [ … up to 10 prior turns … ],
  "attachments": [ … images, PDFs, text staged in the composer … ],
  "session_id":  "plan-m1x8q2-7fa93b",
  "plan": {                       // the session, carried both ways
    "goal": "build authority on DSCR",
    "target_count": 3,
    "slots": [ { "status": "locked", "topic": "…", "angle": "…" }, … ],
    "rejected": [ { "topic": "…", "reason": "…" } ]
  }
}
```

There used to be a `mode: "plan"` here, switched on by a regex spotting a number
near the word "videos", and it sent `history: []` — planning threw the
conversation away to run. "Make it four instead" arrived as a brand new batch
with no memory of the three already settled. The plan object replaced it: the
agent moves the state with tools, so the count and the topics are negotiated
rather than guessed at from the phrasing.

`attachments` are read **once, for this message**. They are not stored and not
retrievable later — that is what the upload path below is for, and confusing the
two is the most common misunderstanding of this page.

### 2. The Worker runs a tool loop

Up to **8 rounds**, each one model turn plus its tool calls. It was 6 before the
knowledge base landed; progressive retrieval spends rounds deliberately — a
broad pass, a deeper one on whatever mattered, a repetition check — and six left
no room to do that and still answer.

Eighteen tools: twelve that search, five that move the session, one that proposes a batch.

| Tool | Corpus | Retrieval |
| --- | --- | --- |
| `search_competitor_ads` | `adspy` | keyword |
| `count_ads` | `adspy` | exact count over every row |
| `search_hook_patterns` | `adspy` | keyword |
| `search_trilith_content` | `content` | keyword |
| `trilith_coverage` | `content` | listing |
| `search_transcripts` | `kb` | **hybrid** |
| `search_research` | `kb` | **hybrid** |
| `search_previous_content` | `kb` | **hybrid** |
| `search_content_ideas` | `kb` | **hybrid** |
| `check_repetition` | `kb` | similarity + trigram |
| `search_hooks` | `kb` | structured filter |
| `save_idea` | `kb` | write |
| `set_video_count` | session | fixes the batch size, creates the slots |
| `lock_video` | session | fixes one topic — only once the person agreed to it |
| `unlock_video` | session | clears a slot |
| `reject_idea` | session | records a turn-down, read back on later turns |
| `remember_file` | `kb` | write — puts an attached text file in the library |
| `submit_plan` | — | proposes a reviewable batch of candidates |

The seven `kb` tools each embed their query with Voyage first, then call a
`public.kb_*` wrapper. The five older ones go straight to Postgres — those
corpora have no vector layer.

### 3. Results stream back as they happen

Server-sent events, `event:` / `data:` frames split on a blank line, parsed by
`assets/chat.js`:

| Event | Carries |
| --- | --- |
| `start` | the turn has begun |
| `tool` | one search, as it runs — label and arguments |
| `token` | a fragment of the answer |
| `note` | a status line (round limits, degraded retrieval) |
| `plan` | a proposed batch of candidates, from `submit_plan` |
| `plan_state` | the session after a change — mid-turn as things are agreed, and again at the end |
| `error` | a readable failure |
| `done` | token usage, and whether the plan is complete |

`plan_state` is sent the moment a topic is locked rather than at the end of the
turn, because a locked video that only appears after the answer finishes reads
as though nothing was recorded. It is also sent once more at the end regardless,
so a page that missed an event still converges.

The page no longer lists `tool` events or the `done` usage line. Seeing every
search go past made the conversation hard to follow. While the agent works, the
page shows one quiet status line ("Thinking…", "Looking into it…", "Saving…").
Searches, notes and token usage go to the browser console as `[aiko] …` lines,
so they can still be audited. The evidence behind a locked video goes into that
slot's `evidence` and `source_ids`, not into the chat.

`assets/chat.js` is shared with the briefing page's floating panel — one parser,
because two hand-maintained SSE readers would drift and the drift would show up
as the two pages answering differently.

---

## The write path: adding to the library

Stage a text file in the composer and a second row appears — a count, a type
selector, and **Add to library**.

```jsonc
POST <WORKER_URL>/kb/upload
Authorization: Bearer <KB_UPLOAD_TOKEN>
{
  "name":          "episode-17.vtt",
  "text":          "WEBVTT\n\n00:20:40.000 --> …",
  "document_type": "transcript"
}
```

What happens next, in order:

1. **Token checked**, in constant time. Wrong or missing → `401`.
2. **Format checked.** `.txt` `.md` `.vtt` `.srt` `.json` `.csv` `.tsv` only.
3. **`kb_upload_document`** writes the row as `pending` and hashes the body.
   Unchanged content returns `unchanged` and stops — no re-chunk, no re-embed.
4. **Chunked** — transcripts by speaker and pause, prose by heading.
5. **`202 accepted` is returned**, with the chunk count.
6. **Embedding continues after the response**, under `ctx.waitUntil`, then
   `kb_upload_chunks` stores them and the document flips to `ready`.

Steps 5 and 6 are in that order deliberately. The spec requires ingestion to be
asynchronous, and nobody should watch a spinner while an embedding API is
called. The file is searchable a few seconds after the page says it was
accepted.

### Why this route is guarded and the other is not

`/ideas` reads. `/kb/upload` writes, and it is the only thing here that does.

The CORS allowlist in `worker/src/index.js` protects neither: it stops
**browsers** from calling the Worker from an unapproved origin, and `curl` sends
whatever `Origin` header it likes. For a read endpoint that is an acceptable
control — the worst case is someone spending your Anthropic credit. For a write
endpoint it is not: anyone who found the URL could put text into the corpus that
the planner retrieves, cites, and is instructed to trust.

So the guard is two-deep:

- **`KB_UPLOAD_TOKEN`** at the door. Unset → the route returns `503` rather than
  running unguarded.
- **The `upload:` namespace** in the database. Every uploaded document's
  `source_key` is forced into it, and `kb_upload_chunks` refuses any document
  outside it — so an uploader who somehow learned a harvested podcast's id still
  cannot replace its chunks with words the planner would attribute to Trilith.

The second layer exists because the first is a shared secret, and shared secrets
leak.

---

## Attach or add? They are not the same

The single most useful distinction on this page:

| | Attach to brief | Add to library |
| --- | --- | --- |
| Read by | the model, once | every future session |
| Stored | no | yes, chunked and embedded |
| Retrievable later | no | yes, by any search tool |
| Formats | images, PDFs, text | text only |
| Needs a token | no | yes |
| Good for | "look at this screenshot" | "here is the podcast transcript" |

PDFs stop at attachment on purpose. `pdf-parse` and `mammoth` are Node libraries
and do not run in a Worker, and extracting a plausible-looking fraction of a PDF
would be worse than refusing it — the gaps would be invisible and the citations
would still look sound. PDFs go in `kb/files/`, where the Actions runner has real
parsers.

---

## Where the plan lives

The page shows only the conversation. There is no plan panel. Every visit starts
a fresh session with an empty plan. The plan is carried with each request in
page memory and written to `kb.planning_sessions` after every turn, which is the
durable copy the render workflow reads.

A `?session=<id>` link still reopens a specific stored plan.

`kb.planning_sessions` is addressed by id and nothing else — no table grants for
anon, two `SECURITY DEFINER` functions as the whole surface — because the id is
the only thing separating one person's plan from another's.

Nothing in it is embedded or reachable from a search tool. Spec section 4D keeps
session context out of the retrieval corpus, and it stays out; "not retrieved
against" is not the same as "not stored".

## Configuration

Everything that must be set, and what breaks if it is not.

### The page

`WORKER_URL`, at the top of the inline script in `index.html`. Until it is set
the page loads and shows setup instructions rather than failing.

### Worker secrets

```bash
cd worker
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put VOYAGE_API_KEY     # optional
npx wrangler secret put KB_UPLOAD_TOKEN    # optional
npx wrangler deploy
```

`SUPABASE_URL` is a `[vars]` entry in `wrangler.toml`, not a secret — it ships in
every Supabase client app.

| Missing | What happens |
| --- | --- |
| `SUPABASE_URL` or `SUPABASE_ANON_KEY` | `/ideas` returns `503` before doing anything, naming the specific binding that is unset |
| `ANTHROPIC_API_KEY` | no precheck — the request reaches the SDK, comes back 401, and surfaces as "The API key is missing or invalid on the server" |
| `VOYAGE_API_KEY` | searches still answer, keyword-only, every result flagged `degraded` |
| `KB_UPLOAD_TOKEN` | `/kb/upload` returns `503`; the read path is unaffected |

The asymmetry in the first two rows is real rather than intentional: the
Supabase bindings are checked by name up front because a secret created with an
empty value looks present to `wrangler secret list`, and "one of these two is
unset" sends you looking in the wrong place. `ANTHROPIC_API_KEY` never got the
same treatment, so a missing one is diagnosed a round trip later.

`KB_UPLOAD_TOKEN` is **not** issued by a vendor — you invent it. It is a shared
secret: the same string sits in the Worker and is typed into the page once per
browser, kept in `localStorage`. Generate one with

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Rotating it costs each person one paste: the page clears its stored copy on a
`401` and asks again.

### Repository secrets

For the nightly pipeline, not the page: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `VOYAGE_API_KEY`, and `ANTHROPIC_API` — note that
last name. The scripts read `ANTHROPIC_API_KEY`; the stored secret is called
`ANTHROPIC_API`, and both workflows map between them explicitly.

The service role key bypasses RLS entirely. It belongs in CI secrets and
**never** in the Worker — putting it there would give a public endpoint the
ability to rewrite every corpus.

---

## Reading a degraded answer

When `VOYAGE_API_KEY` is absent or Voyage fails, `kb` tools return
`degraded: true` and the model is instructed to say the search was partial
rather than concluding nothing exists.

Two consequences worth knowing, because neither is obvious from the answer:

- **Retrieval is running on 20% of its ranking.** Semantic is 60% of the score
  and contributes nothing; only keyword and recency remain.
- **`check_repetition` gets materially weaker.** It falls back to trigram
  overlap, which catches a restatement in the same words and misses a
  paraphrase. An idea it calls `new` may not be.

The tool result says so in both cases. If an answer looks thin, check whether it
was degraded before concluding the corpus is empty.
