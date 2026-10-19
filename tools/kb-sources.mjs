/* ---------------------------------------------------------------------------
 * Where source material comes from: a folder of files, article URLs, and
 * YouTube captions.
 *
 * Each fetcher returns the same envelope — { document_type, title, source,
 * source_url, published_at, source_key, raw_content, metadata } — so the ingest
 * step does not care which route a document arrived by.
 * ------------------------------------------------------------------------ */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, basename, relative, sep } from 'node:path';

import { decode, htmlToText, articleScope, metaFromHtml, isoOrNull } from './kb-web.mjs';

/* Reading a page is shared with the Worker, which reads links pasted on the
 * Plan page; re-exported so the ingest keeps importing its fetchers from here. */
export { fetchArticle, fetchYouTube, isYouTube } from './kb-web.mjs';

export const DOCUMENT_TYPES = [
  'transcript', 'research', 'article', 'report', 'recording', 'interview', 'other',
];

/* --- files --------------------------------------------------------------- */

const EXT_TYPE = {
  '.vtt': 'transcript',
  '.srt': 'transcript',
};

/* Front matter is optional and deliberately forgiving: three dashes, key: value
 * lines, three dashes. Anything it does not understand is left in the body
 * rather than discarded, because silently eating content is worse than an
 * unrecognised key. */
function frontMatter(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };

  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile() && !e.name.startsWith('.')) out.push(p);
  }
  return out;
}

async function extractFile(path, ext) {
  if (ext === '.pdf') {
    /* pdf and docx need a parser, and the repo otherwise installs nothing but
     * Playwright. Rather than make every clone carry them, they are imported on
     * demand and their absence is reported as an actionable message instead of
     * a stack trace. */
    let pdfParse;
    try {
      ({ default: pdfParse } = await import('pdf-parse'));
    } catch {
      throw new Error('PDF support needs "pdf-parse": run `npm install pdf-parse`, or convert the file to .txt/.md.');
    }
    const parsed = await pdfParse(await readFile(path));
    return { text: parsed.text, meta: { pages: parsed.numpages } };
  }

  if (ext === '.docx') {
    let mammoth;
    try {
      mammoth = await import('mammoth');
    } catch {
      throw new Error('DOCX support needs "mammoth": run `npm install mammoth`, or convert the file to .txt/.md.');
    }
    const { value } = await mammoth.convertToHtml({ path });
    return { text: htmlToText(value), meta: {} };
  }

  const raw = await readFile(path, 'utf8');

  if (ext === '.html' || ext === '.htm') {
    return { text: htmlToText(articleScope(raw)), meta: metaFromHtml(raw) };
  }

  if (ext === '.json') {
    /* A JSON transcript export. Common shapes all reduce to a list of cues. */
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { text: raw, meta: {} }; }
    const rows = Array.isArray(parsed) ? parsed : parsed.segments || parsed.results || parsed.cues || [];
    if (Array.isArray(rows) && rows.length && typeof rows[0] === 'object') {
      const text = rows
        .map((r) => {
          const who = r.speaker || r.speaker_label || null;
          const said = r.text || r.transcript || r.utterance || '';
          return who ? `${who}: ${said}` : said;
        })
        .filter(Boolean)
        .join('\n');
      return { text, meta: { cue_count: rows.length } };
    }
    return { text: raw, meta: {} };
  }

  return { text: raw, meta: {} };
}

/* Files under kb/files/<type>/... take their document_type from the folder.
 * That keeps the common case free of front matter: drop a podcast transcript in
 * kb/files/transcript/ and it is a transcript. */
export async function readFileSources(root) {
  const dir = join(root, 'kb', 'files');
  const paths = await walk(dir);
  const docs = [];
  const failures = [];

  for (const path of paths) {
    const ext = extname(path).toLowerCase();
    const rel = relative(root, path).split(sep).join('/');

    try {
      const { text: extracted, meta: fileMeta } = await extractFile(path, ext);
      const { meta, body } = frontMatter(extracted);

      const folder = relative(dir, path).split(sep)[0]?.toLowerCase();
      const type =
        (DOCUMENT_TYPES.includes(String(meta.type).toLowerCase()) && meta.type.toLowerCase()) ||
        EXT_TYPE[ext] ||
        (DOCUMENT_TYPES.includes(folder) ? folder : null) ||
        'other';

      const content = body.trim();
      if (!content) { failures.push({ rel, why: 'file is empty' }); continue; }

      const stats = await stat(path);

      docs.push({
        document_type: type,
        title: meta.title || basename(path, ext).replace(/[-_]+/g, ' ').trim(),
        source: meta.source || null,
        source_url: meta.url || null,
        /* No stated date means no date. A file mtime is when it was copied
         * onto this machine, which is not when the research was published, and
         * presenting one as the other would corrupt every recency score. */
        published_at: isoOrNull(meta.published || meta.date),
        source_key: `file:${rel}`,
        raw_content: content,
        metadata: {
          ...fileMeta,
          ingest_route: 'file',
          file_path: rel,
          file_bytes: stats.size,
          ...(meta.topics ? { topics: meta.topics.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
          ...(meta.content_type ? { content_type: meta.content_type } : {}),
          ...(meta.research_type ? { research_type: meta.research_type } : {}),
        },
      });
    } catch (err) {
      failures.push({ rel, why: err.message });
    }
  }

  return { docs, failures };
}

/* --- the URL list -------------------------------------------------------- */

export async function readUrlSources(root) {
  let list;
  try {
    list = JSON.parse(await readFile(join(root, 'kb', 'sources.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e && typeof e.url === 'string' && !e.disabled);
}
