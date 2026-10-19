/* ---------------------------------------------------------------------------
 * Worker entry point.
 *
 * Two routes. /ideas answers questions about the category and proposes content,
 * retrieving through its tools rather than reading a corpus. /kb/upload puts a
 * file into the knowledge base permanently, and is the only path here that
 * writes anything — it carries its own shared-token check, since the origin
 * allowlist below is a browser control and not a security boundary.
 *
 * There used to be a second route that answered questions by putting the entire
 * ad corpus in a cached system prompt, ~135K tokens, rewritten every time the
 * cache lapsed. Retrieval replaced it. The one thing it did better was
 * exhaustive counting, because it saw every ad at once where a search returns
 * 40; adspy.count_ads answers that from Postgres instead, exactly and for a few
 * hundred tokens.
 * ------------------------------------------------------------------------ */

import { handleIdeas } from './ideas.js';
import { handleUpload } from './upload.js';
import { handleRecordings } from './recordings.js';
import { handleLinks } from './links.js';
import { handleScripts } from './scripts.js';
import { handleMeta, handleMetaCallback } from './meta.js';
import { handleSocial } from './uploadpost.js';
import { handlePosts, publishDue } from './posts.js';
import { handleFootage } from './footage.js';
import { dispatchWorkflow } from './github.js';
import { rpc } from './db.js';
import { requireUser } from './auth.js';
import { checkScript, MAX_LINES, MAX_LINE_CHARS } from './script-check.js';
import { handleLibrary } from './library.js';

/* Only the published pages may call this. The key lives here, so an open
 * endpoint would let anyone spend it. */
const ALLOWED_ORIGINS = new Set([
  'https://trilith-marketing-tool.vercel.app',
  'https://jenna-oss.github.io',
  'http://localhost:8788',
]);

/* Vercel gives every preview deployment its own subdomain, so a branch build
 * would be blocked by an exact-match list alone. Scope the pattern to this
 * project rather than all of *.vercel.app — anyone can deploy there, and a
 * blanket wildcard would hand the API key to whoever did. */
const PREVIEW_ORIGIN = /^https:\/\/trilith-marketing-tool-[a-z0-9-]+\.vercel\.app$/;

const isAllowed = (origin) => ALLOWED_ORIGINS.has(origin) || PREVIEW_ORIGIN.test(origin);

