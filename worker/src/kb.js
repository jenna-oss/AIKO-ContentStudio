/* ---------------------------------------------------------------------------
 * Knowledge-base tools — the retrieval API the planning agent actually calls.
 *
 * Spec sections 16 to 20, plus repetition detection and idea memory. The
 * planner asks for knowledge; this module answers "what do we have"; deciding
 * what to make with it is the planner's job and not this file's (section 44).
 *
 * Every search embeds its query with Voyage first, so the semantic and keyword
 * halves both contribute. When VOYAGE_API_KEY is absent the embedding is null,
 * Postgres runs the keyword half alone, and the result carries a `degraded`
 * flag — the system says it is running on one leg rather than quietly doing so.
 * ------------------------------------------------------------------------ */

import { rpc, clamp } from './db.js';

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_TIMEOUT_MS = 8000;
const BRAND = 'trilith';

/* --- query embedding ----------------------------------------------------- */

/* Resolved once per request and cached on the env object. The brand id and the
 * embedding model are both stable, and re-reading them on every tool call would
 * add a round trip to every search for no benefit. */
async function context(env) {
  if (!env.__kbContext) {
    const [brandId, cfg] = await Promise.all([
      rpc(env, 'kb_brand_id', { p_slug: BRAND }),
      rpc(env, 'kb_embedding_config', {}).catch(() => null),
    ]);
    env.__kbContext = { brandId, cfg };
  }
  return env.__kbContext;
}

/* Voyage distinguishes query embeddings from document embeddings, and using the
 * right one is worth real recall. Chunks were embedded as 'document'; a search
 * must go in as 'query' or the two sit in subtly different parts of the space. */
async function embedQuery(env, text) {
  if (!env.VOYAGE_API_KEY || !text || !text.trim()) return null;

  const { cfg } = await context(env);
  if (!cfg?.model) return null;

  try {
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.VOYAGE_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: [text],
        model: cfg.model,
        input_type: 'query',
        output_dimension: cfg.dimensions,
        truncation: true,
      }),
      signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const vec = json?.data?.[0]?.embedding;
    return Array.isArray(vec) ? `[${vec.join(',')}]` : null;
  } catch {
    /* A failed embedding degrades retrieval to keyword-only. It must not fail
     * the search: half an answer beats an error, provided the halving is
     * visible, which it is — the tool result says so. */
    return null;
  }
}

/* --- tool definitions ---------------------------------------------------- */

const DOC_INTENTS = ['DISCOVERY', 'SUPPORT', 'REPETITION', 'SOURCE', 'RECALL', 'TIMELY'];

