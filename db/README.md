# Schema

The `kb` schema is defined by 47 migrations applied to the Supabase project
`YOUR-PROJECT-REF`, listed below in order. They are **not** duplicated here
as files, for the same reason `adspy` and `content` are not: Supabase holds the
authoritative record in `supabase_migrations.schema_migrations`, and a
hand-maintained second copy drifts. `data/sql/` holds data loads, never DDL.

To pull them into this repo as files:

```bash
npx supabase link --project-ref YOUR-PROJECT-REF
npx supabase db pull
```

## The migrations

| # | Name | What it does |
|---|---|---|
| 1 | `kb_foundation` | schema, pgvector, embedding config, ranking weights, recency curve, brands/strategies/pillars |
| 2 | `kb_documents` | `documents`, `document_chunks`, the dimension guard, the ingest queue |
| 3 | `kb_content_and_logging` | `published_content`, `content_ideas`, `hooks`, `retrieval_log` |
| 4 | `kb_knowledge_layer` | phase 3: `document_summaries`, `topics`, `topic_insights`, `retrieval_settings` |
| 5 | `kb_scoring` | `recency_score`, `strategic_score`, `search_chunks` |
| 6 | `kb_search_tools` | `search_transcripts`, `search_research`, `search_previous_content`, `search_content_ideas`, `search_hooks` |
| 7 | `kb_retrieval_service` | `assess_repetition`, `log_retrieval`, `save_idea`, `retrieve` |
| 8 | `kb_retrieve_limit_fix` | `p_limit` was applied to the aggregate row rather than the rows aggregated, so it did nothing |
| 9 | `kb_security_and_api` | RLS on every table, grants, the `public.kb_*` wrappers |
| 10 | `kb_keyword_recall` | OR matching with an all-terms bonus; `websearch_to_tsquery` ANDed every term and returned nothing for ordinary questions |
| 11 | `kb_write_rpcs` | `kb_upsert_document`, `kb_replace_chunks`, `kb_set_embeddings`, `kb_upsert_published` |
| 12 | `kb_pipeline_read_rpcs` | queue readers, `kb_save_summary`, `kb_save_insight` |
| 13 | `kb_ready_without_embeddings` | a document is retrievable once chunked; holding it until every chunk had a vector hid the whole corpus when no embedding key was set |
| 14 | `kb_content_mirror_source` | pages in `content` not yet mirrored into `published_content` |
| 15 | `kb_hook_seed_rpcs` | hook patterns not yet adapted into the hook library |
| 16 | `kb_pin_search_path` | pinned `search_path` on all 25 kb functions |
| 51 | `kb_hook_embeddings` | hooks get vectors and hook search ranks by meaning: `kb_search_hooks` takes `p_embedding` (appended, so the four-argument call still works) and returns `relevance`; with an embedding the topic is a boost rather than a filter. `kb_upsert_hooks` takes an `embedding`; `kb_hooks_pending_embedding` / `kb_set_hook_embeddings` (service role) for `tools/kb-embed-hooks.mjs`; HNSW index on `hooks.embedding` |
| 50 | `kb_recent_photos` | the library photos the newest videos used (`metadata.photos`, opening photo first, written by render-videos.yml's store job), service role only, so a new render can leave them out |
| 49 | `kb_clip_edit_done_hook` | `kb_clip_edit_done` also takes the clip's new opening sentence (`p_hook`), since a new start or a fixed word changes what the hook card shows |
| 48 | `kb_clip_edit_state_anon` | the Worker (anon key) may mark a clip edit failed when it could not start the run |
| 47 | `kb_plans_recent_title` | `kb_plans_recent` names a plan by its goal, else its first topic |
| 46 | `kb_app_v6` | the app's one layout (Create · Videos · Library · Schedule). `kb_video_set_review` takes `review`, which clears a decision (an undone reject, or a video moved back to be edited). Clips become editable: `clips` gains `cuts` and `fixes` (sections cut out and words corrected, both in the take's clock so a fix survives a later trim), `edit` (the requested window), `edit_status` / `edit_error` / `edit_summary` / `edited_at` / `edits`; `kb_clip_edit_info` (the window plus the take's words a minute either side), `kb_clip_request_edit` (checks the window, at most 10 cuts and 80 fixes, one edit at a time, 30 a day), `kb_clip_edit_state` and `kb_clip_edit_done` for cut-footage.yml. `kb_video_library` gives a clip its length less what is cut out and its edit as `last_edit`. `kb_uploads_list` / `kb_upload_delete` show and remove what was put into the knowledge base by hand (the `upload:` namespace only). `kb_plans_recent` lists plans to pick back up |
| 45 | `kb_posts_upload_post` | posting through Upload-Post: `posts.platform` also allows `youtube` and `tiktok`, and `posts.title` holds the YouTube title (`kb_post_create` takes `p_title`). For an Upload-Post post, `container_id` is Upload-Post's request id, followed by the next cron run. `social_settings` with `kb_social_get` / `kb_social_set` keeps small Worker settings, so far which Facebook Page to post to when the connected account manages several |
| 44 | `kb_meta_pages` | Facebook Login replaces Instagram Login, so one approval by a Business Portfolio admin covers the Page and the Instagram account linked to it: `meta_pages` holds every Page the approval covered, each Page token **encrypted** with the Worker's `META_TOKEN_KEY` (a Page token from a long-lived user token does not expire, so there is no renewal), and `selected` marks the one posts go to. `kb_meta_save` / `kb_meta_account` (no tokens) / `kb_meta_pick` / `kb_meta_secret` / `kb_meta_forget`. Drops the never-used `ig_account` and its four functions; `ig_ticket` stays as the OAuth ticket. `posts` gains `platform` (`instagram` / `facebook`), one row per platform so each keeps its own progress and link; `kb_post_create` takes `p_platform` and `kb_posts` returns it |
| 43 | `kb_clips_in_the_library` | clips join the video library: `kb_video_library` unions ready clips with renders and gains a `kind` column, so one call feeds Output, Edit and Schedule and each can tell the two apart. A clip takes its take's name as the topic and the sentence it opens on as the hook. Reviewing is the same for both, so clips gain `review_status` / `reviewed_at` and `kb_video_set_review` looks in both tables |
| 42 | `kb_clips` | shorts cut out of a take: `clips` is a window on the footage (a start and an end in seconds) plus the words said inside it, with their timings rebased to the clip's own clock — which is what lets the captions land on the word without transcribing anything twice. `hook` is the sentence it opens on, the whole reason the clip exists, and `why` is the agent's reasoning, kept so a bad run can be read rather than guessed at. `kb_clip_create` / `_state` / `_read` / `_reject` and `kb_clips`; both the Worker and the cutting workflow write through them |
| 41 | `kb_footage` | raw footage, before it is cut into shorts: the private `kb-footage` bucket (5GB a file) and `footage` (the take, its status, and the transcript kept twice — plain text to read, word timings to cut on). The only bucket whose policies are for `authenticated` rather than the Worker's anon key, because a 4GB file cannot pass through a Worker at all (Cloudflare caps a request body at 100MB), so the browser uploads straight to storage with the session it already holds. Scoped to this bucket and to emails on `kb.app_users`, since this project is shared and `authenticated` means more people here than it does in this app |
| 40 | `kb_posts` | posts waiting to go to Instagram, which has no scheduling of its own: `posts` (kind, the media as `[{url, kind}]` so a reel, an image and a carousel are one table rather than three, caption, when, and where it got to with Instagram), plus `kb_post_create` / `kb_posts` / `kb_post_read` / `kb_post_edit` / `kb_post_cancel` / `kb_post_state`. `kb_post_claim` is the one that matters: publishing is two calls with processing in between, so a post is a state machine any cron run can resume, and the claim is an update only one run can win — two overlapping runs can never publish the same post twice |
| 39 | `kb_instagram_account` | (`ig_account` replaced by 44) connecting the Instagram account posts go to: `ig_account` holds the access token **encrypted** — this project is shared with other AIKO tools, so anything with its anon key can call `kb_ig_secret`, and what that returns is ciphertext the Worker's `INSTAGRAM_TOKEN_KEY` opens — and `ig_ticket` is the one-use, ten-minute ticket that stands in for a session on the OAuth callback, which arrives as a browser navigation with no header on it. `kb_ig_account` is the half the page may see: who, and until when |
| 38 | `kb_light_reads` | three reads that were pulling far more than they needed: `kb_link_status` is a link's row without its body, for the poll the Plan page runs every two seconds while a page is being read (an article can be 200,000 characters, and the Worker was throwing the text away after transferring it), and `kb_links_by_ids` / `kb_recordings_by_ids` take the handful of ids a planning session picked instead of listing 200 rows to filter in the Worker |
| 37 | `kb_scripts` | scripts for solo talking-head videos, the ones read to camera rather than spoken over b-roll: `scripts` (the planned slot it came from, the lines, the word count, what the checks flagged, written or filmed) and `kb_script_save` / `kb_scripts` / `kb_script_read` / `kb_script_lines` / `kb_script_status` / `kb_script_delete`. One script per slot — writing it again replaces it, because a slot has one script the way it has one video |
| 36 | `kb_link_create_skip_partial` | pasting a link again hands back the read we already have, but only a real one: a partial read is a video whose words could not be got, and caching that meant the first paste after the transcript service was wired up returned the description again without asking anyone for a transcript |
| 35 | `kb_links_transcript_job` | a transcript that has to be generated rather than fetched comes back as a job that can take minutes, which is far longer than a Worker should wait: `links.job_id` parks it, `kb_link_job` stores it alongside what is already known about the video, and the page's own polling of `/links/read` is what collects the result. The body saved at that point is the description, kept as the fallback if the job fails |
| 34 | `kb_links` | a link pasted on the Plan page: `links` (url, canonical url, kind, the extracted text, whether it is partial, the document it became) and `kb_link_create` / `_ready` / `_failed` / `_read` plus `kb_links` for the Worker. Pasting the same canonical url inside 30 days hands back the row already read rather than fetching it again |
| 33 | `kb_recordings` + `kb_recordings_own_bucket` | voice recordings from the Recordings page: `recordings` (audio path, transcript, words, status, the document its transcript became), `kb_recording_create` / `_ready` / `_failed` / `_read` / `_rename` / `_delete` and `kb_recordings` for the Worker, and the private `kb-recordings` bucket with anon insert/read/delete on it. The second migration exists because `recordings` was already taken: another AIKO tool made a public bucket of that name in May, and the first migration's `on conflict do nothing` would have put private audio in it |
| 32 | `kb_video_edit_remake_and_script` | the Edit page's re-make and script panel: `video_edits` gains `mode` (`exact` / `remake`; a video without a kept source is always re-made; 3 re-makes a day inside the 10 edits) and `script_changes` (`[{line, from, to}]`, checked against the lines saved in the video's `metadata.script`); `kb_video_request_edit(uuid, jsonb, text, jsonb)` replaces the two-argument version; `kb_video_edit_start` and the library's `last_edit` carry the mode; `kb_video_script` (open, for the Worker) reads a video's lines; `kb_video_scripts_missing` / `kb_video_set_script` (service role) are for the backfill-scripts workflow |
| 31 | `kb_video_edit_newest_only` | `kb_video_request_edit` refuses any version of a video but the newest (`newer: true`), so a page loaded before another edit finished can't overwrite it; the Edit page then moves the unsent notes onto the newer version |
| 30 | `kb_app_users` | who may use the app: the allowlist the Worker checks at sign-in and on every request, and `kb_app_user_allowed` (anon, for the Worker). Supabase Auth is shared with other AIKO tools, so nothing is added to `auth.users` |
| 29 | `kb_plan_renders` | the Plan page's Render button: `plan_renders` is the once-per-plan guard and the ledger for a 12-videos-a-day cap (a failed start still counts); `kb_plan_request_render` (open) and `kb_plan_render_abandon` for the Worker |
| 28 | `kb_video_edit_notes` | edits arrive from the Edit tab as notes (`notes` jsonb: up to 8, each optionally pinned to a moment in seconds); `kb_video_request_edit(uuid, jsonb)` replaces the text version and refuses videos not in Ready to review; `kb_video_edit_start` also returns the notes and the video's storage path, for the frame grabs |
| 28a | `kb_video_edit_finish_guard` | an edit's outcome can only be recorded while it is queued or running |
| 27 | `kb_video_edits` | typed edits to finished videos: the `video_edits` queue, the private `video-sources` bucket, `kb_video_request_edit` (open, rate-limited) and `kb_video_edit_abandon` for the Worker, `kb_video_edit_start` / `kb_video_edit_finish` for the workflow; the library gains `has_source` and `last_edit` |
| 26 | `kb_video_review` | replaces 25: `review_status` (`to_post` / `rejected`, null = ready to review) and `reviewed_at`, set by `kb_video_set_review`; rows marked posted carry over as `to_post`, and `posted_at` and `kb_video_set_posted` are dropped |
| 25 | `kb_video_posted` | `posted_at` on renders, the library returns it, and `kb_video_set_posted` marks or unmarks a finished video (the Worker gates it with the team token) |
| 24 | `kb_video_library` | finished videos for the Output page: rendered only, newest per slot, title and opening line from the plan |
| 23 | `kb_video_renders` | the videos bucket and the row tying each render back to its brief |
| 22 | `kb_plans_ready_to_render` | locked plans, newest first — how briefs reach CI without a committed file |
| 21 | `kb_effectiveness_resolve_urls` | resolve cited URLs to row ids, or the section 39 metric reads zero forever |
| 20 | `kb_retrieval_effectiveness` | the section 39 metric as a view: how many retrieved sources reached a saved idea |
| 19 | `kb_planning_sessions` | durable plan storage, bulk retrieval logging |
| 18 | `kb_mirror_canonical_url` | one row per real page: the content corpus holds every page twice, under `www.` and bare hostnames |
| 17 | `kb_upload_rpcs` | `kb_upload_document` and `kb_upload_chunks` — the only write path anon can reach, contained to the `upload:` source-key namespace |

Three of these — 8, 10 and 13 — are corrections to earlier ones in the same
batch, kept as separate migrations rather than folded back so the reasoning
stays readable. Each is described in the migration's own comment.
