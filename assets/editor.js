/* ---------------------------------------------------------------------------
 * The video editor, shared by Videos and by the review step on Create.
 *
 *   AikoEditor.mount(container, video, {
 *     approveLabel, onApprove(v), onReject(v), onSent(v, mode), onNewer()
 *   })
 *
 * A rendered video gets Notes (pinned to a moment, or about the whole video),
 * Script (its narration, line by line, checked before it goes) and Details.
 * Changes go as one edit (/videos/edit, mode exact) or a re-make (mode
 * remake). A clip out of a long take is a window on that take, so it gets
 * Trim (new ends, sections cut out) and Captions (words the transcript got
 * wrong) instead, sent to /clips/edit.
 *
 * Unsent notes and lines are kept in the browser under the same keys the old
 * Edit page used, so nothing in progress was lost in the move.
 * ------------------------------------------------------------------------ */
(function () {
  'use strict';

  var A = window.AikoApp;
  var el = A.el;
  var FPS = 30;
  var MAX_NOTES = 8;
  var DRAFT_KEY = 'trilith-edit-drafts';
  var SCRIPT_KEY = 'trilith-script-drafts';
  var CLIP_KEY = 'aiko-clip-drafts';

  function load(key) { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { return {}; } }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ } }
  var tidy = function (s) { return String(s).replace(/\s+/g, ' ').trim(); };
  var frameAt = function (t) { return Math.max(0, Math.round(t * FPS)); };
  function timecode(t) {
    var f = frameAt(t), s = Math.floor(f / FPS);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + '.' + String(f % FPS).padStart(2, '0');
  }
  var clock = A.clock;
  var scriptCache = {};

  function mount(container, v, opts) {
    opts = opts || {};
    var isClip = v.kind === 'clip';
    var exact = isClip || Boolean(v.has_source);
    var drafts = load(DRAFT_KEY), scriptDrafts = load(SCRIPT_KEY), clipDrafts = load(CLIP_KEY);
    var tab = isClip ? 'trim' : 'notes';
    var scope = 'frame';
    var lines = scriptCache[v.id];
    var checked = null;
    var sending = false;
    var remakeAsk = false;
    var statusText = '', statusBad = false;
    var clip = null;          /* /clips/info: the window on the take */
    var clipState = null;     /* {start, end, cuts:[{from,to}], fixes:{at:text}} in the take's clock */
    var pendingCut = null;    /* where a section to cut out starts, before its end is picked */
    var editingWord = null;
    var destroyed = false;

    container.textContent = '';
    var root = el('div', { class: 'editor-root', style: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '22px' } });
    container.append(root);

    /* --- the player ------------------------------------------------------- */
    var video = el('video', { playsinline: true, preload: 'auto', style: { width: '100%', height: '100%', display: 'block', objectFit: 'contain' } });
    video.crossOrigin = 'anonymous';
    video.src = v.url;
    var playerBox = el('div', { style: { aspectRatio: '9/16', background: '#000', borderRadius: '6px', overflow: 'hidden', maxHeight: 'calc(100vh - 20rem)', minHeight: '15rem', position: 'relative' } }, video);
    var markerBar = el('div', { 'aria-hidden': 'true', style: { position: 'relative', height: '12px' } });
    var scrub = el('input', { type: 'range', min: '0', max: '1', step: String(1 / FPS), value: '0', 'aria-label': 'Position in video', style: { width: '100%', margin: 0, accentColor: 'var(--emerald)' } });
    var playBtn = el('button', { type: 'button', class: 'btn btn-s btn-sm', style: { minWidth: '64px', padding: '0 8px' } }, 'Play');
    var steps = [['−1 sec', -FPS, 'Back one second'], ['−1 frame', -1, 'Back one frame'], ['+1 frame', 1, 'Forward one frame'], ['+1 sec', FPS, 'Forward one second']].map(function (s) {
      return el('button', { type: 'button', class: 'btn btn-s btn-sm', 'aria-label': s[2], style: { padding: '0 6px', fontSize: '12px', flex: '1 1 0', minWidth: 0 }, onclick: function () { step(s[1]); } }, s[0]);
    });
    var timeEl = el('div', { class: 'mono', style: { fontSize: '13px', color: 'var(--ink)', textAlign: 'center' } });
    var playerCol = el('div', { tabindex: '0', 'aria-label': 'Video player. Arrow keys step one frame, Shift and arrow one second, Space plays.', style: { flex: '0 1 320px', minWidth: '240px', display: 'flex', flexDirection: 'column', gap: '8px' } },
      playerBox, markerBar, scrub,
      el('div', { class: 'row', style: { gap: '4px', flexWrap: 'nowrap' } }, playBtn, steps),
      timeEl,
      el('div', { class: 'quiet', style: { fontSize: '11px', textAlign: 'center' }, text: '← → one frame · Shift for a second · Space plays' }));

    function lastFrame() { return Number.isFinite(video.duration) ? Math.max(frameAt(video.duration) - 1, 0) : 0; }
    function seek(t) { var f = Math.min(Math.max(frameAt(t), 0), lastFrame()); video.currentTime = f / FPS + 0.001; }
    function step(frames) { video.pause(); seek(video.currentTime + frames / FPS); }
    function togglePlay() { if (video.paused) video.play().catch(function () {}); else video.pause(); }
    function updateTime() {
      if (destroyed) return;
      var t = video.currentTime || 0;
      timeEl.textContent = timecode(t) + ' · frame ' + frameAt(t) + (Number.isFinite(video.duration) ? ' of ' + lastFrame() : '');
      if (document.activeElement !== scrub) scrub.value = t;
      if (tab === 'notes') refreshComposerLabels();
    }
    var ticking = false;
    function tick() { updateTime(); if (!video.paused && !destroyed) requestAnimationFrame(tick); else ticking = false; }
    video.addEventListener('loadedmetadata', function () { scrub.max = video.duration; updateTime(); drawMarkers(); });
    video.addEventListener('seeked', updateTime);
    video.addEventListener('timeupdate', updateTime);
    video.addEventListener('play', function () { playBtn.textContent = 'Pause'; if (!ticking) { ticking = true; requestAnimationFrame(tick); } });
    video.addEventListener('pause', function () { playBtn.textContent = 'Play'; updateTime(); });
    video.addEventListener('click', togglePlay);
    playBtn.addEventListener('click', togglePlay);
    scrub.addEventListener('input', function () { video.pause(); seek(Number(scrub.value)); });
    playerCol.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'textarea' || (tag === 'input' && e.target !== scrub)) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); step((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? FPS : 1)); }
      else if (e.key === ' ' && tag !== 'button') { e.preventDefault(); togglePlay(); }
    });

    function drawMarkers() {
      markerBar.textContent = '';
      var d = video.duration;
      if (!Number.isFinite(d) || !d) return;
      if (!isClip) {
        notes().filter(function (n) { return n.at != null; }).forEach(function (n) {
          markerBar.append(el('span', { title: clock(n.at) + ' · ' + n.note, style: { position: 'absolute', top: '1px', left: (n.at / d * 100) + '%', width: '10px', height: '10px', marginLeft: '-5px', borderRadius: '999px', background: 'var(--ochre-fill)', border: '2px solid var(--ground)' } }));
        });
      }
    }

    /* --- the right-hand side ------------------------------------------------ */
    var banner = el('div');
    var title = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
      el('h2', { text: v.topic || 'Untitled' }),
      el('span', { class: 'quiet', text: (isClip ? 'Clip · ' : '') + clock(v.duration || 0) + (isClip ? ' · from your long take' : ' · narrated') + (!exact ? ' · can only be re-made' : '') }));
    var tabsEl = el('div', { role: 'tablist', 'aria-label': 'Edit', class: 'subtabs' });
    var body = el('div', { class: 'stack', style: { gap: '14px' } });
    var side = el('div', { style: { flex: '1 1 340px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '16px' } }, title, tabsEl, body);
    var foot = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', borderTop: '1px solid var(--rule)', paddingTop: '16px' } });
    root.append(banner, el('div', { class: 'row', style: { gap: '28px', alignItems: 'flex-start' } }, playerCol, side), foot);

    /* --- drafts ------------------------------------------------------------- */
    function notes() { return drafts[v.id] || []; }
    function setNotes(list) { if (list.length) drafts[v.id] = list; else delete drafts[v.id]; save(DRAFT_KEY, drafts); }
    function changes() {
      var d = scriptDrafts[v.id] || {};
      if (!Array.isArray(lines)) return [];
      return Object.keys(d).map(Number)
        .filter(function (n) { return n >= 1 && n <= lines.length && tidy(d[n]) && tidy(d[n]) !== lines[n - 1]; })
        .sort(function (a, b) { return a - b; })
        .map(function (n) { return { line: n, text: tidy(d[n]) }; });
    }
    var sig = function () { return JSON.stringify(changes()); };
    function clipChanged() {
      if (!clip || !clipState) return { trimmed: false, cuts: 0, fixes: 0, any: false };
      var trimmed = Number(clipState.start) !== Number(clip.start_s) || Number(clipState.end) !== Number(clip.end_s);
      var cuts = JSON.stringify(clipState.cuts) !== JSON.stringify(clip.cuts || []);
      var orig = {};
      (clip.fixes || []).forEach(function (f) { orig[f.at] = f.text; });
      var fixes = Object.keys(clipState.fixes).filter(function (k) { return orig[k] !== clipState.fixes[k]; }).length
        + Object.keys(orig).filter(function (k) { return !(k in clipState.fixes); }).length;
      return { trimmed: trimmed, cuts: cuts ? clipState.cuts.length : 0, cutsChanged: cuts, fixes: fixes, any: trimmed || cuts || fixes > 0 };
    }
    function keptLength() {
      if (!clipState) return v.duration || 0;
      return clipState.end - clipState.start - clipState.cuts.reduce(function (n, c) { return n + (c.to - c.from); }, 0);
    }
    function summary() {
      var parts = [];
      if (isClip) {
        var c = clipChanged();
        if (c.trimmed) parts.push('trimmed to ' + clock(keptLength()));
        if (c.cutsChanged) parts.push(c.cuts ? A.plural(c.cuts, 'section') + ' cut out' : 'cut sections put back');
        if (c.fixes) parts.push(A.plural(c.fixes, 'word') + ' fixed');
      } else {
        if (notes().length) parts.push(A.plural(notes().length, 'note'));
        if (changes().length) parts.push(A.plural(changes().length, 'line') + ' rewritten');
      }
      return parts.join(' · ');
    }
    function pending() { return isClip ? clipChanged().any : notes().length + changes().length > 0; }

    /* --- tabs ----------------------------------------------------------------- */
    var TABS = isClip ? [['trim', 'Trim'], ['captions', 'Captions'], ['details', 'Details']] : [['notes', 'Notes'], ['script', 'Script'], ['details', 'Details']];
    function drawTabs() {
      tabsEl.textContent = '';
      TABS.forEach(function (t) {
        var n = t[0] === 'notes' ? notes().length : t[0] === 'script' ? changes().length
          : t[0] === 'trim' ? (clipChanged().trimmed || clipChanged().cutsChanged ? 1 : 0) : t[0] === 'captions' ? clipChanged().fixes : 0;
        tabsEl.append(el('button', { type: 'button', role: 'tab', class: 'subtab', 'aria-selected': String(tab === t[0]), onclick: function () { tab = t[0]; draw(); } },
          t[1], n ? el('span', { class: 'badge', text: n }) : null));
      });
    }

    /* --- Notes ------------------------------------------------------------------ */
    var noteBox, addBtn, scopeHint, examplesEl, counterEl;
    var EXAMPLES = {
      frame: ['These words overlap', 'Caption covers the chart', 'Use a different picture here'],
      whole: ['Talk a little slower', 'More energy in the voice', 'Cut between scenes faster', 'Make the captions bigger'],
    };
    function refreshComposerLabels() {
      if (!addBtn) return;
      var t = video.currentTime || 0;
      var full = notes().length >= MAX_NOTES;
      noteBox.placeholder = full ? 'That’s the most notes one edit can carry.' : scope === 'frame' ? 'What’s wrong at ' + clock(t) + '?' : 'What should change across the whole video?';
      addBtn.textContent = scope === 'frame' ? 'Add note at ' + clock(t) : 'Add note for the whole video';
      addBtn.disabled = full || tidy(noteBox.value).length < 3;
      noteBox.disabled = full;
      var radios = body.querySelectorAll('[data-scope]');
      radios.forEach(function (b) { if (b.dataset.scope === 'frame') b.textContent = 'This moment · ' + clock(t); });
      counterEl.textContent = A.plural(notes().length, 'note') + ' of ' + MAX_NOTES + (noteBox.value.length ? ' · ' + noteBox.value.length + ' / 400' : '');
    }
    function drawNotes() {
      var radio = function (id, label) {
        return el('button', { type: 'button', role: 'radio', class: 'chip chip-sm', 'data-scope': id, 'aria-checked': String(scope === id), onclick: function () { scope = id; draw(); if (noteBox) noteBox.focus(); } }, label);
      };
      noteBox = el('textarea', { class: 'field', rows: '3', maxlength: '400', 'aria-label': 'Note' });
      noteBox.value = body.dataset.draft || '';
      noteBox.addEventListener('input', function () { body.dataset.draft = noteBox.value; refreshComposerLabels(); });
      addBtn = el('button', { type: 'button', class: 'btn btn-s btn-sm', onclick: addNote });
      counterEl = el('span', { class: 'quiet' });
      scopeHint = el('span', { class: 'small', style: { color: 'var(--body)' }, text: scope === 'whole'
        ? 'Something that runs through the whole video: how fast it talks, the voice, the pacing of the cuts, the music or the overall look.'
        : 'Something wrong on screen right here: overlapping words, a caption in the way, or a picture that doesn’t fit. Move the playhead to the spot first.' });
      examplesEl = el('div', { class: 'row', style: { gap: '6px' } }, el('span', { class: 'quiet', style: { fontSize: '12px' }, text: 'For example:' }),
        EXAMPLES[scope].map(function (x) { return el('button', { type: 'button', class: 'chip chip-sm chip-dashed', onclick: function () { noteBox.value = x; body.dataset.draft = x; refreshComposerLabels(); noteBox.focus(); } }, x); }));
      var list = el('div', { class: 'stack', style: { gap: 0 } });
      notes().forEach(function (n, i) {
        list.append(el('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-start', padding: '10px 0', borderTop: '1px solid var(--rule)', flexWrap: 'nowrap' } },
          n.thumb ? el('img', { src: n.thumb, alt: '', style: { width: '27px', height: '48px', objectFit: 'cover', borderRadius: '3px', border: '1px solid var(--emerald)', flexShrink: 0 } })
            : el('span', { style: { width: '27px', height: '48px', borderRadius: '3px', flexShrink: 0, border: '1px dashed var(--strong)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', fontWeight: 700, color: 'var(--quiet)' }, text: n.at == null ? 'ALL' : '' }),
          el('div', { class: 'grow', style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
            n.at == null ? el('span', { class: 'quiet', style: { fontWeight: 600 }, text: 'Whole video' })
              : el('button', { type: 'button', class: 'link', style: { alignSelf: 'flex-start', textDecoration: 'none' }, onclick: function () { video.pause(); seek(n.at); } }, 'At ' + clock(n.at) + ' (frame ' + frameAt(n.at) + ')'),
            el('span', { class: 'ink', style: { fontSize: '14px', overflowWrap: 'anywhere' }, text: n.note })),
          el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove note ' + (i + 1), style: { width: '32px', height: '32px', fontSize: '18px', color: 'var(--quiet)' }, onclick: function () {
            var l = notes().slice(); l.splice(i, 1); setNotes(l); draw();
          } }, '×')));
      });
      body.append(
        el('div', { role: 'radiogroup', 'aria-label': 'What is this note about?', class: 'row', style: { gap: '6px' } },
          el('span', { class: 'quiet', style: { marginRight: '4px' }, text: 'Fix' }), radio('frame', 'This moment'), radio('whole', 'The whole video')),
        scopeHint, examplesEl, noteBox,
        el('div', { class: 'row' }, addBtn, counterEl),
        list);
      refreshComposerLabels();
    }
    function grabThumb() {
      try {
        var c = document.createElement('canvas'); c.width = 90; c.height = 160;
        c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.7);
      } catch (e) { return null; }
    }
    function addNote() {
      var text = tidy(noteBox.value);
      if (text.length < 3 || notes().length >= MAX_NOTES) return;
      var n = { note: text, at: null, thumb: null };
      if (scope === 'frame') {
        video.pause();
        var f = Math.min(frameAt(video.currentTime), lastFrame());
        n.at = Math.round((f / FPS) * 100) / 100;
        n.thumb = grabThumb();
      }
      var l = notes().concat([n]).sort(function (a, b) { return (a.at == null ? Infinity : a.at) - (b.at == null ? Infinity : b.at); });
      setNotes(l);
      body.dataset.draft = '';
      statusText = '';
      draw();
    }

    /* --- Script --------------------------------------------------------------- */
    function loadScript() {
      if (isClip || !v.has_source || lines !== undefined) return;
      A.api('/videos/script', { id: v.id }).then(function (d) {
        lines = scriptCache[v.id] = Array.isArray(d.lines) ? d.lines : null;
        if (!destroyed) draw();
      }, function () { lines = undefined; });
    }
    function drawScript() {
      if (!exact) { body.append(el('p', { class: 'quiet', text: 'This video’s script wasn’t kept, so its lines can’t be changed here. Say what to change in a note and re-make it.' })); return; }
      if (lines === undefined) { body.append(el('p', { class: 'pulse', text: 'Loading the script…' })); return; }
      if (!Array.isArray(lines)) { body.append(el('p', { class: 'quiet', text: 'No script was kept for this one. Say what to change in a note.' })); return; }
      body.append(el('div', { class: 'row', style: { justifyContent: 'space-between' } },
        el('span', { class: 'quiet', text: 'Change a line and it’s voiced again. New lines are checked before they’re sent.' }),
        copyButton()));
      var d = scriptDrafts[v.id] || {};
      lines.forEach(function (original, i) {
        var n = i + 1;
        var box = el('textarea', { class: 'field', rows: '2', maxlength: '300', 'aria-label': 'Script line ' + n });
        box.value = n in d ? d[n] : original;
        var row = el('div', { class: 'sline' }, box);
        function mark() {
          row.querySelectorAll('.was, .bad-text').forEach(function (x) { x.remove(); });
          var changed = n in (scriptDrafts[v.id] || {});
          box.classList.toggle('changed', changed);
          if (!changed) return;
          row.append(el('span', { class: 'was', style: { fontSize: '12px', color: 'var(--ochre)' } }, 'Was: “' + original + '” · ',
            el('button', { type: 'button', class: 'link', style: { fontSize: '12px' }, onclick: function () {
              var all = scriptDrafts[v.id] || {}; delete all[n];
              if (!Object.keys(all).length) delete scriptDrafts[v.id];
              save(SCRIPT_KEY, scriptDrafts); draw();
            } }, 'Undo')));
          var f = checked && checked.sig === sig() ? checked.flags.find(function (x) { return x.line === n; }) : null;
          (f ? f.issues : []).forEach(function (issue) {
            box.classList.add('flagged');
            row.append(el('span', { class: 'bad-text', style: { fontWeight: 500 }, text: 'Check: ' + issue }));
          });
        }
        box.addEventListener('input', function () {
          var all = scriptDrafts[v.id] || (scriptDrafts[v.id] = {});
          if (tidy(box.value) === original) delete all[n]; else all[n] = box.value;
          if (!Object.keys(all).length) delete scriptDrafts[v.id];
          save(SCRIPT_KEY, scriptDrafts);
          mark(); drawTabs(); drawFoot();
        });
        body.append(el('div', { class: 'row', style: { gap: '8px', alignItems: 'flex-start', flexWrap: 'nowrap' } },
          el('span', { class: 'mono quiet', style: { width: '20px', textAlign: 'right', paddingTop: '12px', fontSize: '11px' }, text: n }),
          el('div', { class: 'grow', style: { minWidth: 0 } }, row)));
        mark();
      });
    }
    function copyButton() {
      var b = el('button', { type: 'button', class: 'btn-q' }, 'Copy the script');
      b.addEventListener('click', function () {
        var text = isClip ? (clip ? clip.words.map(function (w) { return w.t; }).join(' ') : '') : (lines || []).join('\n');
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { A.toast('Script copied'); }, function () { A.toast('Couldn’t copy it. Select the lines instead.'); });
      });
      return b;
    }

    /* --- Details ---------------------------------------------------------------- */
    function drawDetails() {
      var rows = [['Opening line', v.hook ? '“' + v.hook + '”' : ''], [isClip ? 'Why it was cut' : 'What it argues', v.angle], ['Loan type', v.product], ['Made for', v.audience],
        ['Length', clock(v.duration || 0)], ['Finished', v.rendered_at ? A.fmtWhen(v.rendered_at) : ''], isClip && clip ? ['From', clip.take_name || 'your take'] : null]
        .filter(function (r) { return r && r[1]; });
      body.append(el('dl', { style: { margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 16px', fontSize: '14px' } },
        rows.map(function (r) { return [el('dt', { class: 'quiet', style: { fontSize: '14px' }, text: r[0] }), el('dd', { class: 'ink', style: { margin: 0 }, text: r[1] })]; })));
      if (!isClip && Array.isArray(lines)) body.append(el('div', {}, copyButton()));
    }

    /* --- Clips: Trim and Captions ------------------------------------------------ */
    function loadClip() {
      if (!isClip || clip) return;
      A.api('/clips/info', { id: v.id }).then(function (d) {
        clip = d.clip;
        clip.start_s = Number(clip.start_s); clip.end_s = Number(clip.end_s);
        clip.cuts = (clip.cuts || []).map(function (c) { return { from: Number(c.from), to: Number(c.to) }; });
        var saved = clipDrafts[v.id];
        var fixes = {};
        (clip.fixes || []).forEach(function (f) { fixes[f.at] = f.text; });
        clipState = saved || { start: clip.start_s, end: clip.end_s, cuts: clip.cuts.slice(), fixes: fixes };
        if (saved) statusText = 'Your unsent changes were kept from last time.';
        if (!destroyed) draw();
      }, function (err) { statusText = err.message; statusBad = true; if (!destroyed) draw(); });
    }
    function saveClip() { if (clipChanged().any) clipDrafts[v.id] = clipState; else delete clipDrafts[v.id]; save(CLIP_KEY, clipDrafts); }
    /* The player shows the clip as it is now, on its own clock. Where that
       moment is in the take, so "Start here" and "Cut from here" mean what
       they say. */
    function takeTime(t) {
      var segs = [], from = clip.start_s;
      clip.cuts.slice().sort(function (a, b) { return a.from - b.from; }).forEach(function (c) { if (c.from > from) segs.push([from, c.from]); from = Math.max(from, c.to); });
      if (clip.end_s > from) segs.push([from, clip.end_s]);
      var left = t;
      for (var i = 0; i < segs.length; i += 1) {
        var len = segs[i][1] - segs[i][0];
        if (left <= len) return Math.round((segs[i][0] + left) * 100) / 100;
        left -= len;
      }
      return clip.end_s;
    }
    function wordsBetween(a, b) {
      return (clip.words || []).filter(function (w) { return Number(w.s) >= a - 0.02 && Number(w.s) < b; });
    }
    function snippet(a, b) {
      var ws = wordsBetween(a, b).map(function (w) { return clipState.fixes[w.s] || w.t; });
      if (!ws.length) return '(no speech)';
      return ws.length > 12 ? ws.slice(0, 12).join(' ') + '…' : ws.join(' ');
    }
    function drawTrim() {
      if (!clip) { body.append(el('p', { class: 'pulse', text: 'Loading the clip…' })); return; }
      var lo = Math.max(0, clip.start_s - 60), hi = Math.min(Number(clip.take_seconds) || clip.end_s + 60, clip.end_s + 60);
      function slider(label, key) {
        var input = el('input', { type: 'range', min: String(lo), max: String(hi), step: '0.1', value: String(clipState[key]), 'aria-label': label, style: { width: '100%', accentColor: 'var(--emerald)' } });
        var lbl = el('span', {});
        var said = el('span', { class: 'quiet' });
        function paint() {
          lbl.textContent = label + ' ' + clock(clipState[key]) + ' in the take';
          said.textContent = key === 'start' ? 'Opens on: “' + snippet(clipState.start, clipState.start + 4) + '”' : 'Ends on: “' + snippet(clipState.end - 4, clipState.end) + '”';
        }
        input.addEventListener('input', function () {
          var val = Number(input.value);
          if (key === 'start') val = Math.min(val, clipState.end - 3); else val = Math.max(val, clipState.start + 3);
          clipState[key] = Math.round(val * 10) / 10;
          clipState.cuts = clipState.cuts.filter(function (c) { return c.from > clipState.start && c.to < clipState.end; });
          saveClip(); paint(); drawTabs(); drawFoot(); lengthEl.textContent = lengthText();
        });
        paint();
        return el('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontWeight: 600, color: 'var(--ink)', fontSize: '14px' } }, lbl, input, said);
      }
      var lengthEl = el('span', { class: 'quiet' });
      function lengthText() { return 'Runs ' + clock(keptLength()) + (clipChanged().any ? ', was ' + clock(v.duration || 0) : ''); }
      lengthEl.textContent = lengthText();
      body.append(
        el('span', { class: 'small', style: { color: 'var(--body)' }, text: 'Move where the clip starts and ends, or cut a section out of the middle. Play the clip to find the spot, then use the buttons.' }),
        slider('Starts at', 'start'), slider('Ends at', 'end'), lengthEl,
        el('div', { class: 'row', style: { gap: '8px' } },
          el('button', { type: 'button', class: 'btn btn-s btn-sm', onclick: function () { clipState.start = Math.min(takeTime(video.currentTime || 0), clipState.end - 3); saveClip(); draw(); } }, 'Start here'),
          el('button', { type: 'button', class: 'btn btn-s btn-sm', onclick: function () { clipState.end = Math.max(takeTime(video.currentTime || 0), clipState.start + 3); saveClip(); draw(); } }, 'End here')));

      var cutsBox = el('div', { class: 'stack', style: { gap: '8px', borderTop: '1px solid var(--rule)', paddingTop: '12px' } },
        el('h3', { text: 'Cut out a section' }),
        el('span', { class: 'quiet', text: pendingCut == null ? 'Play to where the part you don’t want begins, like a long pause or a stumble.' : 'Now play to where it ends.' }));
      if (pendingCut == null) {
        cutsBox.append(el('div', {}, el('button', { type: 'button', class: 'btn btn-s btn-sm', disabled: clipState.cuts.length >= 10, onclick: function () { pendingCut = takeTime(video.currentTime || 0); draw(); } }, 'Cut from here')));
      } else {
        cutsBox.append(el('div', { class: 'row', style: { gap: '8px' } },
          el('span', { class: 'ink small', text: 'From ' + clock(pendingCut) + ' in the take' }),
          el('button', { type: 'button', class: 'btn btn-p btn-sm', onclick: function () {
            var to = takeTime(video.currentTime || 0);
            var a = Math.min(pendingCut, to), b = Math.max(pendingCut, to);
            pendingCut = null;
            if (b - a < 0.2 || a <= clipState.start || b >= clipState.end) { statusText = 'A section to cut has to sit inside the clip and last more than a moment. To lose the start or the end, trim instead.'; statusBad = true; draw(); return; }
            clipState.cuts = clipState.cuts.filter(function (c) { return c.to < a || c.from > b; }).concat([{ from: Math.round(a * 100) / 100, to: Math.round(b * 100) / 100 }]).sort(function (x, y) { return x.from - y.from; });
            statusText = ''; saveClip(); draw();
          } }, 'To here'),
          el('button', { type: 'button', class: 'btn-q', onclick: function () { pendingCut = null; draw(); } }, 'Cancel')));
      }
      clipState.cuts.forEach(function (c, i) {
        cutsBox.append(el('div', { class: 'row card', style: { padding: '8px 12px', gap: '8px' } },
          el('span', { class: 'mono small ink', text: clock(c.from) + '–' + clock(c.to) }),
          el('span', { class: 'quiet grow', text: '“' + snippet(c.from, c.to) + '”' }),
          el('button', { type: 'button', class: 'btn-q', onclick: function () { clipState.cuts.splice(i, 1); saveClip(); draw(); } }, 'Put back')));
      });
      body.append(cutsBox);
    }
    function drawCaptions() {
      if (!clip) { body.append(el('p', { class: 'pulse', text: 'Loading the captions…' })); return; }
      body.append(el('span', { class: 'small', style: { color: 'var(--body)' }, text: 'Click a word the transcript got wrong and type what was said. Fixed words are underlined.' }));
      var words = wordsBetween(clipState.start, clipState.end).filter(function (w) {
        return !clipState.cuts.some(function (c) { return Number(w.s) >= c.from && Number(w.s) < c.to; });
      });
      var wrap = el('div', { style: { lineHeight: 2.1, fontSize: '15px' } });
      words.forEach(function (w) {
        var key = w.s;
        var text = clipState.fixes[key] || w.t;
        if (editingWord === key) {
          var input = el('input', { class: 'field', value: text, maxlength: '40', 'aria-label': 'Correct word', style: { width: Math.max(80, text.length * 11) + 'px', minHeight: '32px', padding: '2px 6px', display: 'inline-block' } });
          function done(keep) {
            if (keep) {
              var val = tidy(input.value);
              if (!val || val === w.t) delete clipState.fixes[key]; else clipState.fixes[key] = val;
              saveClip();
            }
            editingWord = null; draw();
          }
          input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') done(false); });
          input.addEventListener('blur', function () { done(true); });
          wrap.append(input, ' ');
          setTimeout(function () { input.focus(); input.select(); }, 0);
        } else {
          var fixed = key in clipState.fixes;
          wrap.append(el('button', { type: 'button', title: fixed ? 'Was “' + w.t + '”' : 'Fix this word', onclick: function () { editingWord = key; draw(); },
            style: { background: 'none', border: 'none', padding: '0 1px', color: fixed ? 'var(--ochre)' : 'var(--ink)', textDecoration: fixed ? 'underline' : 'none', fontWeight: fixed ? 600 : 400, cursor: 'pointer' } }, text), ' ');
        }
      });
      body.append(el('div', { class: 'card pad', style: { maxHeight: '320px', overflowY: 'auto' } }, wrap));
    }

    /* --- the banner and the footer ------------------------------------------------ */
    function drawBanner() {
      banner.textContent = '';
      var last = v.last_edit;
      if (last && last.status === 'failed' && !last.in_progress) {
        banner.append(el('div', { role: 'alert', class: 'card pad callout bad ink', style: { fontSize: '14px' } },
          'The last edit didn’t work' + (last.error ? ': ' + last.error.replace(/\.?$/, '.') : '.') + ' Your notes are still here, so you can send them again.'));
      } else if (last && last.status === 'done' && last.instruction) {
        banner.append(el('div', { class: 'card pad quiet', style: { whiteSpace: 'pre-line' } }, 'Last change: ' + last.instruction));
      }
    }
    function drawFoot() {
      foot.textContent = '';
      if (statusText) foot.append(el('span', { role: 'status', style: { fontSize: '13px', textAlign: 'right', color: statusBad ? 'var(--clay)' : 'var(--quiet)' }, text: statusText }));
      var has = pending();
      if (remakeAsk) {
        foot.append(el('div', { class: 'row', style: { justifyContent: 'flex-end' } },
          el('span', { class: 'ink grow', style: { fontSize: '14px', flexBasis: '260px' }, text: 'Re-make writes a new script and new visuals from the plan, with your changes as what to do differently. About 30 minutes, and up to 3 a day.' }),
          el('button', { type: 'button', class: 'btn-q', onclick: function () { remakeAsk = false; drawFoot(); } }, 'Cancel'),
          el('button', { type: 'button', class: 'btn btn-p', onclick: function () { remakeAsk = false; submit('remake'); } }, 'Re-make it')));
        return;
      }
      var flagged = !isClip && checked && checked.sig === sig() && (checked.flags.length || !checked.ok);
      var row = el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn-q', disabled: sending, onclick: reject }, 'Reject'),
        el('span', { class: 'grow quiet', style: { textAlign: 'right' }, text: summary() }));
      if (has) {
        row.append(el('button', { type: 'button', class: 'btn-q', disabled: sending, onclick: clearAll }, 'Clear changes'));
        if (!isClip && exact) row.append(el('button', { type: 'button', class: 'btn-q', disabled: sending, onclick: function () { remakeAsk = true; drawFoot(); } }, 'Re-make from scratch'));
        if (exact) row.append(el('button', { type: 'button', class: 'btn btn-p', disabled: sending, onclick: send }, sending ? 'Sending…' : flagged ? 'Send anyway' : 'Send changes'));
        else row.append(el('button', { type: 'button', class: 'btn btn-p', disabled: sending, onclick: function () { remakeAsk = true; drawFoot(); } }, 'Re-make with these changes'));
      } else {
        row.append(el('button', { type: 'button', class: 'btn btn-p', disabled: sending, onclick: approve }, opts.approveLabel || 'Approve'));
      }
      foot.append(row);
    }

    function clearAll() {
      if (isClip) { delete clipDrafts[v.id]; save(CLIP_KEY, clipDrafts); clip = null; clipState = null; loadClip(); }
      else { setNotes([]); delete scriptDrafts[v.id]; save(SCRIPT_KEY, scriptDrafts); }
      statusText = ''; checked = null; draw();
    }

    function setReview(status) {
      sending = true; drawFoot();
      return A.api('/videos/review', { id: v.id, status: status }).finally(function () { sending = false; });
    }
    function approve() {
      setReview('to_post').then(function () { v.review_status = 'to_post'; if (opts.onApprove) opts.onApprove(v); },
        function (err) { statusText = 'Couldn’t save that: ' + err.message; statusBad = true; drawFoot(); });
    }
    function reject() {
      setReview('rejected').then(function () { v.review_status = 'rejected'; if (opts.onReject) opts.onReject(v); },
        function (err) { statusText = 'Couldn’t save that: ' + err.message; statusBad = true; drawFoot(); });
    }

    function send() {
      if (isClip) return submitClip();
      var ch = changes();
      if (ch.length && !(checked && checked.sig === sig())) {
        sending = true; statusText = 'Checking the new lines…'; statusBad = false; drawFoot();
        var all = lines.slice(); ch.forEach(function (c) { all[c.line - 1] = c.text; });
        A.api('/videos/script-check', { lines: all, changed: ch.map(function (c) { return c.line; }) })
          .then(function (d) { return { ok: d.listened !== false, flags: Array.isArray(d.flags) ? d.flags : [] }; }, function () { return { ok: false, flags: [] }; })
          .then(function (res) {
            sending = false;
            checked = { sig: sig(), flags: res.flags, ok: res.ok };
            if (res.flags.length) { tab = 'script'; statusText = 'Some new lines were flagged, shown under each one. Change them, or send anyway.' + (res.ok ? '' : ' The beginner check couldn’t run.'); statusBad = true; draw(); return; }
            if (!res.ok) { statusText = 'Couldn’t check the new lines. You can send them anyway.'; statusBad = true; draw(); return; }
            submit('exact');
          });
        return;
      }
      submit('exact');
    }

    function submit(mode) {
      var ns = notes(), ch = changes();
      sending = true; statusText = mode === 'remake' ? 'Starting the re-make…' : 'Sending your changes…'; statusBad = false; drawFoot();
      A.api('/videos/edit', { id: v.id, mode: mode, notes: ns.map(function (n) { return { at: n.at, note: n.note }; }), script: ch })
        .then(function (d) {
          sending = false;
          v.last_edit = { status: 'queued', in_progress: true, mode: d.mode || mode,
            instruction: ns.map(function (n) { return (n.at == null ? 'Whole video: ' : 'At ' + clock(n.at) + ': ') + n.note; })
              .concat(ch.map(function (c) { return 'Narration line ' + c.line + ': change “' + lines[c.line - 1] + '” to “' + c.text + '”'; })).join('\n') };
          setNotes([]); delete scriptDrafts[v.id]; save(SCRIPT_KEY, scriptDrafts);
          if (opts.onSent) opts.onSent(v, d.mode || mode);
        }, function (err) {
          sending = false;
          if (err.status === 409 && err.data && /newer version/.test(err.data.error || '')) {
            statusText = 'A newer version of this video came in, so nothing was sent. Your notes are kept: open the newer version to send them.';
            statusBad = true; drawFoot();
            if (opts.onNewer) foot.append(el('div', { class: 'row', style: { justifyContent: 'flex-end' } }, el('button', { type: 'button', class: 'btn btn-s btn-sm', onclick: opts.onNewer }, 'Open the newer version')));
            return;
          }
          statusText = err.message; statusBad = true; drawFoot();
        });
    }

    function submitClip() {
      var c = clipChanged();
      var fixes = Object.keys(clipState.fixes).map(function (k) { return { at: Number(k), text: clipState.fixes[k] }; });
      sending = true; statusText = 'Sending your changes…'; statusBad = false; drawFoot();
      A.api('/clips/edit', { id: v.id, start_s: clipState.start, end_s: clipState.end, cuts: clipState.cuts, fixes: fixes, summary: summary() })
        .then(function () {
          sending = false;
          v.last_edit = { status: 'queued', in_progress: true, mode: 'clip', instruction: summary() };
          delete clipDrafts[v.id]; save(CLIP_KEY, clipDrafts);
          if (opts.onSent) opts.onSent(v, 'clip');
        }, function (err) { sending = false; statusText = err.message; statusBad = true; drawFoot(); });
      return c;
    }

    function draw() {
      if (destroyed) return;
      drawBanner(); drawTabs();
      var keep = body.dataset.draft;
      body.textContent = '';
      body.dataset.draft = keep || '';
      noteBox = addBtn = null;
      if (tab === 'notes') drawNotes();
      else if (tab === 'script') drawScript();
      else if (tab === 'details') drawDetails();
      else if (tab === 'trim') drawTrim();
      else if (tab === 'captions') drawCaptions();
      drawFoot(); drawMarkers();
    }

    if (!isClip) {
      if (drafts[v.id] || scriptDrafts[v.id]) statusText = 'Your unsent changes were kept from last time.';
      loadScript();
    } else loadClip();
    draw();
    setTimeout(function () { playerCol.focus({ preventScroll: true }); }, 50);

    return {
      video: video,
      destroy: function () { destroyed = true; video.pause(); video.removeAttribute('src'); video.load(); container.textContent = ''; },
    };
  }

  window.AikoEditor = { mount: mount };
})();