export const KB_TOOLS = [
  {
    name: 'search_transcripts',
    description:
      'Search transcripts of podcasts, recordings and interviews the brand has taken part in — the source material for what has actually been said out loud. Returns the speaker and the timestamp with every passage, so you can cite the exact moment. Use this when you want the brand\'s own explanation of something, in its own words.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for. Natural phrasing works.' },
        date_from: { type: 'string', description: 'ISO date. Only material published on or after this.' },
        date_to: { type: 'string', description: 'ISO date.' },
        content_type: { type: 'string', description: 'e.g. "podcast", "video", "webinar".' },
        intent: {
          type: 'string', enum: DOC_INTENTS,
          description: 'DISCOVERY spreads across sources; SUPPORT digs into the best one; TIMELY favours recent. Default SUPPORT.',
        },
        limit: { type: 'integer', description: 'Default 5, max 20.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_research',
    description:
      'Search research, market reports and articles held in the knowledge base. Returns the source and publication date with every excerpt so a claim can be attributed. Source is for traceability only and does not affect ranking.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        date_from: { type: 'string', description: 'ISO date.' },
        date_to: { type: 'string', description: 'ISO date.' },
        source: { type: 'string', description: 'Partial publisher name, e.g. "Fannie Mae".' },
        intent: { type: 'string', enum: DOC_INTENTS, description: 'Default SUPPORT. Use TIMELY for recent developments.' },
        limit: { type: 'integer', description: 'Default 5, max 20.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_previous_content',
    description:
      'Search what the brand has already published, by topic, angle and hook. Use this before proposing an idea, to find out whether the ground is already covered. This is about arguments already made, not passages already written — use search_trilith_content for the latter.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        date_from: { type: 'string', description: 'ISO date.' },
        date_to: { type: 'string', description: 'ISO date.' },
        platform: { type: 'string', description: 'e.g. "youtube", "website", "instagram".' },
        limit: { type: 'integer', description: 'Default 10, max 30.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'check_repetition',
    description:
      'Given a candidate topic and angle, judge whether it repeats something already published. Returns new / related / repetitive / duplicate, with the pieces it matched. A related topic is still worth making when the angle is genuinely different — the verdict tells you which case you are in. Run this on any idea before recommending it.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The candidate topic, as a short noun phrase.' },
        angle: { type: 'string', description: 'The specific argument the piece would make.' },
        limit: { type: 'integer', description: 'How many prior pieces to return. Default 5.' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'search_content_ideas',
    description:
      'Search the idea memory — ideas raised in earlier planning sessions and never used. Check this before generating new ideas, so a good idea from March is recovered rather than reinvented or missed.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        status: {
          type: 'string',
          enum: ['unused', 'proposed', 'approved', 'used', 'rejected', 'archived'],
          description: 'Default "unused". Pass nothing to search every status.',
        },
        limit: { type: 'integer', description: 'Default 10, max 30.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'save_idea',
    description:
      'Save an idea to the idea memory so it survives this conversation. Include the source_ids of everything the idea was built from — chunk ids or document ids returned by the search tools — so the claim behind it stays checkable later. Save ideas worth keeping, not every idea mentioned.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        angle: { type: 'string' },
        hook: { type: 'string' },
        source_ids: {
          type: 'array', items: { type: 'string' },
          description: 'chunk_id or document_id values from search results that support this idea.',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'search_hooks',
    description:
      'Retrieve hook structures from the hook library, ranked by how close they are in meaning to the query, optionally filtered by category. Each returns a template and an example. Check the "origin" field: a hook with origin "hook_patterns" is a form adapted from advertisers outside the lending category, and must be described that way — never as something a competitor ran.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the video is about or the kind of opening wanted, in plain words — e.g. "investors waiting for rates to drop before buying".' },
        topic: { type: 'string', description: 'A topic to favour. Hooks tagged with or mentioning it rank higher.' },
        category: { type: 'string', description: 'e.g. "myth_busting", "contrarian", "cost_of_waiting".' },
        limit: { type: 'integer', description: 'Default 10, max 30.' },
      },
    },
  },
];

/* --- execution ----------------------------------------------------------- */

/* Every knowledge-base search records itself here (spec section 38). The rows
 * are collected on ctx and written once per turn by the caller rather than one
 * round trip per search — the log is not worth adding latency to the thing the
 * user is waiting for.
 *
 * result_ids are the chunk or row ids actually returned, which is what makes
 * the section 39 question answerable later: did a retrieved candidate reach the
 * final plan? Without the ids that is unanswerable, and a query log alone would
 * not have told anyone. */
function record(ctx, entry) {
  if (!ctx || !Array.isArray(ctx.searchLog)) return;
  ctx.searchLog.push({ session_id: ctx.sessionId || null, ...entry });
}

const idsOf = (rows, key = 'chunk_id') =>
  (rows || []).map((r) => r?.[key] ?? r?.id).filter(Boolean).slice(0, 40);

/* Chunk ids are the traceability spine (spec section 30): every passage the
 * planner is given can be pointed back at a document and a timestamp. They are
 * returned to the model and never rendered to the reader. */