function cors(origin) {
  /* Echo the caller's origin when it is allowed. Returning a different one —
   * as this did when the site moved to Vercel — makes the browser block the
   * response before it reaches the page, which surfaces as "Failed to fetch"
   * with no clue as to why. */
  const allowed = isAllowed(origin) ? origin : [...ALLOWED_ORIGINS][0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Max-Age': '86400',
    /* Caches and CDNs must not serve one origin's CORS headers to another. */
    Vary: 'Origin',
  };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin);
    const path = new URL(request.url).pathname.replace(/\/+$/, '');

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    if (origin && !isAllowed(origin)) {
      return json({ error: 'origin not allowed' }, 403, headers);
    }

    /* Facebook sends the browser here after you approve: a GET navigation,
     * with no session on it and no JSON in it. It has to come before the
     * POST-only rule below, which would otherwise turn every connection into
     * a 405. What stands in for a session is the single-use ticket the
     * Schedule page asked for before sending you there. */
    if (path === '/meta/callback') {
      try { return await handleMetaCallback(request, env); }
      catch (err) {
        console.error('meta callback failed:', err?.message);
        return new Response('Something went wrong connecting that account.', { status: 502 });
      }
    }

    if (request.method !== 'POST') {
      return json({ error: 'POST a JSON body to /ideas or /kb/upload.' }, 405, headers);
    }

    /* Every route needs a Clerk session whose email is on this app's list
     * (kb.app_users): chat, plans, renders, edits, uploads and the video
     * library. Signing in itself happens between the page and Clerk. The
     * pages are public files; this is the lock. */
    let gate;
    try { gate = await requireUser(request, env, headers, isAllowed); }
    catch (err) {
      console.error('sign-in check failed:', err?.message);
      return json({ error: 'Couldn’t check your sign-in. Try again.' }, 502, headers);
    }
    if (gate.response) return gate.response;

    if (path === '/ideas') return handleIdeas(request, env, headers, ctx);

    /* Puts a file into the knowledge base permanently. Behind sign-in like
     * every route; it used to need a shared upload token of its own. */
    if (path === '/kb/upload') return handleUpload(request, env, headers, ctx);

    /* Voice recordings: uploaded on the Recordings page, transcribed by
     * ElevenLabs, kept in the corpus and readable by the planner. */
    if (path === '/recordings' || path.startsWith('/recordings/')) {
      try { return await handleRecordings(path, request, env, headers, ctx, gate.user); }
      catch (err) {
        console.error('recordings route failed:', err?.message);
        return json({ error: 'Something went wrong with that recording. Try again.' }, 502, headers);
      }
    }

    /* Raw takes. The bytes go straight from the browser to storage — this
     * only signs the upload and keeps track of what is there. */
    if (path.startsWith('/footage/')) {
      try { return await handleFootage(path, request, env, headers, ctx, gate.user); }
      catch (err) {
        console.error('footage route failed:', err?.message);
        return json({ error: 'Something went wrong with that take. Try again.' }, 502, headers);
      }
    }

    /* What is scheduled to go out, and changing it. The sending itself is
     * the cron below, not a route. */
    if (path.startsWith('/posts/')) {
      try { return await handlePosts(path, request, env, headers, ctx, gate.user); }
      catch (err) {
        console.error('posts route failed:', err?.message);
        return json({ error: 'Something went wrong with that. Try again.' }, 502, headers);
      }
    }

    /* Connecting The Buy Box's four accounts through Upload-Post. */
    if (path.startsWith('/social/')) {
      try { return await handleSocial(path, request, env, headers, ctx, gate.user); }
      catch (err) {
        console.error('social route failed:', err?.message);
        return json({ error: 'Something went wrong with that. Try again.' }, 502, headers);
      }
    }

    /* The fallback: connecting the Facebook Page, and its Instagram, straight
     * to Meta. The callback above is the open half of this; these are the
     * signed-in half. */
    if (path.startsWith('/meta/')) {
      try { return await handleMeta(path, request, env, headers, ctx, gate.user); }
      catch (err) {
        console.error('meta route failed:', err?.message);
        return json({ error: 'Something went wrong with that. Try again.' }, 502, headers);
      }
    }

    /* Scripts for solo talking-head videos: written from a planned slot,
     * checked the way the pipeline checks a narration, read on the Scripts
     * page and filmed rather than rendered. */
    if (path.startsWith('/scripts/')) {
      try { return await handleScripts(path, request, env, headers, ctx, gate.user); }
      catch (err) {
        console.error('scripts route failed:', err?.message);
        return json({ error: 'Something went wrong with that script. Try again.' }, 502, headers);
      }
    }

    /* An article or a YouTube URL pasted on the Plan page: read now, kept in
     * the corpus, and handed to the planner for this session. */
    if (path === '/links' || path.startsWith('/links/')) {
      try { return await handleLinks(path, request, env, headers, ctx, gate.user); }
      catch (err) {
        console.error('links route failed:', err?.message);
        return json({ error: 'Something went wrong with that link. Try again.' }, 502, headers);
      }
    }

    /* Clip edits, the Library's files and recent plans. */
    if (path.startsWith('/clips/') || path === '/kb/list' || path === '/kb/delete' || path === '/plan/list') {
      try { return await handleLibrary(path, request, env, headers); }
      catch (err) {
        console.error('library route failed:', err?.message);
        return json({ error: 'Something went wrong with that. Try again.' }, 502, headers);
      }
    }

    /* Fetch a stored plan by id, so a session can be resumed in another browser
     * or on another machine. Read-only, and it returns nothing for an id that
     * does not exist rather than saying which — the ids are the only thing
     * standing between one person's plan and another's. */
    if (path === '/plan') {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'body must be JSON' }, 400, headers); }
      const id = String(body.session_id ?? '').slice(0, 64);
      if (!id) return json({ error: 'session_id is required' }, 400, headers);
      try {
        const plan = await rpc(env, 'kb_plan_load', { p_session_id: id });
        return json({ plan: plan ?? null }, 200, headers);
      } catch {
        return json({ error: 'could not load that plan' }, 502, headers);
      }
    }

    /* The finished-video library, for the Output page. Read-only: one
     * SECURITY DEFINER function returns renders marked 'rendered', the newest
     * cut per slot, and nothing that failed. The videos bucket is public, so
     * each row carries a plain storage URL the page can play directly. */
    if (path === '/videos') {
      try {
        const rows = await rpc(env, 'kb_video_library', { p_limit: 60 });
        const base = env.SUPABASE_URL.replace(/\/+$/, '');
        const videos = (rows || []).map((r) => ({
          id: r.id,
          session_id: r.session_id,
          slot: r.slot,
          topic: r.topic,
          hook: r.hook,
          angle: r.angle,
          product: r.product,
          audience: r.audience,
          duration: r.duration_seconds == null ? null : Number(r.duration_seconds),
          rendered_at: r.rendered_at,
          review_status: r.review_status ?? null,
          reviewed_at: r.reviewed_at ?? null,
          has_source: Boolean(r.has_source),
          last_edit: r.last_edit ?? null,
          /* 'render' or 'clip'. A clip came out of a take rather than a plan,
           * which the Edit page cannot work with yet. */
          kind: r.kind || 'render',
          /* An edited clip replaces its file at the same path, so its URL
           * carries when it last changed or the browser shows the old cut. */
          url: `${base}/storage/v1/object/public/videos/`
            + String(r.storage_path).split('/').map(encodeURIComponent).join('/')
            + (r.kind === 'clip' && r.rendered_at ? `?v=${Date.parse(r.rendered_at)}` : ''),
        }));
        return json({ videos }, 200, headers);
      } catch {
        return json({ error: 'could not load videos' }, 502, headers);
      }
    }

    /* Record a review decision on a finished video: to_post or rejected.
     * Either can be changed later. No token, by choice: asking for one on every
     * move got in the way, and the most a stranger with this URL could do is
     * flip a review label on a finished video. The origin check above keeps
     * other sites' pages out; it does not stop curl. */
    if (path === '/videos/review') {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'body must be JSON' }, 400, headers); }
      const id = String(body.id ?? '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return json({ error: 'id must be a video id' }, 400, headers);
      }

      /* 'review' takes a decision back: an undone reject, or a video moved
       * back to be edited. */
      const status = body.status;
      if (status !== 'to_post' && status !== 'rejected' && status !== 'review') {
        return json({ error: 'status must be to_post, rejected or review' }, 400, headers);
      }

      try {
        const out = await rpc(env, 'kb_video_set_review', { p_id: id, p_status: status });
        if (!out || !out.found) return json({ error: 'no finished video with that id' }, 404, headers);
        return json({ review_status: out.review_status, reviewed_at: out.reviewed_at }, 200, headers);
      } catch {
        return json({ error: 'could not update that video' }, 502, headers);
      }
    }

    /* Notes and script changes from the Edit tab, sent together as one edit
     * of a finished video. Queued in Supabase, then started in GitHub Actions
     * straight away. The limits live in kb_video_request_edit: up to 8 notes
     * of 3 to 400 characters and 20 changed lines, the newest version of a
     * video in Ready to review only, one edit at a time per video, ten a day,
     * three of them re-makes. */
    if (path === '/videos/edit') {
      if (!env.GITHUB_TOKEN) {
        return json({ error: 'Edits aren’t set up yet: the Worker needs its GitHub token.' }, 503, headers);
      }

      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'body must be JSON' }, 400, headers); }
      const id = String(body.id ?? '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return json({ error: 'id must be a video id' }, 400, headers);
      }
      /* Each note says what to change; `at` pins it to a moment (seconds), or
       * is null for the whole video. The database checks the limits and turns
       * the notes into the text the agent reads. */
      const notes = Array.isArray(body.notes)
        ? body.notes.slice(0, 8).map((n) => {
            const at = n && n.at != null && n.at !== '' ? Number(n.at) : NaN;
            return {
              note: String((n && n.note) ?? '').trim().slice(0, 400),
              at: Number.isFinite(at) ? Math.max(0, at) : null,
            };
          })
        : [];

      /* 'remake' makes the video again from its plan with the notes as the
       * change requested, instead of changing only what they ask. Script
       * changes are lines rewritten on the script panel, numbered from 1; the
       * database checks them against the lines saved with the video. */
      const mode = body.mode === 'remake' ? 'remake' : 'exact';
      const script = Array.isArray(body.script)
        ? body.script.slice(0, 20).map((c) => ({
            line: Number.isInteger(c?.line) ? c.line : null,
            text: String(c?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LINE_CHARS),
          }))
        : [];

      let queued;
      try {
        queued = await rpc(env, 'kb_video_request_edit', { p_render_id: id, p_notes: notes, p_mode: mode, p_script: script });
      } catch { return json({ error: 'Couldn’t queue the edit. Try again.' }, 502, headers); }
      if (!queued || !queued.ok) {
        return json({ error: (queued && queued.error) || 'Couldn’t queue the edit.' }, 409, headers);
      }

      const started = await startEdit(env, queued.id);
      if (!started.ok) {
        /* Otherwise the video would show "editing" for three hours with
         * nothing running. */
        try { await rpc(env, 'kb_video_edit_abandon', { p_edit_id: queued.id, p_error: started.error }); }
        catch { /* the request still fails below; the row goes stale on its own */ }
        return json({ error: started.error }, 502, headers);
      }
      return json({ edit_id: queued.id, mode: queued.mode || mode }, 202, headers);
    }

    /* A finished video's narration lines, for the Edit tab's script panel.
     * lines is null when none were saved: videos stored before the panel
     * existed, or without a kept source. */
    if (path === '/videos/script') {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'body must be JSON' }, 400, headers); }
      const id = String(body.id ?? '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return json({ error: 'id must be a video id' }, 400, headers);
      }
      try {
        const out = await rpc(env, 'kb_video_script', { p_render_id: id });
        return json({ lines: Array.isArray(out?.lines) ? out.lines : null, has_source: Boolean(out?.has_source) }, 200, headers);
      } catch {
        return json({ error: 'could not load that script' }, 502, headers);
      }
    }

    /* Rewritten script lines, checked before they're sent: the brand-voice
     * lint and the beginner listener, as the pipeline's Script stage runs
     * them. Advice for the page, never a block. */
    if (path === '/videos/script-check') {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'body must be JSON' }, 400, headers); }
      const lines = Array.isArray(body.lines)
        ? body.lines.map((l) => String(l ?? '').replace(/\s+/g, ' ').trim())
        : [];
      if (!lines.length || lines.length > MAX_LINES || lines.some((l) => !l || l.length > MAX_LINE_CHARS)) {
        return json({ error: `lines must be 1 to ${MAX_LINES} lines of text, each under ${MAX_LINE_CHARS} characters` }, 400, headers);
      }
      const changed = [...new Set((Array.isArray(body.changed) ? body.changed : [])
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= lines.length))];
      if (!changed.length) return json({ error: 'changed must name the lines that changed' }, 400, headers);
      return json(await checkScript(env, lines, changed), 200, headers);
    }

    /* Render from the Plan page's confirm list: one video per locked slot.
     * Open like /videos/edit, so the limits live in kb_plan_request_render:
     * the plan has to be complete, each plan is sent once, and no more than
     * 12 videos a day. The render job reads the plan itself, by session id,
     * from the copy the agent saved at the end of the turn that finished it. */
    if (path === '/plan/render') {
      if (!env.GITHUB_TOKEN) {
        return json({ error: 'Rendering isn’t set up yet: the Worker needs its GitHub token.' }, 503, headers);
      }

      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'body must be JSON' }, 400, headers); }
      const id = String(body.session_id ?? '').slice(0, 64);
      if (!id) return json({ error: 'session_id is required' }, 400, headers);

      let queued;
      try { queued = await rpc(env, 'kb_plan_request_render', { p_session_id: id }); }
      catch { return json({ error: 'Couldn’t start the render. Try again.' }, 502, headers); }
      if (!queued || !queued.ok) {
        return json({
          error: (queued && queued.error) || 'Couldn’t start the render.',
          already: Boolean(queued && queued.already),
        }, 409, headers);
      }

      const started = await dispatchRender(env, { session_id: id }, 'the render');
      if (!started.ok) {
        /* Frees the plan to be sent again; the attempt still counts toward
         * the day's cap. */
        try { await rpc(env, 'kb_plan_render_abandon', { p_request_id: queued.id, p_error: started.error }); }
        catch { /* the request still fails below */ }
        return json({ error: started.error }, 502, headers);
      }
      return json({ count: queued.count }, 202, headers);
    }

    /* The retired ask endpoint. Anything still POSTing here gets told where to
     * go rather than a bare 404 that looks like an outage. */
    return json({
      error: 'This endpoint was retired. POST to /ideas with {brief, history?}.',
    }, 404, headers);
  },

  /* Neither Instagram nor Facebook will hold a post for us, so this is what
   * waiting looks like: every five minutes, take whatever is due and move it along. A post
   * mid-flight is picked up by whichever run comes next, and kb_post_claim
   * makes sure two runs never take the same one. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const { done, error } = await publishDue(env);
        if (error) { console.log('scheduler:', error); return; }
        if (done.length) console.log('scheduler:', done.map((d) => `${d.id} ${d.outcome}`).join(', '));
      } catch (err) {
        console.error('scheduler failed:', err?.message);
      }
    })());
  },
};

/* Start render-videos.yml. GITHUB_TOKEN is a fine-grained token that can only
 * run this repo's workflows (Actions: read and write); the workflow does the
 * rest, reading what to render from Supabase. `what` names the job in errors. */
async function dispatchRender(env, inputs, what) {
  return dispatchWorkflow(env, 'render-videos.yml', inputs, what);
}

/* One edit: the workflow reads the request from Supabase by its id. */
const startEdit = (env, editId) => dispatchRender(env, { edit_id: editId }, 'the edit');

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...headers, 'content-type': 'application/json' },
  });
}
