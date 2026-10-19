# Trilith Marketing Tool — design brief

Built by **AIKO** (aikogroup.io) for the client **Trilith Funding**, a private
real estate lender financing investors — fix-and-flip, bridge, DSCR, ground-up,
BRRRR, multifamily.

This document is the handoff for design work. Part 1 records the system as it
exists today so new work matches it. Parts 2 and 3 specify two sections that do
not exist yet and need designing.

Everything in Part 1 is extracted from the live code, not from memory. Every
value is real and currently in use.

---

## 0. What the product is

An internal tool, not a public marketing site. Two audiences: AIKO strategists
and Trilith's marketing lead. It is `noindex, nofollow` and unlisted.

It does three jobs today:

1. **Shows** what every competing lender is advertising, refreshed daily.
2. **Answers** questions about that data, grounded and cited.
3. **Plans** batches of short-form video concepts, which a human confirms before
   they are locked.

The two new sections extend job 3 into production: getting raw footage in, and
seeing finished video come out.

### Current pages

| URL | Page | Contains |
| --- | --- | --- |
| `/` | Brainstorm & plan | Batch planner, angle starters, chat transcript |
| `/briefing.html` | Competitive intelligence briefing | Long analytical document + floating Ask panel |
| `/ideas.html`, `/ask.html` | Redirects to `/` | Retired URLs, kept so old links do not 404 |

Navigation is a two-item pill menu in the header of both pages, with the current
page marked by `aria-current="page"` and styled as selected rather than as
another destination. **The new sections join this menu**, taking it to four
items — see §4 for the consequence.

---

## 1. The AIKO design system, as built

### 1.1 Colour

Two themes. Light is the default; dark activates on
`@media (prefers-color-scheme: dark)`. Both are already implemented — **any new
screen must work in both**.

The palette is a forest-green and cream system. It is deliberately quiet: this
is a document to be read and a tool to be worked in, not a landing page.

**Brand constants** — the same in both themes:

| Token | Hex | Role |
| --- | --- | --- |
| `--forest` | `#0B3529` | The signature dark green. Panels, mastheads. |
| `--forest-deep` | `#072A1F` | Deeper green for layering |
| `--cream` | `#ECE9D8` | The signature light ground |
| `--cream-text` | `#EAE9D5` | Text on dark green |
| `--emerald` | `#2C785E` | Primary action |
| `--emerald-bar` | `#407C62` | Accent rules, left borders |
| `--sage` | `#6E9C86` | Muted green — secondary text on dark |
| `--clay` | `#A65A3C` | Warning, absence, "nothing here" |
| `--ochre` | `#B5823F` | Secondary highlight, used sparingly |

**Themed tokens** — resolve differently per theme. Always use these, never a raw
hex, for anything that sits on a surface:

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--ground` | `#ECE9D8` | `#072A1F` | Page background |
| `--panel` | `#0B3529` | `#0B3529` | Dark panel background |
| `--panel-deep` | `#072A1F` | `#04201760` | Deepest panel |
| `--card` | `#F4F2E7` | `#0E3B2C` | Card surface |
| `--card-sunk` | `#E3DFCB` | `#0A3125` | Recessed surface, inputs |
| `--ink` | `#103224` | `#EAE9D5` | Headings, emphasis |
| `--ink-body` | `#3B5850` | `#B9C9C0` | Body text |
| `--ink-quiet` | `#6F8279` | `#7E9A8D` | Metadata, captions |
| `--rule` | `#D2CDB6` | `#1C4A3A` | Hairline borders |
| `--rule-strong` | `#B8B29A` | `#2A5D4A` | Input borders, stronger dividers |
| `--accent-on-ground` | `#2C785E` | `#6E9C86` | Accent on the page background |
| `--accent-on-panel` | `#6E9C86` | `#6E9C86` | Accent on dark panels |
| `--clay` | `#A65A3C` | `#C87A57` | Warning / absence |
| `--ochre` | `#B5823F` | `#D0A05C` | Secondary highlight |

> **Note for new components.** The two existing pages name their accent
> differently — `--accent-on-ground` on the briefing, `--accent` on the planner.
> Shared components resolve this with a local alias
> (`--chat-accent: var(--accent, var(--accent-on-ground, #2C785E))`). New shared
> components should follow the same pattern rather than picking one.

### 1.2 Typography

```css
--sans:  "Poppins", "Century Gothic", "Avenir Next", "Futura",
         system-ui, -apple-system, "Segoe UI", sans-serif;
--mono:  ui-monospace, "Cascadia Mono", "Cascadia Code", "SF Mono",
         Consolas, monospace;
--quote: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
```

