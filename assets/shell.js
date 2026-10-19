/* ---------------------------------------------------------------------------
 * What every page of the app shares: the header (Create · Videos · Library ·
 * Schedule, Research, the account menu), Worker calls, the "Next up" card,
 * toasts with Undo, and the vocabulary for where a video is.
 *
 * Loaded after theme.js and auth.js. Pages call AikoApp.header('videos') and
 * then use AikoApp.api(...) for the Worker.
 * ------------------------------------------------------------------------ */
(function () {
  'use strict';

  var WORKER = 'https://aiko-studio.jenna-cbd.workers.dev';
  var FLOW_KEY = 'aiko-flow';

  /* --- small helpers ----------------------------------------------------- */

  /* el('button', {class: 'btn', onclick: fn}, 'text', child) */
  function el(tag, attrs) {
    var node = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i += 1) append(node, arguments[i]);
    return node;
  }
  function append(node, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(node, x); }); return; }
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }

  function plural(n, w, many) { return n + ' ' + (n === 1 ? w : (many || w + 's')); }
  function clock(t) {
    var s = Math.max(0, Math.floor(Number(t) || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function joinNames(a) {
    return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  }
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDay(d) { d = new Date(d); return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()]; }
  function fmtTime(d) {
    d = new Date(d);
    var h = d.getHours(), m = d.getMinutes();
    return ((h + 11) % 12 + 1) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' AM' : ' PM');
  }
  function fmtWhen(d) { return fmtDay(d) + ', ' + fmtTime(d); }

  /* POST JSON to the Worker. Throws an Error carrying the Worker's own words
     and the status, so a page can say what went wrong. */
  function api(path, body) {
    return window.AikoAuth.fetch(WORKER + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var e = new Error(data.error || 'That didn’t work (' + res.status + '). Try again.');
          e.status = res.status;
          e.data = data;
          throw e;
        }
        return data;
      });
    }, function (err) {
      if (err && err.auth) throw err;
      throw new Error('Couldn’t reach the server. Check your connection and try again.');
    });
  }

  /* --- toast --------------------------------------------------------------- */

  var toastEl = null, toastTimer = null, undoFn = null;
  function toast(text, undo) {
    if (!toastEl) {
      toastEl = el('div', { class: 'toast', role: 'status', hidden: true });
      document.body.append(toastEl);
    }
    clearTimeout(toastTimer);
    undoFn = undo || null;
    toastEl.textContent = '';
    toastEl.append(el('span', { text: text }));
    if (undo) {
      toastEl.append(el('button', { type: 'button', text: 'Undo', onclick: function () {
        var f = undoFn; undoFn = null; toastEl.hidden = true; clearTimeout(toastTimer); if (f) f();
      } }));
    }
    toastEl.hidden = false;
    toastTimer = setTimeout(function () { toastEl.hidden = true; undoFn = null; }, undo ? 6000 : 3200);
  }

  /* --- where a video is ---------------------------------------------------

     The Worker keeps two things: a video's review decision (none, to_post,
     rejected) and posts that name it. Every page uses the same five words for
     the combination, so a video is never "approved" on one tab and
     "to be posted" on another. */

  function postsFor(v, posts) {
    return (posts || []).filter(function (p) {
      if (p.render_id && p.render_id === v.id) return true;
      var url = p.media && p.media[0] && p.media[0].url;
      return url && v.url && url.split('?')[0] === v.url.split('?')[0];
    });
  }
  function videoState(v, posts) {
    if (v.last_edit && v.last_edit.in_progress) return 'making';
    if (v.review_status === 'rejected') return 'rejected';
    if (!v.review_status) return 'review';
    var live = postsFor(v, posts).filter(function (p) { return p.status === 'scheduled' || p.status === 'working' || p.status === 'posted'; });
    return live.length ? 'scheduled' : 'approved';
  }
  var STATE_LABEL = { review: 'To review', making: 'Being made', approved: 'Approved', scheduled: 'Scheduled', rejected: 'Rejected' };

  /* One fetch of the videos and the posts per page, shared by the header's
     badges, the Next up card and the page itself. */
  var statusPromise = null;
  function status(fresh) {
    if (!statusPromise || fresh) {
      statusPromise = Promise.all([
        api('/videos').then(function (d) { return d.videos || []; }),
        api('/posts/list').then(function (d) { return d.posts || []; }).catch(function () { return []; }),
      ]).then(function (r) { return { videos: r[0], posts: r[1] }; });
      statusPromise.then(paintBadges, function () {});
    }
    return statusPromise;
  }
  function failedPosts(posts) {
    /* A failure that was followed by a later attempt at the same thing is
       history, not something to fix. */
    return (posts || []).filter(function (p) {
      if (p.status !== 'failed') return false;
      return !(posts || []).some(function (q) {
        return q !== p && q.platform === p.platform && q.render_id && q.render_id === p.render_id
          && (q.status === 'scheduled' || q.status === 'working' || q.status === 'posted')
          && new Date(q.created_at) > new Date(p.created_at);
      });
    });
  }

  /* --- the guided flow, remembered -----------------------------------------

     Create keeps where you are in a flow here, so leaving the page and coming
     back (or the Next up card on another tab) picks it up. */
  function flow() {
    try { return JSON.parse(localStorage.getItem(FLOW_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveFlow(f) {
    try { if (f) localStorage.setItem(FLOW_KEY, JSON.stringify(f)); else localStorage.removeItem(FLOW_KEY); }
    catch (e) { /* private mode: the flow just won't survive leaving */ }
  }

  /* --- the header ----------------------------------------------------------- */

  var TABS = [['create', 'Create', './?home'], ['videos', 'Videos', './videos.html'], ['library', 'Library', './library.html'], ['schedule', 'Schedule', './schedule.html']];
  var badgeEls = {};

  function header(active) {
    var tabs = el('nav', { class: 'app-tabs', 'aria-label': 'Sections' });
    TABS.forEach(function (t) {
      var a = el('a', { class: 'app-tab', href: t[2], 'aria-current': t[0] === active ? 'page' : null }, t[1]);
      if (t[0] === 'create') {
        var f = flow();
        if (f && f.screen && f.screen !== 'start' && f.screen !== 'done') a.append(el('span', { class: 'dot', title: 'In progress' }, el('span', { class: 'sr-only', text: '(in progress)' })));
      }
      badgeEls[t[0]] = el('span', { class: t[0] === 'schedule' ? 'badge bad' : 'badge', hidden: true });
      a.append(badgeEls[t[0]]);
      tabs.append(a);
    });

    var menu = el('div', { class: 'menu', role: 'menu', 'aria-label': 'Account', hidden: true, style: { top: '50px', right: '0', width: '270px' } });
    var research = el('div', { class: 'menu', role: 'menu', 'aria-label': 'Research', hidden: true, style: { top: '50px', right: '48px', width: '240px' } },
      el('a', { class: 'mi', role: 'menuitem', href: './briefing.html' }, el('span', {}, 'Competitors', el('span', { class: 'quiet', style: { display: 'block' } }, 'What lenders are advertising'))),
      el('a', { class: 'mi', role: 'menuitem', href: './creators.html' }, el('span', {}, 'Creators', el('span', { class: 'quiet', style: { display: 'block' } }, 'Who teaches this audience'))));
    var researchBtn = el('button', { type: 'button', class: 'app-tab', 'aria-expanded': 'false', 'aria-current': active === 'research' ? 'page' : null }, 'Research');
    var avatar = el('button', { type: 'button', class: 'avatar', 'aria-label': 'Account', 'aria-expanded': 'false', html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="8" r="4"></circle><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"></path></svg>' });

    function close() { menu.hidden = true; research.hidden = true; avatar.setAttribute('aria-expanded', 'false'); researchBtn.setAttribute('aria-expanded', 'false'); }
    function fillMenu() {
      menu.textContent = '';
      var email = window.AikoAuth && AikoAuth.email();
      menu.append(
        el('div', { style: { padding: '8px 12px', borderBottom: '1px solid var(--rule)', marginBottom: '4px' } },
          el('div', { class: 'quiet', text: 'Signed in as' }), el('div', { class: 'ink', style: { fontWeight: 600, fontSize: '14px', overflowWrap: 'anywhere' }, text: email || '…' })),
        el('a', { class: 'mi', role: 'menuitem', href: './schedule.html#accounts' }, 'Social accounts'),
        el('button', { type: 'button', class: 'mi', role: 'menuitemcheckbox', 'aria-checked': String(AikoTheme.current() === 'dark'), onclick: function () { AikoTheme.toggle(); fillMenu(); } },
          el('span', { text: 'Dark mode' }), el('span', { class: 'tag', text: AikoTheme.current() === 'dark' ? 'On' : 'Off' })),
        el('button', { type: 'button', class: 'mi', role: 'menuitem', onclick: function () { AikoAuth.signOut(); } }, 'Sign out'));
    }
    avatar.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = menu.hidden; close();
      if (open) { fillMenu(); menu.hidden = false; avatar.setAttribute('aria-expanded', 'true'); }
    });
    researchBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = research.hidden; close();
      if (open) { research.hidden = false; researchBtn.setAttribute('aria-expanded', 'true'); }
    });
    document.addEventListener('click', function (e) { if (!menu.contains(e.target) && !research.contains(e.target)) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    var head = el('header', { class: 'app-head' },
      el('a', { class: 'app-brand', href: './?home', title: 'Home', html: '<span class="wm"><span>AIKO <em>Group</em></span></span><span class="app-name">Content Studio</span>' }),
      tabs,
      el('div', { class: 'app-right' }, researchBtn, avatar, research, menu));
    document.body.prepend(head);
    if (active !== 'research') status().catch(function () {});
    return head;
  }

  function paintBadges(s) {
    var review = s.videos.filter(function (v) { return videoState(v, s.posts) === 'review'; }).length;
    var failed = failedPosts(s.posts).length;
    if (badgeEls.videos) { badgeEls.videos.hidden = !review; badgeEls.videos.textContent = review; badgeEls.videos.title = plural(review, 'video') + ' to review'; }
    if (badgeEls.schedule) { badgeEls.schedule.hidden = !failed; badgeEls.schedule.textContent = failed; badgeEls.schedule.title = plural(failed, 'post') + ' didn’t go out'; }
  }

  /* --- Next up ---------------------------------------------------------------

     The one thing most worth doing next, on every tab: videos waiting for
     review, a post that didn't go out, approved videos not yet scheduled, or
     a flow left half-way. Hidden when there is nothing, or when `skip` says
     the page is already showing it. */
  var FLOW_LABEL = { plan: 'planning with Aiko', making: 'waiting for videos to be made', script: 'writing a script', film: 'filming', upload: 'uploading footage', review: 'reviewing', schedule: 'scheduling' };
  function nextUp(container, skip) {
    container.textContent = '';
    return status().then(function (s) {
      var review = s.videos.filter(function (v) { return videoState(v, s.posts) === 'review'; });
      var approved = s.videos.filter(function (v) { return videoState(v, s.posts) === 'approved'; });
      var failed = failedPosts(s.posts);
      var f = flow();
      var item = null;
      skip = skip || {};
      if (review.length && !skip.review) item = { title: plural(review.length, 'video') + ' to review', action: 'Start reviewing', href: './?go=review' };
      else if (failed.length && !skip.failed) item = { title: plural(failed.length, 'post') + ' didn’t go out', action: 'See why', href: './schedule.html?view=list' };
      else if (approved.length && !skip.approved) item = { title: plural(approved.length, 'approved video') + ' not scheduled', action: 'Schedule', href: './?go=schedule' };
      else if (f && FLOW_LABEL[f.screen] && !skip.flow) item = { title: 'You were ' + FLOW_LABEL[f.screen], action: 'Pick up where you left off', href: './' };
      if (!item) return;
      container.append(el('a', { class: 'nextup', href: item.href },
        el('span', { class: 'grow', style: { display: 'flex', flexDirection: 'column' } },
          el('span', { class: 'eyebrow', style: { color: 'var(--ochre)' }, text: 'Next up' }),
          el('span', { class: 'ink', style: { fontWeight: 600 }, text: item.title })),
        el('span', { class: 'go', text: item.action + ' →' })));
    }).catch(function () {});
  }

  /* An empty-state block: a line, and one thing to do about it. */
  function empty(title, action, onclick) {
    return el('div', { class: 'empty' }, el('span', { class: 'ink', style: { fontWeight: 600 }, text: title }),
      action ? (typeof onclick === 'string' ? el('a', { class: 'btn btn-s', href: onclick }, action) : el('button', { type: 'button', class: 'btn btn-s', onclick: onclick }, action)) : null);
  }

  /* A confirm row in place of the buttons it replaces: the question, the
     action, and a way out. Never a browser dialog. */
  function confirmRow(question, yesLabel, onYes, noLabel, onNo, danger) {
    return el('div', { class: 'row', style: { gap: '8px' } },
      el('span', { class: 'ink', style: { fontSize: '14px' }, text: question }),
      el('button', { type: 'button', class: 'btn btn-sm ' + (danger ? 'btn-danger' : 'btn-p'), onclick: onYes }, yesLabel),
      el('button', { type: 'button', class: 'btn-q', onclick: onNo }, noLabel || 'Keep it'));
  }

  window.AikoApp = {
    WORKER: WORKER, api: api, el: el, plural: plural, clock: clock, joinNames: joinNames,
    fmtDay: fmtDay, fmtTime: fmtTime, fmtWhen: fmtWhen,
    toast: toast, header: header, status: status, nextUp: nextUp, empty: empty, confirmRow: confirmRow,
    videoState: videoState, postsFor: postsFor, failedPosts: failedPosts, STATE_LABEL: STATE_LABEL,
    flow: flow, saveFlow: saveFlow,
  };
})();
