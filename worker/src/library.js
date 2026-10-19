/* ---------------------------------------------------------------------------
 * The routes version 6 of the app added: editing a clip, the Library's files,
 * and recent plans on the Create page.
 *
 *   /clips/info    a clip's window on its take, with the words said around it
 *   /clips/edit    a new window (trim, sections cut out, caption fixes),
 *                  queued in Supabase and cut by cut-footage.yml
 *   /kb/list       what has been put into the knowledge base by hand
 *   /kb/delete     taking one of those out again
 *   /plan/list     the most recent plans, to pick one back up
 *
 * The limits live in the database functions, as they do for /videos/edit.
 * ------------------------------------------------------------------------ */

import { rpc } from './db.js';
import { dispatchWorkflow } from './github.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleLibrary(path, request, env, headers) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'body must be JSON' }, 400, headers); }

  if (path === '/plan/list') {
    const rows = await rpc(env, 'kb_plans_recent', { p_limit: Math.min(Math.max(Number(body.limit) || 8, 1), 20) });
    return json({ plans: rows || [] }, 200, headers);
  }

  if (path === '/kb/list') {
    const rows = await rpc(env, 'kb_uploads_list', { p_limit: 200 });
    return json({ files: rows || [] }, 200, headers);
  }

  const id = String(body.id ?? '');
  if (!UUID.test(id)) return json({ error: 'id must be an id' }, 400, headers);

  if (path === '/kb/delete') {
    const ok = await rpc(env, 'kb_upload_delete', { p_id: id });
    if (!ok) return json({ error: 'No file like that in the library.' }, 404, headers);
    return json({ ok: true }, 200, headers);
  }

  if (path === '/clips/info') {
    const info = await rpc(env, 'kb_clip_edit_info', { p_id: id });
    if (!info) return json({ error: 'No clip with that id.' }, 404, headers);
    return json({ clip: info }, 200, headers);
  }

  if (path === '/clips/edit') {
    if (!env.GITHUB_TOKEN) {
      return json({ error: 'Edits aren’t set up yet: the Worker needs its GitHub token.' }, 503, headers);
    }
    const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    const cuts = Array.isArray(body.cuts)
      ? body.cuts.slice(0, 10).map((c) => ({ from: num(c?.from), to: num(c?.to) }))
      : [];
    const fixes = Array.isArray(body.fixes)
      ? body.fixes.slice(0, 80).map((f) => ({ at: num(f?.at), text: String(f?.text ?? '').trim().slice(0, 40) }))
      : [];
    const queued = await rpc(env, 'kb_clip_request_edit', {
      p_id: id, p_start: num(body.start_s), p_end: num(body.end_s),
      p_cuts: cuts, p_fixes: fixes, p_summary: String(body.summary ?? '').slice(0, 300),
    });
    if (!queued || !queued.ok) {
      return json({ error: (queued && queued.error) || 'Couldn’t queue the edit.' }, 409, headers);
    }
    const started = await dispatchWorkflow(env, 'cut-footage.yml', { clip_id: id }, 'the clip edit');
    if (!started.ok) {
      /* Otherwise the clip would show "editing" for an hour with nothing running. */
      try { await rpc(env, 'kb_clip_edit_state', { p_id: id, p_status: 'failed', p_error: started.error }); }
      catch { /* the request still fails below */ }
      return json({ error: started.error }, 502, headers);
    }
    return json({ ok: true }, 202, headers);
  }

  return json({ error: 'unknown route' }, 404, headers);
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'content-type': 'application/json' } });
}