- **Poppins** is the AIKO face. Geometric, slightly wide. Century Gothic is the
  intentional fallback — same geometric character.
- **Mono** is used for data: counts, dates, IDs, search queries, usage figures.
  If a number is machine-produced, it is mono.
- **Serif** is reserved for pull-quotes. Rare.

Base size is `16px`, body line-height `1.6`. Page headline is
`clamp(2rem, 4.4vw, 3.25rem)`. Headings use `font-weight: 700` and tight
line-height (`1.12`).

**Eyebrow labels** — the recurring section-marker pattern:
`font-size: .625rem; letter-spacing: .14em; text-transform: uppercase;
font-weight: 700`, coloured with the accent. Used above every section heading
and above control groups.

### 1.3 Spacing

An eight-step scale. Use these, not arbitrary values.

```css
--s1: .5rem;   --s2: .75rem;  --s3: 1rem;    --s4: 1.5rem;
--s5: 2rem;    --s6: 3rem;    --s7: 4.5rem;  --s8: 6.5rem;
```

Content column is `max-width: 1080px` with `var(--s4)` side padding. Reading
columns inside it narrow to `68ch`.

### 1.4 Shape and motif

- **Border radius is small — `4px` for cards, panels, inputs and buttons.** The
  system is rectilinear and document-like.
- **Pills (`999px`) are for interactive chips only**: nav items, filter buttons,
  starter prompts. The contrast between square surfaces and round controls is
  deliberate — round means clickable.
- **The AIKO mark** is a thin circle with `AIKO` centred inside, drawn as inline
  SVG: `stroke #6E9C86`, `stroke-width 1.25–1.5`, wordmark in `--cream-text`.
  It appears at 28–30px in headers, 20px in compact bars.
- **The circle motif** repeats as large translucent circles (`#ffffff08`) bleeding
  off the edges of dark panels. Faint, never decorative enough to notice first.
- **Left accent bars** — a `3px` left border in `--emerald-bar` or `--clay`
  marks a callout card. This is the primary way emphasis is added without colour
  fills.
- Shadows are almost absent. The floating chat panel is the exception:
  `0 12px 40px #0b352940`.

### 1.5 Component patterns already in use

| Pattern | Behaviour |
| --- | --- |
| **Card** | `--card` surface, `1px solid var(--rule)`, `4px` radius, often a `3px` left accent bar |
| **Data table** | Hairline rules, mono numerals, first column is the entity name |
| **Filter row** | Pill buttons, `aria-pressed`, filters a grid below |
| **Creative card** | Thumbnail left, copy right, metadata chip row at the bottom |
| **Floating panel** | Fixed bottom-right, `min(30rem, …)` wide, dark header bar, scrolling body, composer footer. Full-screen below 560px. |
| **Setup note** | Dashed `--clay` border. Shown when a backend is unconfigured. |
| **Absence** | The word, in `--clay`, never an empty cell. "no paid ads", not blank. |

### 1.6 Voice

Reflect this in labels and empty states. It is as much a part of the brand as
the palette.

- Plain and declarative. No exclamation marks, no marketing adjectives.
- Numbers are stated with their basis. "781 live ads from 249 advertisers",
  not "hundreds of ads".
- **Uncertainty is stated, not hidden.** The briefing says out loud that ad
  count is not spend and that absence from the corpus means "we did not observe
  it", not "it does not exist". New surfaces must preserve this instinct —
  especially anything reporting an automated result.
- Sentence case for headings. Title Case is not used.

---

## 2. NEW — Video editing tab

**Status: does not exist. Needs designing and building.**

### 2.1 The job

A user drops raw footage in; short-form vertical video comes out. This is the
production half of the planner: a locked batch of concepts (§2.5) says what to
make, this is where the footage becomes those videos.

### 2.2 The flow to design

```
  Select a locked concept  →  Drop raw footage  →  Processing  →  Review  →  Publish to Output
     (or none)                (one or many files)    (queue)       (accept/reject)
```

Each stage needs a designed state:

**1. Intake.** A drop zone large enough to be the obvious target, accepting drag
and drop and a file picker. Must handle multiple files and long uploads. Needs:
per-file progress, total progress, cancel, remove-before-processing, and a clear
statement of accepted formats and size limits. Design the rejection state — wrong
format, too large — as informative, not a red flash.

**2. Attach to a concept (optional).** A picker listing locked concepts from the
planner, showing topic and opening line. Choosing one carries the hook into the
edit. Skipping it is allowed — not all footage is planned in advance.