export async function runKbTool(env, name, input, ctx = {}) {
  const { brandId } = await context(env);
  if (!brandId) throw new Error('no brand configured in the knowledge base');

  if (name === 'search_transcripts') {
    const started = Date.now();
    const embedding = await embedQuery(env, input.query);
    const rows = await rpc(env, 'kb_search_transcripts', {
      p_brand_id: brandId,
      p_query: input.query || null,
      p_embedding: embedding,
      p_date_from: input.date_from || null,
      p_date_to: input.date_to || null,
      p_content_type: input.content_type || null,
      p_intent: input.intent || 'SUPPORT',
      p_limit: clamp(input.limit, 5, 20),
    });
    record(ctx, {
      tool: 'search_transcripts', query: input.query, intent: input.intent || 'SUPPORT',
      filters: { date_from: input.date_from, date_to: input.date_to, content_type: input.content_type },
      result_ids: idsOf(rows), result_count: rows.length,
      top_score: rows[0]?.relevance ?? null,
      latency_ms: Date.now() - started, degraded: !embedding,
    });
    return {
      degraded: !embedding,
      note: embedding ? undefined : 'Semantic search unavailable; these are keyword matches only.',
      results: rows.map((r) => ({
        chunk_id: r.chunk_id,
        document_id: r.document_id,
        title: r.title,
        source: r.source,
        source_url: r.source_url,
        date: r.published_at,
        speaker: r.speaker,
        timestamp: r.timestamp_start === null ? null : { start: r.timestamp_start, end: r.timestamp_end },
        content: r.content,
      })),
    };
  }

  if (name === 'search_research') {
    const started = Date.now();
    const embedding = await embedQuery(env, input.query);
    const rows = await rpc(env, 'kb_search_research', {
      p_brand_id: brandId,
      p_query: input.query || null,
      p_embedding: embedding,
      p_date_from: input.date_from || null,
      p_date_to: input.date_to || null,
      p_source: input.source || null,
      p_intent: input.intent || 'SUPPORT',
      p_limit: clamp(input.limit, 5, 20),
    });
    record(ctx, {
      tool: 'search_research', query: input.query, intent: input.intent || 'SUPPORT',
      filters: { date_from: input.date_from, date_to: input.date_to, source: input.source },
      result_ids: idsOf(rows), result_count: rows.length,
      top_score: rows[0]?.relevance ?? null,
      latency_ms: Date.now() - started, degraded: !embedding,
    });
    return {
      degraded: !embedding,
      note: embedding ? undefined : 'Semantic search unavailable; these are keyword matches only.',
      results: rows.map((r) => ({
        chunk_id: r.chunk_id,
        document_id: r.document_id,
        title: r.title,
        source: r.source,
        source_url: r.source_url,
        date: r.published_at,
        research_type: r.research_type,
        excerpt: r.excerpt,
      })),
    };
  }

  if (name === 'search_previous_content') {
    const started = Date.now();
    const embedding = await embedQuery(env, input.query);
    const rows = await rpc(env, 'kb_search_previous_content', {
      p_brand_id: brandId,
      p_query: input.query || null,
      p_embedding: embedding,
      p_date_from: input.date_from || null,
      p_date_to: input.date_to || null,
      p_platform: input.platform || null,
      p_limit: clamp(input.limit, 10, 30),
    });
    record(ctx, {
      tool: 'search_previous_content', query: input.query, intent: 'REPETITION',
      filters: { platform: input.platform, date_from: input.date_from },
      result_ids: idsOf(rows, 'id'), result_count: rows.length,
      top_score: rows[0]?.relevance ?? null,
      latency_ms: Date.now() - started, degraded: !embedding,
    });
    return {
      degraded: !embedding,
      results: rows.map((r) => ({
        id: r.id,
        title: r.title,
        topic: r.topic,
        angle: r.angle,
        hook: r.hook,
        platform: r.platform,
        format: r.format,
        published_at: r.published_at,
        url: r.source_key,
      })),
    };
  }

  if (name === 'check_repetition') {
    const started = Date.now();
    const embedding = await embedQuery(env, [input.topic, input.angle].filter(Boolean).join(' — '));
    const rows = await rpc(env, 'kb_assess_repetition', {
      p_brand_id: brandId,
      p_embedding: embedding,
      p_topic: input.topic || null,
      p_angle: input.angle || null,
      p_limit: clamp(input.limit, 5, 25),
    });
    const row = rows[0] || { assessment: 'new', matches: [] };
    record(ctx, {
      tool: 'check_repetition',
      query: [input.topic, input.angle].filter(Boolean).join(' — '),
      intent: 'REPETITION',
      filters: { assessment: row.assessment },
      result_ids: (row.matches || []).map((m) => m.id).filter(Boolean).slice(0, 40),
      result_count: (row.matches || []).length,
      top_score: row.top_similarity ?? null,
      latency_ms: Date.now() - started, degraded: !embedding,
    });
    return {
      assessment: row.assessment,
      matches: row.matches,
      /* Without an embedding this comparison is trigram-only: it catches a
       * restatement in the same words and misses a paraphrase. Saying so is the
       * difference between a weak check and a check the planner over-trusts. */
      note: embedding
        ? undefined
        : 'Judged on word overlap only — semantic search was unavailable, so a reworded repeat may read as new.',
    };
  }

  if (name === 'search_content_ideas') {
    const started = Date.now();
    const embedding = await embedQuery(env, input.query);
    const rows = await rpc(env, 'kb_search_content_ideas', {
      p_brand_id: brandId,
      p_query: input.query || null,
      p_embedding: embedding,
      p_status: input.status === undefined ? 'unused' : input.status || null,
      p_limit: clamp(input.limit, 10, 30),
    });
    record(ctx, {
      tool: 'search_content_ideas', query: input.query, intent: 'RECALL',
      filters: { status: input.status },
      result_ids: idsOf(rows, 'id'), result_count: rows.length,
      top_score: rows[0]?.relevance ?? null,
      latency_ms: Date.now() - started, degraded: !embedding,
    });
    return { results: rows };
  }

  if (name === 'save_idea') {
    const embedding = await embedQuery(env, [input.topic, input.angle, input.hook].filter(Boolean).join(' — '));
    const id = await rpc(env, 'kb_save_idea', {
      p_brand_id: brandId,
      p_topic: input.topic,
      p_angle: input.angle || null,
      p_hook: input.hook || null,
      p_source_ids: Array.isArray(input.source_ids) ? input.source_ids : [],
      p_source_type: 'planning_session',
      p_status: 'proposed',
      p_session_id: ctx.sessionId || null,
      p_embedding: embedding,
    });
    return { saved: true, id };
  }

  if (name === 'search_hooks') {
    const started = Date.now();
    const embedding = await embedQuery(env, input.query || input.topic);
    const rows = await rpc(env, 'kb_search_hooks', {
      p_brand_id: brandId,
      p_topic: input.topic || null,
      p_category: input.category || null,
      p_limit: clamp(input.limit, 10, 30),
      p_embedding: embedding,
    });
    record(ctx, {
      tool: 'search_hooks', query: input.query || input.topic, intent: 'DISCOVERY',
      filters: { topic: input.topic, category: input.category },
      result_ids: idsOf(rows, 'id'), result_count: rows.length,
      top_score: rows[0]?.relevance ?? null,
      latency_ms: Date.now() - started, degraded: !embedding,
    });
    return {
      degraded: !embedding,
      note: embedding ? undefined : 'Semantic search unavailable; these are topic matches only.',
      results: rows,
    };
  }

  throw new Error(`unknown knowledge-base tool: ${name}`);
}

export function describeKbTool(name, input) {
  const bits = [];
  if (input.query) bits.push(`"${input.query}"`);
  if (input.topic) bits.push(`topic: ${input.topic}`);
  if (input.angle) bits.push(`angle: ${input.angle}`);
  if (input.source) bits.push(`source: ${input.source}`);
  if (input.platform) bits.push(`platform: ${input.platform}`);
  if (input.content_type) bits.push(`type: ${input.content_type}`);
  if (input.category) bits.push(`category: ${input.category}`);
  if (input.date_from) bits.push(`since ${input.date_from}`);
  if (input.status) bits.push(`status: ${input.status}`);
  if (input.intent) bits.push(input.intent.toLowerCase());

  const label = {
    search_transcripts: 'Transcripts',
    search_research: 'Research',
    search_previous_content: 'Previously published',
    check_repetition: 'Repetition check',
    search_content_ideas: 'Idea memory',
    save_idea: 'Saving idea',
    search_hooks: 'Hook library',
  }[name] || name;

  return { label, detail: bits.join(' · ') || 'everything' };
}

export const KB_TOOL_NAMES = new Set(KB_TOOLS.map((t) => t.name));
