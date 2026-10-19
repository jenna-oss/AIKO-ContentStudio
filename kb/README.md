# Source material

Two ways in. Both are re-read on every run and keyed so that re-running is free:
an unchanged document is recognised by its content hash and is not re-chunked or
re-embedded.

## 1. Drop files in `kb/files/`

The folder decides the document type:

```
kb/files/transcript/   podcast and video transcripts
kb/files/interview/    interviews
kb/files/research/     market reports, studies, data
kb/files/report/       reports
kb/files/article/      articles
```

Readable without any extra install: `.txt` `.md` `.vtt` `.srt` `.json` `.html`.
`.pdf` and `.docx` need `npm install pdf-parse mammoth` — until then they are
reported as skipped rather than failing the run.

`.vtt` and `.srt` are always treated as transcripts regardless of folder, and
keep their speakers and timestamps, so a retrieved passage can be cited to the
second.

### Front matter

Optional, and only worth writing when the filename does not say enough:

```markdown
---
title: How B2B buyers research advisors before the first call
type: research
source: Publisher name
published: 2026-09-05
url: https://www.example.com/...
topics: buyer research, trust, LinkedIn
research_type: industry_report
---

The body starts here.
```

**`published` matters more than it looks.** With no stated date a document scores
0.50 on recency — neither fresh nor stale — because a file's modification time is
when it was copied onto this machine, not when the research was published, and
presenting one as the other would corrupt every recency score in the system.

## 2. Add URLs to `kb/sources.json`

```json
[
  {
    "url": "https://www.youtube.com/watch?v=...",
    "document_type": "transcript",
    "topics": ["founder-led go-to-market"]
  },
  {
    "url": "https://www.example.com/market-report",
    "document_type": "research",
    "source": "Publisher name",
    "research_type": "market_report"
  }
]
```

`document_type` is the only field worth setting by hand; title, source and date
are read off the page when it states them. Set `"disabled": true` to keep an
entry on file without fetching it.

YouTube URLs are detected automatically and their captions are pulled with
timestamps. **That fetcher is the fragile one:** there is no public captions API
that does not require OAuth on the channel, so it reads the watch page, which
YouTube changes freely and which challenges datacenter IPs the same way Meta
does. A failure there is per-video and never stops the rest of the run.

## 2b. Follow a feed in `kb/feeds.json`

For a blog, newsletter or release page that keeps publishing. Every run reads
the feed and fetches its newest posts as articles; posts already in the library
come back unchanged and cost nothing to embed.

```json
{
  "name": "Commercial Observer",
  "feed": "https://commercialobserver.com/feed/",
  "document_type": "article",
  "source": "Commercial Observer",
  "topics": ["commercial real estate"],
  "max_items": 5,
  "max_age_days": 14
}
```

`max_items` (default 5) and `max_age_days` (default 30) bound each run, so a
feed carrying 250 posts costs the same as one carrying ten. Each post is read
from its own page; when that page renders in JavaScript or turns bots away, the
full text in the feed is used instead. A Substack newsletter's feed is its
address plus `/feed`. Set `"disabled": true` to stop following one.

## 2c. AIKO's own content

Separate from the knowledge base: what the planner searches as "AIKO content"
to keep claims about the tool true. Put Markdown in `content/own/` (front matter
`title`, `kind` — positioning, page, faq or blog — and optionally `url` and
`published`), then `node tools/pull-content.mjs && node tools/push-content.mjs`.
The folder is gitignored because the positioning is internal and this repository
is public. Once AIKO has a site, set `OWN_SITE_SITEMAP` and its pages are read
alongside the files.

## 3. Upload from the Plan page

For something you want searchable immediately: stage a text file in the
planner's composer and press **Add to library**. Chunked, embedded and
retrievable in seconds, without waiting for the scheduled run.

Text only — `.txt` `.md` `.vtt` `.srt` `.json` `.csv` `.tsv`. PDFs and Word
documents go in `kb/files/` above, because the parsers for those cannot run in a
Worker. Behind the app's sign-in like every other route; nothing else to set.

## Then

```bash
npm run kb
```

Ingest is fast and safe to repeat. Processing — chunking and embedding — is the
slow half and runs separately, so nothing waits on it.
