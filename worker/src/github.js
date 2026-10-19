/* ---------------------------------------------------------------------------
 * Starting a GitHub Actions run.
 *
 * Two things here need it now — rendering videos and cutting footage — and a
 * route importing it from index.js would make a cycle, since index.js imports
 * the routes.
 *
 * GITHUB_TOKEN is a fine-grained token limited to this one repository with
 * Actions: Read and write, and nothing else.
 * ------------------------------------------------------------------------ */

export async function dispatchWorkflow(env, workflow, inputs, what) {
  const repo = env.GITHUB_REPO || 'jenna-oss/AIKO-ContentStudio';
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        /* GitHub rejects API calls without one. */
        'user-agent': 'trilith-ask-worker',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs }),
    });
    if (res.ok) return { ok: true };
    console.error('workflow dispatch failed:', res.status, (await res.text()).slice(0, 300));
    return { ok: false, error: `Couldn’t start ${what} (GitHub answered ${res.status}).` };
  } catch (err) {
    console.error('workflow dispatch failed:', err?.message);
    return { ok: false, error: `Couldn’t reach GitHub to start ${what}. Try again.` };
  }
}