**3. Processing.** Jobs are queued and slow — minutes, not seconds. Needs a
queue view where each job shows: source filename, attached concept if any,
stage, elapsed time, and a cancel. **Design for the failure case as carefully as
the success case** — a job can fail on a corrupt file, an unsupported codec, or a
timeout, and the user needs to know which without reading a log.

**4. Review.** Each finished cut is previewed before it counts as done. Accept,
reject, or send back with a note. A rejected cut should say what happens next.

### 2.3 States to design

Do not design only the happy path. All of these will occur:

- Empty — no footage ever uploaded
- Uploading — one file, and many files at different progress
- Queued — waiting behind other jobs
- Processing — with elapsed time
- Failed — with a cause the user can act on
- Ready for review
- Accepted / rejected
- Backend unavailable (there is an existing pattern for this — the dashed clay
  setup note)

### 2.4 Constraints

- Vertical 9:16 output. Any preview surface should be portrait-shaped.
- Uploads are large. Design assuming a slow connection and an interrupted one.
- This runs in a browser tab the user may navigate away from — the queue must be
  recoverable, and the design should say so rather than implying the tab must
  stay open.

### 2.5 What already exists to connect to

The planner produces locked batches as JSON. Each brief carries:

```json
{
  "topic": "The 10-property conventional cap",
  "hook_form": "first-person refusal narrative",
  "hook_source": "LendingTree",
  "opening_line": "I asked my bank to finance my eleventh rental.",
  "evidence": "Absent from all 30 DSCR ads in the corpus.",
  "product": "dscr",
  "audience": "borrower"
}
```

`product` is one of: `dscr`, `fix-and-flip`, `bridge`, `ground-up`, `portfolio`,
`brrrr`, `multifamily`. `audience` is `broker` or `borrower`. These are the
natural filters for both new sections.

---

## 3. NEW — Video output page

**Status: does not exist. Needs designing and building.**

### 3.1 The job

Where the user sees finished short-form video. A library, not a feed.

### 3.2 What it shows

A grid of finished videos. Each item needs:

- Portrait (9:16) thumbnail with an obvious play affordance
- The topic it was made from
- The hook form and where it was borrowed from
- Product line and audience
- Date produced
- Duration
- Status — draft, approved, published
- Download, and copy-link

### 3.3 Interactions

- **Filter** by product line, audience, and status. Reuse the existing pill
  filter-row pattern from the briefing's creative wall — same component,
  same behaviour.
- **Play inline** rather than navigating away. The briefing's creative wall
  already opens assets directly; match that directness.
- **Detail view** showing the full brief that produced the video — topic, hook,
  opening line, and the evidence that justified it. **This is the important
  one**: it closes the loop from competitor evidence, through hook, to finished
  asset, and it is the thing that makes the tool defensible to the client.

### 3.4 States to design

- Empty — nothing produced yet, with a route to the editing tab
- A handful of videos
- Many videos, where filtering starts to matter
- A video that failed to render
- Loading

---

## 4. Cross-cutting notes

**Navigation.** Two items is a pill row; four starts to need thought. Decide
whether the nav stays flat or groups into *Intelligence* (briefing) and
*Production* (plan, edit, output). Flag the recommendation — it affects both new
pages.

**Both themes, always.** Every new screen must be designed in light and dark. The
dark theme is not a tint of the light one: `--card` goes from cream `#F4F2E7` to
green `#0E3B2C`, and accents lighten from `--emerald` to `--sage` so they hold
contrast on a dark ground.

**Responsive.** The existing pages work down to 375px. Tables scroll inside
their own container; the page body never scrolls sideways. The floating panel
goes full-screen below 560px. New work should hold the same line.

**Accessibility.** Existing patterns to keep: `aria-pressed` on filter buttons,
`aria-current="page"` on nav, `aria-label` on icon-only buttons, focus-visible
outlines in `--sage` or the accent, `prefers-reduced-motion` respected on the
one animation (a blinking cursor). Video work adds captions and transcripts —
worth designing for rather than retrofitting.

**Nothing irreversible without confirmation.** The planner's rule — propose,
review, drop, then confirm — should carry into both new sections. Publishing a
video and deleting footage both deserve the same treatment.

---

## 5. Reference

- Live: `https://jenna-oss.github.io/TrilithMarketingTool/`
- Repo: `https://github.com/jenna-oss/TrilithMarketingTool`
- Tokens: the `:root` block at the top of `briefing.html`
- Shared chat component: `assets/chat.css`, `assets/chat.js`
- Data layer and agent tooling: `RETRIEVAL.md`

The fastest way to absorb the system is to open the briefing in both light and
dark, and open the floating Ask panel. Between them they use nearly every
pattern described here.
