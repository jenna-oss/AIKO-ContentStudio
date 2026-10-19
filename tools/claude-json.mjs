/* ---------------------------------------------------------------------------
 * One Claude call that must come back as JSON, shared by the creator pipeline.
 *
 * The creators page is built on judgments a keyword rule cannot make: whether a
 * video about "Japan tax-free shopping" belongs on a page about residential
 * real estate investing, and what the shared form of a dozen opening lines
 * actually is. Both are asked here.
 *
 * Needs ANTHROPIC_API_KEY. Throws MissingKey when it is absent so each caller
 * can decide whether that is fatal — refreshing videos without a relevance
 * screen is not safe, but it is better than publishing nothing.
 * ------------------------------------------------------------------------ */

const API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5';
const TIMEOUT_MS = 120000;

export class MissingKey extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY not set');
    this.name = 'MissingKey';
  }
}

export function hasKey() {
  return Boolean(String(process.env.ANTHROPIC_API_KEY ?? '').trim());
}

/* Models are chatty by default and will wrap JSON in prose or a fenced block.
 *
 * Prefilling the assistant turn with an opening brace is the usual fix, and it
 * is NOT available here: claude-opus-5 rejects assistant prefill outright with
 * "This model does not support assistant message prefill" (400).
 *
 * So the system prompt asks for bare JSON and this unwraps whatever arrives.
 * Naive approaches both failed against real replies: JSON.parse on the whole
 * body dies on any trailing text, and first-brace-to-last-brace spans a
 * trailing second object and dies the same way ("Unexpected non-whitespace
 * character after JSON"). Scanning for the first BALANCED object is what
 * survives, so quotes and escapes have to be tracked -- a brace inside a hook
 * quotation must not close the object. */
function firstJsonObject(text) {
  const open = text.indexOf('{');
  if (open === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(body);
  } catch (err) {
    const obj = firstJsonObject(body);
    if (!obj) throw err;
    return JSON.parse(obj);
  }
}

export async function claudeJson({ system, user, maxTokens = 8192, timeoutMs = TIMEOUT_MS }) {
  const key = String(process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!key) throw new MissingKey();

  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = String(await res.text()).split(key).join('[REDACTED]');
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
  }

  const body = await res.json();

  /* A refusal is not a parse failure and must not be reported as one. */
  if (body.stop_reason === 'refusal') {
    throw new Error('Claude declined this request.');
  }
  /* Truncation yields JSON that parses as far as it got and then throws
   * somewhere unhelpful. Name it here instead. */
  if (body.stop_reason === 'max_tokens') {
    throw new Error(`Reply hit max_tokens (${maxTokens}); raise it or send fewer items.`);
  }

  const text = (body.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  try {
    return extractJson(text);
  } catch (err) {
    throw new Error(`Claude did not return JSON: ${err.message} — got: ${text.slice(0, 200)}`);
  }
}
