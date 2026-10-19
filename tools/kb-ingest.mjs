/* ---------------------------------------------------------------------------
 * Stage 1 — get source material into the knowledge base.
 *
 * Reads three routes: files under kb/files/, article and YouTube URLs from
 * kb/sources.json, and the newest posts of each feed in kb/feeds.json. Each document is upserted by source_key, so re-running this
 * is safe and cheap: an unchanged document reports "unchanged" and its chunks
 * and embeddings are left alone.
 *
 * Nothing is chunked or embedded here. This step exists to be fast and to fail
 * per-document, so one dead URL cannot take a whole harvest down with it —
 * kb-process.mjs does the expensive half, asynchronously.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Skips itself, without
 * failing, when they are absent.
 * ------------------------------------------------------------------------ */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPABASE_URL, SERVICE_KEY, rpc, sleep, redact } from './kb-lib.mjs';
import {
  readFileSources, readUrlSources, fetchArticle, fetchYouTube, isYouTube,
} from './kb-sources.mjs';
import { readFeedSources, fetchFeed, pickItems, fetchFeedItem } from './kb-feeds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAUSE_MS = 500;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.log('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping ingestion.');
  process.exit(0);
}

const brandSlug = process.env.KB_BRAND || 'trilith';

const counts = { new: 0, changed: 0, unchanged: 0, failed: 0 };
const problems = [];

async function upsert(doc, label) {
  try {
    const res = await rpc('kb_upsert_document', { payload: { ...doc, brand_slug: brandSlug } });
    if (res.changed) counts.changed += 1;
    else counts.unchanged += 1;
    console.log(`  ${res.changed ? 'queued  ' : 'unchanged'}  ${label}`);
    return res;
  } catch (err) {
    counts.failed += 1;
    problems.push({ label, why: redact(err.message) });
    console.log(`  failed     ${label} — ${redact(err.message)}`);
    return null;
  }
}

/* --- files --------------------------------------------------------------- */

const { docs: fileDocs, failures: fileFailures } = await readFileSources(ROOT);

console.log(`\nFiles under kb/files/: ${fileDocs.length} readable, ${fileFailures.length} unreadable`);
for (const f of fileFailures) {
  counts.failed += 1;
  problems.push({ label: f.rel, why: f.why });
  console.log(`  failed     ${f.rel} — ${f.why}`);
}
for (const doc of fileDocs) await upsert(doc, `${doc.document_type}: ${doc.title}`);

/* --- URLs ---------------------------------------------------------------- */

const urlEntries = await readUrlSources(ROOT);
console.log(`\nURLs in kb/sources.json: ${urlEntries.length}`);

for (const entry of urlEntries) {
  let doc;
  try {
    doc = isYouTube(entry.url) ? await fetchYouTube(entry) : await fetchArticle(entry);
  } catch (err) {
    counts.failed += 1;
    problems.push({ label: entry.url, why: redact(err.message) });
    console.log(`  failed     ${entry.url} — ${redact(err.message)}`);
    await sleep(PAUSE_MS);
    continue;
  }
  await upsert(doc, `${doc.document_type}: ${doc.title}`);
  await sleep(PAUSE_MS);
}

/* --- feeds --------------------------------------------------------------- */

const feedEntries = await readFeedSources(ROOT);
console.log(`\nFeeds in kb/feeds.json: ${feedEntries.length}`);

let feedPosts = 0;
for (const entry of feedEntries) {
  const name = entry.name || entry.feed;
  let items;
  try {
    items = pickItems(await fetchFeed(entry), entry);
  } catch (err) {
    feedPosts += 1;
    counts.failed += 1;
    problems.push({ label: `feed ${name}`, why: redact(err.message) });
    console.log(`  failed     feed ${name} — ${redact(err.message)}`);
    continue;
  }
  console.log(` ${name}: ${items.length} recent post(s)`);

  for (const item of items) {
    feedPosts += 1;
    let doc;
    try {
      doc = await fetchFeedItem(entry, item);
    } catch (err) {
      counts.failed += 1;
      problems.push({ label: item.url, why: redact(err.message) });
      console.log(`  failed     ${item.url} — ${redact(err.message)}`);
      await sleep(PAUSE_MS);
      continue;
    }
    await upsert(doc, `${doc.document_type}: ${doc.title}`);
    await sleep(PAUSE_MS);
  }
}

/* --- report -------------------------------------------------------------- */

const attempted = fileDocs.length + fileFailures.length + urlEntries.length + feedPosts;

console.log(
  `\n${attempted} source(s): ${counts.changed} queued for processing, ` +
  `${counts.unchanged} unchanged, ${counts.failed} failed`
);

if (problems.length) {
  console.log('\nProblems:');
  for (const p of problems) console.log(`  ${p.label}: ${p.why}`);
}

/* A run where every single source failed is a broken run, not a quiet one —
 * most likely a bad key or no network. Partial failure is normal and survivable:
 * a 404 on one URL should not stop the other twenty from landing. */
if (attempted > 0 && counts.failed === attempted) {
  console.error('\nEvery source failed. Not treating this as a successful run.');
  process.exit(1);
}

if (attempted === 0) {
  console.log('\nNothing to ingest. Drop files in kb/files/, or add URLs to kb/sources.json or feeds to kb/feeds.json.');
}
