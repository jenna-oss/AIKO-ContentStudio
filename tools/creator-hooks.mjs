/* ---------------------------------------------------------------------------
 * Rebuild the creators-page hook library from whatever was harvested today.
 *
 * Why this is not a Spyglass call, unlike the briefing's hook patterns:
 * Spyglass's HOOK/USP insight aggregation returns empty for these creators.
 * It is tuned to paid campaigns, and these are organic posts. The patterns on
 * this page were mined by hand for that reason; this reproduces that reading
 * on every run instead of freezing it at one research pass.
 *
 * Only genuine spoken openings are mined. pull-creators.mjs marks a card's
 * text hookSource:'title' when Spyglass returned no hook and the caption's
 * first line was used for display instead. A caption headline is not a spoken
 * opening, and clustering it as one would put patterns in the library that
 * nobody ever said out loud.
 *
 * Needs ANTHROPIC_API_KEY. Skips itself, without failing, when it is absent —
 * the page keeps yesterday's library, which is stale but true.
 * ------------------------------------------------------------------------ */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeJson, hasKey } from './claude-json.mjs';
import { verifyPatterns } from './hook-verify.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CREATORS = join(ROOT, 'data', 'education-creators.json');
const PATTERNS = join(ROOT, 'data', 'creator-hook-patterns.json');

/* Below this there is not enough material to say anything is a pattern, and
 * the library would be a list of one-offs dressed up as findings. */
const MIN_HOOKS = 12;

if (!hasKey()) {
  console.log('ANTHROPIC_API_KEY not set — skipping the hook-library rebuild.');
  process.exit(0);
}

const data = JSON.parse(await readFile(CREATORS, 'utf8'));

const hooks = [];
for (const c of data.creators ?? []) {
  for (const v of c.videos ?? []) {
    /* Older records predate hookSource and are all genuine hooks. */
    if (v.hookSource && v.hookSource !== 'hook') continue;
    if (!v.hook) continue;
    hooks.push({ creator: c.name, quote: v.hook, views: v.views ?? null });
  }
}

console.log(`${hooks.length} spoken hooks from ${new Set(hooks.map((h) => h.creator)).size} creators`);

if (hooks.length < MIN_HOOKS) {
  console.error(`Only ${hooks.length} hooks — too few to mine patterns from. Keeping the existing library.`);
  process.exit(1);
}

const SYSTEM = `You name the recurring FORMS of opening lines in short-form educational video, for an internal creative reference page.

You are given real hooks, each with the creator who said it. Group them by the SHAPE of the opening — what the line does to earn the next five seconds — not by topic. "Two hooks about DSCR loans" is not a pattern; "two hooks that open by naming a loan program most buyers do not know exists" is.

Rules:
- A pattern needs at least two DIFFERENT creators using it independently. Include a single-creator pattern only when the form is genuinely distinctive, and it will be labelled "single example" on the page.
- Quote examples EXACTLY as given. Never paraphrase, never invent a hook.
- Attribute every example to the creator who actually said it.
- Prefer 8 to 14 patterns. Do not force every hook into one; leave the unremarkable ones out.
- label: 4 to 7 words, plain, no jargon and no title case.
- description: one or two sentences on what the form does and why it earns attention. Describe the mechanism, not the topic.

Reply with JSON only:
{"patterns":[{"slug":"kebab-case","label":"...","description":"...","examples":[{"creator":"<exact name>","quote":"<exact hook>"}]}]}`;

const user = `Here are ${hooks.length} hooks. Group them into patterns.\n\n${hooks
  .map((h, i) => `${i + 1}. [${h.creator}] ${h.quote}`)
  .join('\n')}`;

/* 8192 ran out on 2026-10-13 with 42 hooks: the grouping is one call over
 * every hook, so the reply grows with the harvest. A longer reply also needs
 * longer than the default two-minute timeout. */
const out = await claudeJson({ system: SYSTEM, user, maxTokens: 20000, timeoutMs: 600000 });

/* Trust nothing about attribution or wording. See hook-verify.mjs — anything
 * that does not match a harvested hook exactly, from the creator who actually
 * said it, is dropped rather than published as a quotation. */
const { patterns, dropped } = verifyPatterns(out.patterns, hooks);

if (dropped) console.log(`  dropped ${dropped} examples that did not match a harvested hook exactly`);

if (!patterns.length) {
  console.error('No pattern survived verification. Keeping the existing library.');
  process.exit(1);
}

await writeFile(PATTERNS, `${JSON.stringify({
  fetchedAt: new Date().toISOString(),
  note: 'Rebuilt on every run of .github/workflows/daily-creator-pull.yml from the hooks harvested that day. Spyglass HOOK/USP aggregation returns empty for these creators because it is tuned to paid campaigns, so the patterns are read off the organic hooks themselves. Every quote is verified against a harvested hook before it is written.',
  patterns,
}, null, 2)}\n`);

const multi = patterns.filter((p) => p.creatorCount > 1).length;
console.log(`\n${patterns.length} patterns (${multi} convergent, ${patterns.length - multi} single-example)`);
