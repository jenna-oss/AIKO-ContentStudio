/* ---------------------------------------------------------------------------
 * Create: the guided way through, from an idea to a scheduled post.
 *
 *   Make videos for me   Plan → Make → Review → Schedule
 *   Film myself          Script → Film → Upload → Review → Schedule
 *   Upload footage       Upload → Review → Schedule
 *   (from Next up)       Review → Schedule
 *
 * Where you are is kept in the browser (AikoApp.saveFlow), so leaving and
 * coming back — or the Next up card on another tab — picks it up. The Worker
 * is the authority on everything else: the plan, what is rendered, what is
 * scheduled.
 * ------------------------------------------------------------------------ */
(function () {
  'use strict';

  var A = window.AikoApp;
  var el = A.el;
  var render = window.AikoChat.render;
  A.header('create');

  var FLOWS = {
    auto: [['plan', 'Plan'], ['making', 'Make'], ['review', 'Review'], ['schedule', 'Schedule']],
    film: [['script', 'Script'], ['film', 'Film'], ['upload', 'Upload'], ['review', 'Review'], ['schedule', 'Schedule']],
    upload: [['upload', 'Upload'], ['review', 'Review'], ['schedule', 'Schedule']],
    queue: [['review', 'Review'], ['schedule', 'Schedule']],
  };
  var NAMES = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok' };

  var main = document.getElementById('main');
  var stepperEl = document.getElementById('stepper');
  var footEl = document.getElementById('foot');

  /* --- the flow, kept between visits ----------------------------------- */
  var f = A.flow() || { screen: 'start' };
  function save() { A.saveFlow(f.screen === 'start' ? null : f); }
  function go(screen) { f.screen = screen; save(); draw(); window.scrollTo(0, 0); }
  function newSession() { return 'plan-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function greet() {
    var h = new Date().getHours();
    return 'Good ' + (h < 5 ? 'evening' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening')
      + '. What should this week’s videos be about? Type it, attach notes, paste a link, or record a voice note.';
  }
  function start(kind, extra) {
    f = Object.assign({ kind: kind, screen: FLOWS[kind][0][0] }, extra || {});
    if (kind === 'auto') {
      f.sessionId = newSession();
      f.chat = [{ who: 'a', text: greet() }];
      f.plan = { goal: null, target_count: null, slots: [], rejected: [] };
      f.history = [];
    }
    composer.reset();
    save(); draw();
  }

  /* --- URL shortcuts from other tabs ------------------------------------- */
  var params = new URLSearchParams(location.search);
  var startWith = params.get('start'), goTo = params.get('go'), sessionParam = params.get('session');
  /* ?home: the home screen, even with a flow in progress. The flow stays
     saved and the home screen offers to pick it up. */
  var homeParam = params.has('home');
  if (startWith || goTo || sessionParam || homeParam) history.replaceState(null, '', location.pathname);
  if (homeParam) f = { screen: 'start' };

  /* =======================================================================
   * The composer: one box for typing, attaching, pasting links and
   * recording. Used by Plan (as a chat) and by Script (as the brief).
   * ===================================================================== */
  var composer = (function () {
    var MAX_FILES = 5, MAX_IMAGE = 3.5 * 1024 * 1024, MAX_PDF = 8 * 1024 * 1024, MAX_TEXT = 100000;
    var IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    var TEXT_NAMES = /\.(txt|md|markdown|csv|tsv|json|vtt|srt)$/i;
    var URLS = /\bhttps?:\/\/[^\s<>"'`]+/gi;
    var files = [], links = [], recs = [];
    var text = '', menuOpen = false, error = '';
    var rec = null;             /* a voice note being recorded or reviewed */
    var pastRecordings = null;  /* ready recordings, for the menu */
    var node = null, onChange = function () {};

    function kindOf(file) {
      if (IMAGE_TYPES.indexOf(file.type) >= 0) return 'image';
      if (file.type === 'application/pdf') return 'document';
      if (file.type.indexOf('text/') === 0 || file.type === 'application/json' || TEXT_NAMES.test(file.name)) return 'text';
      return null;
    }
    function readAs(file, how) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onerror = function () { reject(new Error('Couldn’t read ' + file.name + '.')); };
        r.onload = function () { resolve(String(r.result)); };
        if (how === 'text') r.readAsText(file); else r.readAsDataURL(file);
      });
    }
    function stage(list) {
      error = '';
      Array.prototype.forEach.call(list, function (file) {
        if (files.length >= MAX_FILES) { error = 'That’s the most for one message (' + MAX_FILES + '). ' + file.name + ' wasn’t added.'; return; }
        var kind = kindOf(file);
        if (!kind) { error = file.name + ': only text, PDF and image files can be attached. For audio, use Past recordings or record a voice note.'; return; }
        if (kind === 'image' && file.size > MAX_IMAGE) { error = file.name + ' is too large. Images can be up to 3.5MB.'; return; }
        if (kind === 'document' && file.size > MAX_PDF) { error = file.name + ' is too large. PDFs can be up to 8MB.'; return; }
        var entry = { name: file.name, kind: kind, mediaType: file.type, size: file.size, ready: false };
        files.push(entry);
        readAs(file, kind === 'text' ? 'text' : 'dataurl').then(function (res) {
          if (kind === 'text') {
            if (res.length > MAX_TEXT) throw new Error(file.name + ' is too long. Text files can be up to 100,000 characters.');
            entry.text = res;
          } else entry.data = res.slice(res.indexOf(',') + 1);
          entry.ready = true;
          draw2();
        }).catch(function (err) { files.splice(files.indexOf(entry), 1); error = err.message; draw2(); });
      });
      menuOpen = false;
      draw2();
    }

    /* Links are read by the Worker and kept in the library; the planner is
       told to read the ones still attached when the message goes. */
    function catchUrls(t) {
      (String(t).match(URLS) || []).forEach(function (u) { addLink(u.replace(/[.,;:!?)\]]+$/, '')); });
    }
    function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } }
    function addLink(url) {
      if (links.some(function (l) { return l.url === url; }) || links.length >= 6) return;
      var link = { url: url, site: hostOf(url), status: 'reading' };
      links.push(link);
      draw2();
      A.api('/links', { url: url }).then(function (d) {
        link.id = d.id; link.site = d.site || link.site;
        if (d.status === 'ready') { link.status = 'ready'; link.title = d.title; link.partial = d.partial; draw2(); }
        else pollLink(link, 0);
      }, function (err) { link.status = 'failed'; link.error = err.message; draw2(); });
    }
    function pollLink(link, tries) {
      setTimeout(function () {
        A.api('/links/read', { id: link.id }).then(function (d) {
          var row = d.link;
          if (row && row.status !== 'reading') { Object.assign(link, { status: row.status, title: row.title, site: row.site || link.site, error: row.error, partial: row.partial }); draw2(); }
          else if (tries >= 30) { link.status = 'failed'; link.error = 'it is taking too long'; draw2(); }
          else pollLink(link, tries + 1);
        }, function () { if (tries < 30) pollLink(link, tries + 1); });
      }, 2000);
    }
    function retryLink(link) {
      link.status = 'reading'; link.error = null; draw2();
      A.api('/links/retry', { id: link.id }).then(function () { pollLink(link, 0); }, function () { link.status = 'failed'; draw2(); });
    }

    function loadRecordings() {
      if (pastRecordings) return;
      pastRecordings = [];
      A.api('/recordings/list').then(function (d) {
        pastRecordings = (d.recordings || []).filter(function (r) { return r.status === 'ready'; }).slice(0, 12);
        draw2();
      }, function () {});
    }
    function addRecording(r) {
      if (recs.some(function (x) { return x.id === r.id; })) return;
      recs.push({ id: r.id, name: r.name, seconds: r.seconds, status: r.status || 'ready' });
      menuOpen = false;
      draw2();
    }

    /* A voice note, recorded here, saved as a recording and transcribed like
       one uploaded on the Library tab — and attached once it reads. */
    function pickMime() {
      var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
      for (var i = 0; i < types.length; i += 1) if (window.MediaRecorder && MediaRecorder.isTypeSupported(types[i])) return types[i];
      return '';
    }
    function startRec() {
      if (!navigator.mediaDevices || !window.MediaRecorder) { error = 'This browser can’t record. Upload a recording on the Library tab instead.'; draw2(); return; }
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        var mime = pickMime();
        var mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : { audioBitsPerSecond: 64000 });
        rec = { state: 'on', secs: 0, chunks: [], bytes: 0, mr: mr, stream: stream, mime: mr.mimeType || mime || 'audio/webm' };
        mr.ondataavailable = function (e) {
          if (!e.data || !e.data.size) return;
          rec.chunks.push(e.data); rec.bytes += e.data.size;
          if (rec.bytes > 38 * 1024 * 1024 && rec.state === 'on') { error = 'That is as long as one recording can be — stopping here.'; stopRec(); }
        };
        mr.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          if (rec.state === 'discard') { rec = null; draw2(); return; }
          rec.blob = new Blob(rec.chunks, { type: rec.mime });
          if (rec.blob.size < 2000) { error = 'That was too short to transcribe. Try again.'; rec = null; draw2(); return; }
          rec.url = URL.createObjectURL(rec.blob);
          rec.state = 'review';
          var d = new Date();
          rec.name = 'Voice note, ' + d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
          draw2();
        };
        mr.start(1000);
        rec.timer = setInterval(function () {
          rec.secs += 1;
          if (rec.secs >= 90 * 60) { error = 'That is as long as one recording can be — stopping here.'; stopRec(); }
          var c = node && node.querySelector('[data-rec-clock]');
          if (c) c.textContent = 'Recording ' + A.clock(rec.secs);
        }, 1000);
        menuOpen = false;
        draw2();
      }, function (err) {
        error = err && err.name === 'NotAllowedError' ? 'The browser blocked the microphone. Allow it in the address bar and try again.'
          : err && err.name === 'NotFoundError' ? 'No microphone was found.' : 'Couldn’t start recording.';
        draw2();
      });
    }
    function stopRec(discard) {
      if (!rec || rec.state !== 'on') return;
      clearInterval(rec.timer);
      if (discard) rec.state = 'discard';
      rec.mr.stop();
    }
    function keepRec() {
      var r = rec;
      var name = (node.querySelector('[data-rec-name]').value || '').trim() || r.name;
      var ext = /mp4/.test(r.mime) ? 'm4a' : /ogg/.test(r.mime) ? 'ogg' : 'webm';
      var entry = { id: null, name: name, seconds: r.secs, status: 'uploading' };
      recs.push(entry);
      rec = null;
      draw2();
      var fd = new FormData();
      fd.append('file', new File([r.blob], name.replace(/[^\w ,-]+/g, '') + '.' + ext, { type: r.mime }));
      fd.append('name', name);
      window.AikoAuth.fetch(A.WORKER + '/recordings', { method: 'POST', body: fd })
        .then(function (res) { return res.json().then(function (d) { if (!res.ok) throw new Error(d.error || 'Couldn’t save the voice note.'); return d; }); })
        .then(function (d) {
          entry.id = (d.recording && d.recording.id) || d.id;
          entry.status = 'transcribing';
          draw2();
          pollRecording(entry, 0);
        }, function (err) { entry.status = 'failed'; entry.error = err.message; draw2(); });
    }
    function pollRecording(entry, tries) {
      setTimeout(function () {
        A.api('/recordings/list').then(function (d) {
          var row = (d.recordings || []).find(function (x) { return x.id === entry.id; });
          if (row && row.status !== 'transcribing') { entry.status = row.status; entry.error = row.error; pastRecordings = null; draw2(); }
          else if (tries < 60) pollRecording(entry, tries + 1);
        }, function () { if (tries < 60) pollRecording(entry, tries + 1); });
      }, 4000);
    }

    function busy() {
      return files.some(function (x) { return !x.ready; }) || links.some(function (l) { return l.status === 'reading'; })
        || recs.some(function (r) { return r.status === 'uploading' || r.status === 'transcribing'; }) || (rec && rec.state === 'on');
    }
    function count() { return files.length + links.length + recs.length; }

    function chip(k, name, meta, metaCls, extra, onRemove, bad) {
      return el('span', { class: 'att-chip' + (bad ? ' bad' : '') },
        el('span', { class: 'k', text: k }), el('span', { class: 'n', text: name }),
        meta ? el('span', { class: 'm' + (metaCls ? ' ' + metaCls : ''), text: meta }) : null, extra,
        el('button', { type: 'button', class: 'x', 'aria-label': 'Remove ' + name, onclick: onRemove }, '×'));
    }
    function removeWithUndo(arr, item, label) {
      var i = arr.indexOf(item);
      arr.splice(i, 1);
      draw2();
      A.toast('Removed ' + label, function () { arr.splice(i, 0, item); draw2(); });
    }

    function draw2() {
      if (!node) return;
      var mode = node.dataset.mode;
      node.textContent = '';
      node.className = 'composer';
      var chips = el('div', { class: 'chips' });
      files.forEach(function (x) {
        var save = null;
        if (x.kind === 'text' && x.ready) {
          if (x.savedAs) save = el('span', { class: 'tag ok', text: 'In library · ' + x.savedAs });
          else if (x.saving) {
            save = el('select', { 'aria-label': 'What kind of file', style: { fontSize: '12px', minHeight: '28px', border: '1px solid var(--strong)', borderRadius: '4px', background: 'var(--field)', color: 'var(--ink)' },
              onchange: function (e) {
                var t = e.target.value; if (!t) return;
                A.api('/kb/upload', { name: x.name, text: x.text, document_type: t.toLowerCase() }).then(function () {
                  x.saving = false; x.savedAs = t; draw2(); A.toast('Added to Library › Files. Aiko can search it in a few seconds.');
                }, function (err) { x.saving = false; error = err.message; draw2(); });
              } }, ['Save as…', 'Transcript', 'Research', 'Report', 'Article', 'Interview', 'Other'].map(function (o, i) { return el('option', { value: i ? o : '' }, o); }));
          } else save = el('button', { type: 'button', class: 'link', onclick: function () { x.saving = true; draw2(); } }, 'Save to library');
        }
        var size = x.size < 1024 * 1024 ? Math.max(1, Math.round(x.size / 1024)) + ' KB' : (x.size / 1048576).toFixed(1) + ' MB';
        chips.append(chip({ text: 'TXT', image: 'IMG', document: 'PDF' }[x.kind], x.name, x.ready ? size : 'Reading…', x.ready ? '' : 'busy', save, function () { removeWithUndo(files, x, x.name); }));
      });
      links.forEach(function (l) {
        var title = l.title ? (l.title.length > 48 ? l.title.slice(0, 48) + '…' : l.title) : '';
        chips.append(chip('LINK', l.site, l.status === 'reading' ? 'Reading site…' : l.status === 'failed' ? 'Couldn’t read it' : title + (l.partial ? ' (description only)' : ''),
          l.status === 'reading' ? 'busy' : l.status === 'failed' ? 'bad' : '',
          l.status === 'failed' && l.id ? el('button', { type: 'button', class: 'link', onclick: function () { retryLink(l); } }, 'Try again') : null,
          function () { removeWithUndo(links, l, l.site); }, l.status === 'failed'));
      });
      recs.forEach(function (r) {
        var meta = r.status === 'uploading' ? 'Saving…' : r.status === 'transcribing' ? 'Transcribing…' : r.status === 'failed' ? (r.error || 'Couldn’t transcribe it') : A.clock(r.seconds || 0);
        chips.append(chip('VOICE', r.name, meta, r.status === 'ready' ? '' : r.status === 'failed' ? 'bad' : 'busy', null, function () { removeWithUndo(recs, r, r.name); }, r.status === 'failed'));
      });

      var box = el('div', { class: 'box' + (menuOpen || rec ? ' active' : '') });
      if (count()) box.append(chips);
      if (rec && rec.state === 'on') {
        box.append(el('div', { role: 'status', class: 'row', style: { padding: '14px', minHeight: '60px' } },
          el('span', { style: { width: '12px', height: '12px', borderRadius: '999px', background: 'var(--clay)' } }),
          el('span', { class: 'ink', style: { fontWeight: 600 }, 'data-rec-clock': '', text: 'Recording ' + A.clock(rec.secs) }),
          el('span', { class: 'quiet', text: 'Just talk it through. Up to 90 minutes.' }), el('span', { class: 'grow' }),
          el('button', { type: 'button', class: 'btn-q', onclick: function () { stopRec(true); } }, 'Discard'),
          el('button', { type: 'button', class: 'btn btn-s btn-sm', onclick: function () { stopRec(false); } }, 'Stop')));
      } else if (rec && rec.state === 'review') {
        box.append(el('div', { class: 'row', style: { padding: '12px 14px' } },
          el('audio', { src: rec.url, controls: true, style: { height: '36px', maxWidth: '100%' } }),
          el('input', { class: 'field', 'data-rec-name': '', 'aria-label': 'Name the voice note', maxlength: '120', value: rec.name, style: { flex: '1 1 160px', minHeight: '36px', padding: '6px 10px' } }),
          el('button', { type: 'button', class: 'btn-q', onclick: function () { URL.revokeObjectURL(rec.url); rec = null; draw2(); } }, 'Discard'),
          el('button', { type: 'button', class: 'btn btn-p btn-sm', onclick: keepRec }, 'Attach')));
      } else {
        var ta = el('textarea', { rows: '2', 'aria-label': mode === 'script' ? 'What the video is about' : 'Message Aiko',
          placeholder: mode === 'script' ? 'A topic or a few points to cover. Or attach your notes.' : (node.dataset.after ? 'Tell Aiko what to change, like “make #2 simpler” or “go with 1 and 3”' : 'A topic, a link, or a few thoughts') });
        ta.value = text;
        ta.addEventListener('input', function () {
          text = ta.value;
          ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
          clearTimeout(ta._t); ta._t = setTimeout(function () { catchUrls(ta.value); }, 900);
          /* Typing is the one change that doesn't redraw the box, so the
             Send button has to be told itself. */
          var sb = node.querySelector('[data-send]');
          if (sb) sb.disabled = !canSend();
          onChange();
        });
        ta.addEventListener('paste', function (e) {
          var fl = e.clipboardData && e.clipboardData.files;
          if (fl && fl.length) { e.preventDefault(); stage(fl); return; }
          var t = e.clipboardData && e.clipboardData.getData('text');
          if (t) catchUrls(t);
        });
        ta.addEventListener('keydown', function (e) {
          if (mode === 'plan' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); node.dispatchEvent(new CustomEvent('send')); }
        });
        box.append(ta);
      }
      var picker = el('input', { type: 'file', multiple: true, hidden: true, accept: 'image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,application/json,.md,.csv,.tsv,.txt,.json,.vtt,.srt' });
      picker.addEventListener('change', function () { stage(picker.files); picker.value = ''; });
      var hint = busy() ? 'Reading your files…' : count() ? A.plural(count(), 'attachment') : 'Attach notes, paste a link, or record instead of typing';
      var tools = el('div', { class: 'tools' },
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Attach a file or a past recording', 'aria-expanded': String(menuOpen), disabled: Boolean(rec), onclick: function (e) { e.stopPropagation(); menuOpen = !menuOpen; if (menuOpen) loadRecordings(); draw2(); },
          html: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.5l-8.5 8.5a5 5 0 01-7-7L14 5.5a3.5 3.5 0 015 5L10.5 19a2 2 0 01-3-3L15 8.5"></path></svg>' }),
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Record a voice note', disabled: Boolean(rec), onclick: startRec,
          html: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0014 0M12 18v3"></path></svg>' }),
        el('span', { class: 'quiet grow', style: { marginLeft: '6px' }, text: hint }), picker);
      if (mode === 'plan') {
        tools.append(el('button', { type: 'button', class: 'btn btn-s btn-sm', 'data-send': '', disabled: !canSend(), onclick: function () { node.dispatchEvent(new CustomEvent('send')); } }, busy() ? 'Waiting for files…' : 'Send'));
      }
      box.append(tools);
      node.append(box);
      if (error) node.append(el('p', { class: 'bad-text', role: 'alert', style: { margin: '6px 0 0' }, text: error }));
      if (menuOpen) {
        var full = files.length >= MAX_FILES;
        var menu = el('div', { class: 'menu', role: 'menu', 'aria-label': 'Attach', style: { top: '100%', left: 0, marginTop: '4px', width: 'min(360px, 100%)' } },
          el('button', { type: 'button', role: 'menuitem', class: 'mi', disabled: full, style: { flexDirection: 'column', alignItems: 'flex-start', gap: 0 }, onclick: function () { picker.click(); } },
            el('span', { style: { fontWeight: 600 }, text: 'Upload a file' }), el('span', { class: 'quiet', text: full ? 'That’s the most for one message (5)' : 'Notes, a transcript, a PDF or an image · up to 5' })),
          el('span', { class: 'eyebrow', style: { padding: '10px 12px 4px', borderTop: '1px solid var(--rule)', marginTop: '4px' }, text: 'Past recordings' }));
        if (!pastRecordings || !pastRecordings.length) menu.append(el('span', { class: 'quiet', style: { padding: '6px 12px' }, text: pastRecordings ? 'None yet. Record one with the microphone.' : 'Loading…' }));
        (pastRecordings || []).forEach(function (r) {
          var added = recs.some(function (x) { return x.id === r.id; });
          menu.append(el('button', { type: 'button', role: 'menuitem', class: 'mi', disabled: added, onclick: function () { addRecording(r); } },
            el('span', { text: r.name }), el('span', { class: 'quiet', text: A.clock(r.seconds || 0) + (r.words ? ' · ' + r.words + ' words' : '') })));
        });
        node.append(menu);
      }
      onChange();
    }
    document.addEventListener('click', function (e) { if (menuOpen && node && !node.contains(e.target)) { menuOpen = false; draw2(); } });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      if (node && node.isConnected && e.dataTransfer && e.dataTransfer.files.length) stage(e.dataTransfer.files);
    });

    function canSend() { return !busy() && (text.trim() || files.length || links.some(function (l) { return l.status === 'ready'; }) || recs.some(function (r) { return r.status === 'ready'; })); }

    return {
      mount: function (container, mode, after, changed) {
        node = el('div', { 'data-mode': mode });
        if (after) node.dataset.after = '1';
        onChange = changed || function () {};
        container.append(node);
        draw2();
        return node;
      },
      reset: function () { files = []; links = []; recs = []; text = ''; error = ''; menuOpen = false; },
      setText: function (t) { text = t; draw2(); },
      addRecordingById: function (id) {
        A.api('/recordings/list').then(function (d) {
          var r = (d.recordings || []).find(function (x) { return x.id === id; });
          if (r) addRecording(r);
        }, function () {});
      },
      busy: busy, canSend: canSend, text: function () { return text.trim(); },
      take: function () {
        var out = {
          text: text.trim(),
          attachments: files.filter(function (x) { return x.ready; }).map(function (x) { return x.kind === 'text' ? { name: x.name, kind: 'text', text: x.text } : { name: x.name, kind: x.kind, mediaType: x.mediaType, data: x.data }; }),
          links: links.filter(function (l) { return l.status === 'ready' && l.id; }).map(function (l) { return l.id; }),
          recordings: recs.filter(function (r) { return r.status === 'ready' && r.id; }).map(function (r) { return r.id; }),
          names: files.map(function (x) { return x.name; }).concat(links.map(function (l) { return l.site; }), recs.map(function (r) { return r.name; })),
        };
        files = []; links = []; recs = []; text = ''; error = '';
        draw2();
        return out;
      },
    };
  })();

  /* =======================================================================
   * Plan: the conversation with Aiko.
   * ===================================================================== */
  var thinking = false, thinkingText = '', streamEl = null;
  function chatRow(m) {
    if (m.who === 'y') return el('div', { class: 'msg-y' }, el('span', { text: m.text }),
      m.att && m.att.length ? el('span', { class: 'row', style: { gap: '6px' } }, m.att.map(function (n) { return el('span', { class: 'att', text: n }); })) : null);
    if (m.who === 'err') return el('div', { class: 'msg-err', role: 'alert', text: m.text });
    if (m.who === 'ideas') return ideasCard(m);
    return el('div', { class: 'msg-a', html: render(m.text) });
  }
  function lastIdeasIndex() { for (var i = f.chat.length - 1; i >= 0; i -= 1) if (f.chat[i].who === 'ideas') return i; return -1; }

  function ideasCard(m) {
    var latest = f.chat.indexOf(m) === lastIdeasIndex();
    if (!latest) return el('div', { class: 'quiet', style: { fontStyle: 'italic' }, text: 'Earlier list, replaced by the one below.' });
    m.picked = m.picked || m.briefs.map(function () { return true; });
    m.open = m.open || {};
    var card = el('div', { class: 'card', style: { padding: '4px 20px 14px' } });
    m.briefs.forEach(function (b, i) {
      var meta = [b.hook_form && 'Hook: ' + b.hook_form, b.product, b.audience && 'For ' + b.audience, b.hook_source && 'From ' + b.hook_source].filter(Boolean).join(' · ');
      var writeBtn = el('button', { type: 'button', class: 'btn-q', style: { padding: '0 4px', minHeight: '36px' }, onclick: function () { filmIdea(b, i + 1, writeBtn); } }, 'Film it myself instead');
      card.append(el('div', { class: 'idea' + (m.picked[i] ? '' : ' off') },
        el('input', { type: 'checkbox', checked: m.picked[i], disabled: f.planSent, 'aria-label': 'Include ' + b.topic, style: { marginTop: '3px', flexShrink: 0, width: '20px', height: '20px', accentColor: 'var(--emerald)' },
          onchange: function (e) { m.picked[i] = e.target.checked; save(); draw(); } }),
        el('div', { class: 'grow stack', style: { gap: '3px', minWidth: 0 } },
          el('span', { class: 'ink', style: { fontWeight: 600 }, text: (i + 1) + '. ' + b.topic }),
          b.opening_line ? el('span', { class: 'ink', style: { fontSize: '14px' }, text: '“' + b.opening_line + '”' }) : null,
          meta ? el('span', { class: 'quiet', text: meta }) : null,
          m.open[i] && b.evidence ? el('div', { class: 'why', html: render(b.evidence) }) : null,
          el('span', { class: 'row', style: { gap: '4px' } },
            b.evidence ? el('button', { type: 'button', class: 'btn-q', 'aria-expanded': String(Boolean(m.open[i])), style: { padding: 0, minHeight: '36px' }, onclick: function () { m.open[i] = !m.open[i]; draw(); } }, m.open[i] ? 'Hide why' : 'Why this idea') : null,
            b.evidence ? el('span', { class: 'quiet', 'aria-hidden': 'true', text: '·' }) : null,
            writeBtn))));
    });
    var n = m.picked.filter(Boolean).length;
    if (!f.planSent && !planComplete()) {
      card.append(el('div', { class: 'row', style: { paddingTop: '12px' } },
        el('span', { class: 'quiet grow', text: 'Untick any you don’t want, then tell Aiko to go ahead.' }),
        el('button', { type: 'button', class: 'btn btn-s btn-sm', disabled: !n || thinking, onclick: function () {
          var chosen = m.briefs.filter(function (_, i) { return m.picked[i]; });
          send('Let’s go with ' + (chosen.length === m.briefs.length ? 'all ' + chosen.length : chosen.map(function (b) { return '“' + b.topic + '”'; }).join(', ')) + '. Lock them in.');
        } }, n === m.briefs.length ? 'Go with all ' + n : 'Go with these ' + n)));
    }
    return card;
  }

  /* Write the script for one idea, to film yourself, and carry on in the
     Film myself path from it. */
  function filmIdea(b, slot, btn) {
    btn.disabled = true; btn.textContent = 'Writing the script… about 20 seconds';
    A.api('/scripts/write', { session_id: f.sessionId, slot: slot, topic: b.topic, angle: b.angle || '', hook: b.hook_form || '', opening_line: b.opening_line, product: b.product, audience: b.audience, evidence: typeof b.evidence === 'string' ? b.evidence : '' })
      .then(function (d) { A.toast('Saved to Library › Scripts'); start('film', { scriptId: d.id }); },
        function (err) { btn.disabled = false; btn.textContent = 'Film it myself instead'; A.toast(err.message); });
  }

  function planComplete() { return Boolean(f.planComplete) && (f.plan && f.plan.slots || []).length > 0; }

  function send(forcedText) {
    if (thinking) return;
    var c = forcedText ? { text: forcedText, attachments: [], links: [], recordings: [], names: [] } : composer.take();
    var brief = c.text || (c.names.length > 1 ? 'What do you make of these? Anything worth building a video on?' : c.names.length ? 'What do you make of this? Anything worth building a video on?' : '');
    if (!brief) return;
    f.chat.push({ who: 'y', text: brief, att: c.names });
    var payload = { brief: brief, history: f.history || [], plan: f.plan, session_id: f.sessionId };
    if (c.recordings.length) payload.recordings = c.recordings;
    if (c.links.length) payload.links = c.links;
    if (c.attachments.length) payload.attachments = c.attachments;
    thinking = true;
    thinkingText = c.links.length ? 'Reading that link…' : c.names.length ? 'Reading what you attached…' : 'Thinking…';
    save(); draw();
    stream(payload, brief);
  }

  /* /ideas answers as a stream of server-sent events; EventSource can't POST,
     so it's read by hand, keeping any half-arrived frame for the next read. */
  function stream(payload, brief) {
    var answer = '', msg = { who: 'a', text: '' };
    window.AikoAuth.fetch(A.WORKER + '/ideas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (res) {
        if (!res.ok || !res.body) return res.json().catch(function () { return {}; }).then(function (d) { throw new Error(d.error || 'Aiko couldn’t answer (' + res.status + '). Try again.'); });
        var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return;
            buf += dec.decode(r.value, { stream: true });
            var frames = buf.split('\n\n'); buf = frames.pop() || '';
            frames.forEach(function (fr) {
              var ls = fr.split('\n');
              var ev = ls.find(function (l) { return l.indexOf('event: ') === 0; });
              var dl = ls.find(function (l) { return l.indexOf('data: ') === 0; });
              if (!ev || !dl) return;
              var name = ev.slice(7).trim(), data;
              try { data = JSON.parse(dl.slice(6)); } catch (e) { return; }
              if (name === 'token') {
                answer += data;
                if (!msg.added) { f.chat.push(msg); msg.added = true; }
                msg.text = answer;
                thinkingText = '';
                if (streamEl) streamEl.innerHTML = render(answer); else draw();
              } else if (name === 'tool') {
                thinkingText = /lock|batch size|rejection|library|saving/i.test(data.label) ? 'Saving…' : 'Looking into it…';
                streamEl = null; draw();
              } else if (name === 'plan') {
                if (data.briefs && data.briefs.length) { f.chat.push({ who: 'ideas', briefs: data.briefs }); msg = { who: 'a', text: '' }; answer = ''; streamEl = null; save(); draw(); }
              } else if (name === 'plan_state') {
                f.plan = data; save();
              } else if (name === 'error') {
                f.chat.push({ who: 'err', text: data.message }); draw();
              } else if (name === 'done') {
                f.planComplete = Boolean(data.plan_complete);
              }
            });
            return pump();
          });
        }
        return pump();
      })
      .catch(function (err) { if (!(err && err.auth)) f.chat.push({ who: 'err', text: err.message }); })
      .then(function () {
        thinking = false; streamEl = null;
        var said = f.chat.filter(function (m) { return m.who === 'a'; }).map(function (m) { return m.text; });
        if (answer || said.length) f.history = (f.history || []).concat([{ role: 'user', content: brief }, { role: 'assistant', content: answer || '(shared a list of ideas)' }]);
        delete msg.added;
        save(); draw();
      });
  }

  function makeVideos(btn) {
    btn.disabled = true; btn.textContent = 'Starting…';
    A.api('/plan/render', { session_id: f.sessionId }).then(function (d) {
      f.planSent = true; f.renderCount = d.count || (f.plan.slots || []).length; f.renderAt = Date.now();
      go('making');
    }, function (err) {
      if (err.status === 409 && err.data && err.data.already) { f.planSent = true; f.renderCount = (f.plan.slots || []).length; f.renderAt = f.renderAt || Date.now(); go('making'); return; }
      btn.disabled = false; A.toast(err.message); draw();
    });
  }

  /* =======================================================================
   * Making: wait for the renders of this plan to arrive.
   * ===================================================================== */
  /* drawMaking() calls this on every redraw, and this redraws, so it must not
   * start a second check while one is in flight or already booked: the next
   * one is booked before draw() runs, and draw() leaves a booked one alone. */
  var makeTimer = null, makeBusy = false;
  function watchRenders() {
    if (makeBusy) return;
    clearTimeout(makeTimer); makeTimer = null;
    makeBusy = true;
    A.status(true).then(function (s) {
      makeBusy = false;
      if (f.screen !== 'making') return;
      var mine = s.videos.filter(function (v) { return v.session_id === f.sessionId; });
      f.madeSoFar = mine.length;
      var waiting = Math.max(0, (f.renderCount || 1) - mine.length);
      var late = Date.now() - (f.renderAt || 0) > 75 * 60 * 1000;
      if (mine.length && (!waiting || late)) {
        A.toast(A.plural(mine.length, 'video') + ' ready to review');
        f.queue = mine.filter(function (v) { return A.videoState(v, s.posts) === 'review'; }).map(function (v) { return v.id; });
        f.qi = 0; f.batch = [];
        go(f.queue.length ? 'review' : 'start');
        return;
      }
      makeTimer = setTimeout(watchRenders, 30000);
      save(); draw();
    }, function () { makeBusy = false; makeTimer = setTimeout(watchRenders, 30000); });
  }

  /* =======================================================================
   * Script: write it, read it through, fix what's flagged.
   * ===================================================================== */
  var script = null, scriptDraft = {}, scriptSaving = false, writing = false;
  function loadScript() {
    if (!f.scriptId) { script = null; return; }
    if (script && script.id === f.scriptId) return;
    A.api('/scripts/read', { id: f.scriptId }).then(function (d) { script = d.script; scriptDraft = {}; draw(); }, function (err) { A.toast(err.message); });
  }
  function writeScript(btn) {
    var c = composer.take();
    var transcripts = c.recordings.map(function (id) { return A.api('/recordings/read', { id: id }).then(function (d) { return d.recording && d.recording.transcript || ''; }, function () { return ''; }); });
    writing = true; btn.disabled = true; btn.textContent = 'Writing… about 20 seconds';
    Promise.all(transcripts).then(function (ts) {
      var notes = c.attachments.filter(function (a) { return a.kind === 'text'; }).map(function (a) { return a.name + ':\n' + a.text; }).concat(ts.filter(Boolean));
      var topic = c.text || (c.names[0] || 'Untitled').replace(/\.[a-z0-9]+$/i, '');
      return A.api('/scripts/write', { topic: topic.slice(0, 400), evidence: notes.join('\n\n').slice(0, 4000) });
    }).then(function (d) {
      writing = false; f.scriptId = d.id; save(); A.toast('Saved to Library › Scripts'); loadScript(); draw();
    }, function (err) { writing = false; A.toast(err.message); draw(); });
  }
  var tidy = function (s) { return String(s).replace(/\s+/g, ' ').trim(); };
  function scriptDirty() { return Object.keys(scriptDraft).some(function (k) { return tidy(scriptDraft[k]) !== script.lines[k]; }); }
  function drawScriptEditor(host) {
    var words = script.lines.join(' ').split(/\s+/).filter(Boolean).length;
    var flags = script.flags || [];
    var card = el('div', { class: 'card', style: { padding: '16px 22px' } },
      el('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '4px' } },
        el('div', { class: 'stack', style: { gap: '2px' } }, el('h2', { text: script.topic || 'Your script' }),
          el('span', { class: 'quiet', text: words + ' words · about ' + Math.max(1, Math.round(words / 2.6)) + ' seconds' + (flags.length ? ' · ' + A.plural(flags.length, 'line') + ' to look at' : '') })),
        el('div', { class: 'row', style: { gap: '4px' } },
          el('button', { type: 'button', class: 'btn-q', onclick: function () { navigator.clipboard.writeText(script.lines.join('\n\n')).then(function () { A.toast('Script copied'); }, function () { A.toast('Couldn’t copy it'); }); } }, 'Copy'),
          el('button', { type: 'button', class: 'btn btn-s btn-sm', onclick: openPrompter }, 'Teleprompter'))));
    script.lines.forEach(function (line, i) {
      var n = i + 1;
      var val = n in scriptDraft ? scriptDraft[n] : line;
      var issues = scriptDirty() && n in scriptDraft ? [] : ((flags.find(function (x) { return Number(x.line) === n; }) || {}).issues || []);
      var box = el('input', { class: 'field' + (tidy(val) !== line ? ' changed' : '') + (issues.length ? ' flagged' : ''), value: val, maxlength: '300', 'aria-label': 'Line ' + n });
      box.addEventListener('input', function () { scriptDraft[n] = box.value; box.classList.toggle('changed', tidy(box.value) !== line); drawFoot(); dirtyRow.hidden = !scriptDirty(); });
      card.append(el('div', { class: 'sline' }, box, issues.length ? el('div', { class: 'flagbox' }, el('span', {}, el('b', { text: 'Check: ' }), issues.join(' '))) : null));
    });
    var dirtyRow = el('div', { class: 'row', style: { marginTop: '8px' }, hidden: !scriptDirty() },
      el('span', { class: 'quiet grow', text: 'Changed lines are checked again for beginners and brand voice.' }),
      el('button', { type: 'button', class: 'btn btn-s btn-sm', disabled: scriptSaving, onclick: function () {
        scriptSaving = true; draw();
        var lines = script.lines.map(function (l, i) { return i + 1 in scriptDraft ? tidy(scriptDraft[i + 1]) : l; });
        A.api('/scripts/lines', { id: script.id, lines: lines }).then(function (out) {
          scriptSaving = false; script = Object.assign({}, script, { lines: out.lines, words: out.words, flags: out.flags }); scriptDraft = {};
          A.toast(out.flags && out.flags.length ? 'Saved. Some lines are flagged.' : 'Saved and checked'); draw();
        }, function (err) { scriptSaving = false; A.toast(err.message); draw(); });
      } }, scriptSaving ? 'Checking…' : 'Save and check again'));
    card.append(dirtyRow);
    if (script.learned) card.append(el('p', { class: 'quiet', style: { margin: '12px 0 0' }, text: 'Someone new to property came away with: ' + script.learned }));
    host.append(card);
  }
  function openPrompter() {
    var lines = script ? script.lines : [];
    var close = el('button', { type: 'button', class: 'btn', style: { alignSelf: 'flex-end', color: '#fff', border: '1px solid #6A6E72', background: 'transparent' } }, 'Close');
    var p = el('div', { class: 'prompter', role: 'dialog', 'aria-label': 'Teleprompter' }, el('div', { class: 'inner' }, close, lines.map(function (l) { return el('p', { text: l }); })));
    function shut() { p.remove(); document.removeEventListener('keydown', esc); }
    function esc(e) { if (e.key === 'Escape') shut(); }
    close.addEventListener('click', shut);
    document.addEventListener('keydown', esc);
    document.body.append(p);
    close.focus();
  }

  /* =======================================================================
   * Upload: the take goes straight to storage (TUS, 6MB at a time, resumed
   * after a bad patch), then the cutting run makes the clips.
   * ===================================================================== */
  var upload = { state: 'pick', pct: 0, error: '' };
  var CHUNK = 6 * 1024 * 1024;
  var b64 = function (t) { return btoa(String.fromCharCode.apply(null, new TextEncoder().encode(t))); };
  var gb = function (n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB'; };
  function tusCreate(o) {
    var meta = [['bucketName', o.bucket], ['objectName', o.path], ['contentType', o.file.type || 'video/mp4'], ['cacheControl', '3600']].map(function (kv) { return kv[0] + ' ' + b64(kv[1]); }).join(',');
    return fetch(o.endpoint, { method: 'POST', headers: { 'tus-resumable': '1.0.0', 'upload-length': String(o.file.size), 'upload-metadata': meta, 'x-signature': o.token, authorization: 'Bearer ' + o.token } })
      .then(function (res) {
        if (!res.ok) return res.text().then(function (w) { throw new Error('Storage wouldn’t start the upload (' + res.status + ') ' + w.slice(0, 200)); });
        var where = res.headers.get('location');
        if (!where) throw new Error('Storage started the upload but didn’t say where.');
        return new URL(where, o.endpoint).href;
      });
  }
  function tusSend(url, token, file, from, onProgress) {
    if (from >= file.size) return Promise.resolve(from);
    var end = Math.min(from + CHUNK, file.size);
    return fetch(url, { method: 'PATCH', headers: { 'tus-resumable': '1.0.0', 'upload-offset': String(from), 'content-type': 'application/offset+octet-stream', 'x-signature': token, authorization: 'Bearer ' + token }, body: file.slice(from, end) })
      .then(function (res) {
        if (!res.ok) return res.text().then(function (w) { throw new Error('The upload stopped at ' + Math.round(from / file.size * 100) + '% (' + res.status + ') ' + w.slice(0, 200)); });
        var off = Number(res.headers.get('upload-offset') || end);
        onProgress(off);
        return tusSend(url, token, file, off, onProgress);
      });
  }
  function sendFile(o, onProgress) {
    return tusCreate(o).then(function (url) {
      var attempt = 0;
      function tryFrom(from) {
        return tusSend(url, o.token, o.file, from, onProgress).catch(function (err) {
          if (attempt >= 4) throw err;
          attempt += 1;
          return new Promise(function (r) { setTimeout(r, 1000 * attempt); }).then(function () {
            return fetch(url, { method: 'HEAD', headers: { 'tus-resumable': '1.0.0', 'x-signature': o.token, authorization: 'Bearer ' + o.token } })
              .then(function (res) { return Number(res.headers.get('upload-offset') || 0); }, function () { return from; });
          }).then(function (off) { onProgress(off); return tryFrom(off); });
        });
      }
      return tryFrom(0);
    });
  }
  function beginUpload(file, name) {
    upload = { state: 'sending', pct: 0, error: '', size: file.size, name: name };
    window.onbeforeunload = function () { return 'The upload will stop if you leave.'; };
    draw();
    A.api('/footage/start', { name: name, bytes: file.size, content_type: file.type }).then(function (start) {
      f.take = { id: start.id, name: name, at: Date.now() }; save();
      return sendFile({ endpoint: start.endpoint, token: start.token, bucket: start.bucket, path: start.path, file: file }, function (sent) {
        upload.pct = Math.min(100, Math.round(sent / file.size * 100));
        var t = document.querySelector('[data-up-pct]'); if (t) t.textContent = 'Sending, ' + upload.pct + '% of ' + gb(file.size) + '. Keep this tab open.';
        var b = document.querySelector('[data-up-bar]'); if (b) b.style.width = upload.pct + '%';
      }).then(function () { return A.api('/footage/uploaded', { id: start.id }); }, function (err) {
        A.api('/footage/failed', { id: start.id, error: err.message }).catch(function () {});
        throw err;
      });
    }).then(function () {
      window.onbeforeunload = null;
      if (f.scriptId) A.api('/scripts/status', { id: f.scriptId, status: 'filmed' }).catch(function () {});
      upload = { state: 'cutting', pct: 100, error: '' };
      draw(); watchTake();
    }, function (err) { window.onbeforeunload = null; upload = { state: 'pick', pct: 0, error: err.message }; draw(); });
  }
  /* Same rule as watchRenders: drawUpload() calls this on every redraw, so one
   * check at a time, and the next is booked before draw() runs. */
  var takeTimer = null, takeBusy = false;
  function retryTake(ms) { takeBusy = false; takeTimer = setTimeout(watchTake, ms); }
  function watchTake() {
    if (takeBusy) return;
    clearTimeout(takeTimer); takeTimer = null;
    if (!f.take || f.screen !== 'upload') return;
    takeBusy = true;
    A.api('/footage/list').then(function (d) {
      takeBusy = false;
      if (!f.take || f.screen !== 'upload') return;
      var t = (d.footage || []).find(function (x) { return x.id === f.take.id; });
      f.take.status = t ? t.status : 'uploaded'; f.take.error = t && t.error;
      if (t && t.status === 'ready') {
        takeBusy = true;
        return A.status(true).then(function (s) {
          takeBusy = false;
          if (!f.take || f.screen !== 'upload') return;
          var clips = s.videos.filter(function (v) { return v.kind === 'clip' && v.topic === f.take.name && new Date(v.rendered_at).getTime() >= f.take.at - 60000; });
          if (clips.length) {
            A.toast(A.plural(clips.length, 'clip') + ' cut from your take');
            f.queue = clips.map(function (v) { return v.id; }); f.qi = 0; f.batch = [];
            f.take = null; upload = { state: 'pick', pct: 0, error: '' };
            go('review');
          } else {
            f.take.checks = (f.take.checks || 0) + 1;
            if (f.take.checks > 4) { f.take.status = 'empty'; save(); draw(); return; }
            takeTimer = setTimeout(watchTake, 15000);
            save(); draw();
          }
        }, function () { retryTake(15000); });
      }
      if (!t || t.status !== 'failed') takeTimer = setTimeout(watchTake, 10000);
      save(); draw();
    }, function () { retryTake(15000); });
  }

  /* =======================================================================
   * Review: one video at a time, in the editor.
   * ===================================================================== */
  var editor = null;
  function currentQueueVideo(s) {
    while (f.qi < (f.queue || []).length) {
      var id = f.queue[f.qi];
      var v = s.videos.find(function (x) { return x.id === id; });
      if (v && A.videoState(v, s.posts) === 'review') return v;
      f.qi += 1;
    }
    return null;
  }
  function advance(approvedId) {
    if (approvedId) f.batch = (f.batch || []).concat([approvedId]);
    f.qi += 1;
    save();
    A.status(true).then(function (s) {
      if (currentQueueVideo(s)) { draw(); return; }
      if ((f.batch || []).length) startScheduling(f.batch);
      else { A.toast('Nothing approved this time'); f = { screen: 'start' }; save(); draw(); }
    });
  }

  /* =======================================================================
   * Schedule: the approved batch, all at once.
   * ===================================================================== */
  var accounts = null;
  function loadAccounts() {
    if (accounts) return Promise.resolve(accounts);
    return A.api('/social/account').then(function (d) {
      if (d.ready) {
        accounts = {};
        Object.keys(NAMES).forEach(function (k) {
          var a = d.accounts && d.accounts[k];
          accounts[k] = !a ? 'off' : a.reconnect ? 'reconnect' : k === 'facebook' && (d.facebook_pages || []).length > 1 && !d.facebook_page_id ? 'page' : 'on';
        });
        return accounts;
      }
      return A.api('/meta/account').then(function (m) {
        accounts = { instagram: m.connected && m.ig_username ? 'on' : 'off', facebook: m.connected ? 'on' : 'off', youtube: 'off', tiktok: 'off' };
        return accounts;
      });
    }).catch(function () { accounts = { instagram: 'off', facebook: 'off', youtube: 'off', tiktok: 'off' }; return accounts; });
  }
  function startScheduling(ids) {
    A.status().then(function (s) {
      f.kind = f.kind || 'queue';
      f.batch = ids;
      f.rows = {};
      var base = new Date(); base.setDate(base.getDate() + 1);
      ids.forEach(function (id, i) {
        var v = s.videos.find(function (x) { return x.id === id; }) || {};
        var d = new Date(base); d.setDate(base.getDate() + i);
        var pad = function (n) { return String(n).padStart(2, '0'); };
        f.rows[id] = { date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), time: i % 2 ? '12:00' : '09:00',
          caption: (v.hook ? v.hook + '\n\n' : '') + 'Follow @thebuyboxre for more.', yt: (v.topic || '').slice(0, 100), open: false };
      });
      f.plats = null;
      go('schedule');
    });
  }
  function scheduleAll(btn) {
    var plats = Object.keys(NAMES).filter(function (k) { return f.plats[k] && accounts[k] === 'on'; });
    var errs = 0;
    f.batch.forEach(function (id) {
      var r = f.rows[id]; r.error = '';
      if (r.made) return;
      var when = new Date(r.date + 'T' + r.time);
      if (!r.date || !r.time || isNaN(when)) r.error = 'Choose when it goes out.';
      else if (when.getTime() < Date.now()) r.error = 'That time has already gone by.';
      else if (plats.indexOf('youtube') >= 0 && !r.yt.trim()) { r.error = 'YouTube needs a title.'; r.open = true; }
      if (r.error) errs += 1;
    });
    if (errs) { save(); draw(); return; }
    btn.disabled = true; btn.textContent = 'Scheduling…';
    /* Each row remembers the post it made, so "Try again" after a failure part
     * way through only sends the ones that didn't go — never a second post. */
    var before = f.batch.filter(function (id) { return f.rows[id].made; }).length;
    A.status().then(function (s) {
      return f.batch.reduce(function (p, id) {
        return p.then(function () {
          var r = f.rows[id];
          if (r.made) return;
          var v = s.videos.find(function (x) { return x.id === id; });
          if (!v) throw new Error('One of these videos is no longer there.');
          return A.api('/posts/create', { kind: 'reel', media: [{ url: v.url, kind: 'video' }], caption: r.caption, scheduled_for: new Date(r.date + 'T' + r.time).toISOString(), render_id: id, platforms: plats, title: plats.indexOf('youtube') >= 0 ? r.yt : '' })
            .then(function () { r.made = { title: v.topic, when: A.fmtWhen(new Date(r.date + 'T' + r.time)) }; save(); });
        });
      }, Promise.resolve());
    }).then(function () {
      f.lastBatch = f.batch.map(function (id) { return f.rows[id].made; }); f.lastPlats = plats; A.status(true); go('done');
    }, function (err) {
      var made = f.batch.filter(function (id) { return f.rows[id].made; }).length - before;
      btn.disabled = false; btn.textContent = 'Try again';
      A.toast((made ? made + ' scheduled, then: ' : '') + err.message);
    });
  }

  /* =======================================================================
   * Drawing.
   * ===================================================================== */
  function drawStepper() {
    stepperEl.textContent = '';
    var steps = FLOWS[f.kind];
    if (!steps || f.screen === 'start' || f.screen === 'done') { stepperEl.hidden = true; return; }
    stepperEl.hidden = false;
    var cur = steps.findIndex(function (s) { return s[0] === f.screen; });
    var ol = el('ol');
    steps.forEach(function (s, i) {
      var skipped = f.skipped && (s[0] === 'script' || s[0] === 'film') && i < cur;
      ol.append(el('li', { class: i < cur ? 'done' : i === cur ? 'now' : '', 'aria-current': i === cur ? 'step' : null },
        el('span', { class: 'n', text: skipped ? '–' : i < cur ? '✓' : i + 1 }), el('span', { class: 'lbl', text: s[1] + (skipped ? ' (skipped)' : '') }),
        i < steps.length - 1 ? el('span', { class: 'sep', 'aria-hidden': 'true' }) : null));
    });
    stepperEl.append(el('nav', { 'aria-label': 'Progress' }, ol));
  }

  var footState = null;
  function drawFoot() {
    footEl.textContent = '';
    var steps = FLOWS[f.kind];
    if (!steps || f.screen === 'start' || f.screen === 'done' || f.screen === 'review') { footEl.hidden = true; return; }
    footEl.hidden = false;
    var cur = steps.findIndex(function (s) { return s[0] === f.screen; });
    var nx = footState = nextFor();
    var inner = el('div', { class: 'inner row' },
      el('button', { type: 'button', class: 'btn-q', onclick: back }, 'Back'),
      el('button', { type: 'button', class: 'btn-q', onclick: finishLater }, 'Save and go home'),
      el('span', { class: 'quiet grow', style: { textAlign: 'right' }, text: nx.note || '' }));
    if (!nx.hidden) {
      var b = el('button', { type: 'button', class: 'btn btn-p', disabled: Boolean(nx.disabled) }, nx.label);
      b.addEventListener('click', function () { nx.go(b); });
      inner.append(b);
    }
    footEl.append(inner);
    return cur;
  }
  function nextFor() {
    switch (f.screen) {
      case 'plan':
        if (f.planSent) return { label: 'See progress', go: function () { go('making'); } };
        var n = (f.plan && f.plan.slots || []).length;
        if (planComplete()) return { label: 'Make ' + A.plural(n, 'video'), note: 'About 30 minutes · up to 12 a day', go: makeVideos };
        return { label: 'Make videos', disabled: true, note: !f.chat.some(function (m) { return m.who === 'y'; }) ? 'Send Aiko a topic first'
          : 'Tell Aiko which ideas to make. Once it locks them in, you can make them' };
      case 'making': return { hidden: true, note: 'You can leave this page. Videos shows them when they’re ready.' };
      case 'script':
        if (!script) return { label: writing ? 'Writing…' : composer.busy() ? 'Reading your files…' : 'Write the script', disabled: writing || composer.busy() || !composer.canSend(), note: 'About 20 seconds', go: writeScript };
        return { label: 'I’m ready to film', disabled: scriptDirty(), note: scriptDirty() ? 'Save and check your changed lines first' : '', go: function () { go('film'); } };
      case 'film': return { label: 'I’ve filmed it', go: function () { go('upload'); } };
      case 'upload': return { hidden: true, note: upload.state === 'sending' ? 'Keep this tab open while it uploads' : 'Review starts on its own once the clips are cut' };
      case 'schedule':
        var any = accounts && Object.keys(NAMES).some(function (k) { return f.plats && f.plats[k] && accounts[k] === 'on'; });
        return { label: 'Schedule ' + A.plural((f.batch || []).length, 'video'), disabled: !any, note: any ? '' : 'Choose at least one place to post', go: scheduleAll };
    }
    return { hidden: true };
  }
  function back() {
    var steps = FLOWS[f.kind];
    var cur = steps.findIndex(function (s) { return s[0] === f.screen; });
    if (f.screen === 'script' && script) { script = null; f.scriptId = null; save(); draw(); return; }
    if (cur <= 0) { f = { screen: 'start' }; save(); draw(); return; }
    if (f.skipped && f.screen === 'upload') { f.skipped = false; go('script'); return; }
    go(steps[cur - 1][0]);
  }
  function finishLater() { save(); location.href = './?home'; }

  function draw() {
    if (editor) { editor.destroy(); editor = null; }
    drawStepper();
    main.textContent = '';
    main.className = 'page' + (f.screen === 'review' ? '' : ' narrow');
    var screen = f.screen;
    if (screen === 'start') drawStart();
    else if (screen === 'plan') drawPlan();
    else if (screen === 'making') drawMaking();
    else if (screen === 'script') drawScript();
    else if (screen === 'film') drawFilm();
    else if (screen === 'upload') drawUpload();
    else if (screen === 'review') drawReview();
    else if (screen === 'schedule') drawSchedule();
    else if (screen === 'done') drawDone();
    drawFoot();
  }

  var FLOW_NAME = { auto: 'Making videos with Aiko', film: 'Filming yourself', upload: 'Uploading a video', queue: 'Reviewing videos' };
  var STEP_NAME = { plan: 'planning', making: 'waiting for the videos', script: 'the script', film: 'filming', upload: 'uploading', review: 'reviewing', schedule: 'scheduling' };
  function drawStart() {
    /* Something left half-way: offer it first, with a way to drop it. */
    var saved = A.flow();
    if (saved && saved.screen && saved.screen !== 'start' && saved.screen !== 'done' && FLOWS[saved.kind]) {
      main.append(el('div', { class: 'nextup', style: { cursor: 'default' } },
        el('span', { class: 'grow', style: { display: 'flex', flexDirection: 'column' } },
          el('span', { class: 'eyebrow', style: { color: 'var(--ochre)' }, text: 'In progress' }),
          el('span', { class: 'ink', style: { fontWeight: 600 }, text: (FLOW_NAME[saved.kind] || 'Making something') + ' · at ' + (STEP_NAME[saved.screen] || saved.screen) })),
        el('button', { type: 'button', class: 'btn-q', onclick: function () { A.saveFlow(null); f = { screen: 'start' }; draw(); A.toast('Cleared'); } }, 'Start over'),
        el('button', { type: 'button', class: 'btn btn-p btn-sm', onclick: function () { f = saved; draw(); } }, 'Pick up where you left off')));
    }
    var next = el('div');
    main.append(next);
    A.nextUp(next, { flow: true });
    main.append(el('h1', { style: { textAlign: 'center', marginTop: '16px' }, text: 'What are we making today?' }),
      el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' } },
        el('button', { type: 'button', class: 'big', onclick: function () { start('auto'); } },
          el('span', { class: 'eyebrow', text: 'About 30 minutes' }), el('span', { class: 't', text: 'Make videos for me' }), el('span', { class: 'quiet', text: 'Plan with Aiko. We make the videos.' })),
        el('button', { type: 'button', class: 'big', onclick: function () { start('film'); } },
          el('span', { class: 'eyebrow', style: { color: 'var(--ochre)' }, text: 'You on camera' }), el('span', { class: 't', text: 'Film myself' }), el('span', { class: 'quiet', text: 'Get a script to read, film it, and we cut it into clips.' }))),
      el('button', { type: 'button', class: 'btn btn-s', style: { alignSelf: 'center' }, onclick: function () { start('upload'); } }, 'Already have a video of you? Upload it'));
    var recent = el('div', { class: 'stack', style: { gap: '8px' } });
    main.append(recent);
    A.api('/plan/list', { limit: 5 }).then(function (d) {
      if (!d.plans || !d.plans.length) return;
      recent.append(el('span', { class: 'eyebrow', text: 'Recent plans' }));
      d.plans.forEach(function (p) {
        recent.append(el('button', { type: 'button', class: 'card row', style: { justifyContent: 'space-between', padding: '12px 16px', textAlign: 'left', color: 'inherit', minHeight: '48px' }, onclick: function () { openPlan(p); } },
          el('span', { class: 'ink', style: { fontWeight: 500 }, text: p.goal }),
          el('span', { class: 'quiet', text: A.fmtDay(p.updated_at) + ' · ' + A.plural(p.slots, 'video') + (p.rendered ? ' · made' : '') })));
      });
    }, function () {});
  }

  function openPlan(p) {
    A.api('/plan', { session_id: p.id }).then(function (d) {
      var plan = d.plan || { slots: [] };
      var slots = plan.slots || [];
      f = { kind: 'auto', screen: 'plan', sessionId: p.id, history: [], plan: { goal: plan.goal, target_count: plan.target_count, slots: slots, rejected: plan.rejected || [] },
        planComplete: slots.length > 0 && !p.rendered, planSent: Boolean(p.rendered),
        chat: [{ who: 'a', text: 'Here’s the plan from ' + A.fmtDay(p.updated_at) + ':\n\n' + slots.map(function (s, i) { return (i + 1) + '. **' + (s.topic || 'Untitled') + '**' + (s.opening_line ? ' — “' + s.opening_line + '”' : ''); }).join('\n')
          + (p.rendered ? '\n\nThese were already made; they’re under Videos. Ask for changes to start a new batch from this plan.' : '\n\nAsk for changes, or make them.') }] };
      if (p.rendered) { f.sessionId = newSession(); f.planSent = false; f.planComplete = false; }
      composer.reset(); save(); draw();
    }, function (err) { A.toast(err.message); });
  }

  function drawPlan() {
    main.append(el('h1', { text: 'Plan with Aiko' }));
    var chat = el('div', { class: 'chat' });
    f.chat.forEach(function (m) {
      var row = chatRow(m);
      chat.append(row);
      if (thinking && m.who === 'a' && m === f.chat[f.chat.length - 1]) streamEl = row;
    });
    if (thinking && thinkingText) chat.append(el('div', { class: 'pulse', role: 'status', text: thinkingText }));
    main.append(chat);
    if (!f.planSent) {
      var c = composer.mount(main, 'plan', f.chat.some(function (m) { return m.who === 'ideas'; }), function () { if (footState) drawFoot(); });
      c.addEventListener('send', function () { if (composer.canSend() && !thinking) send(); });
      if (!f.chat.some(function (m) { return m.who === 'y'; })) {
        main.append(el('div', { class: 'row', style: { gap: '8px' } }, el('span', { class: 'quiet', text: 'Or start from' }),
          ['Financing basics for beginners', 'First flip mistakes'].map(function (t) { return el('button', { type: 'button', class: 'chip', onclick: function () { composer.setText(t); } }, t); }),
          el('button', { type: 'button', class: 'chip', onclick: function () {
            A.api('/recordings/list').then(function (d) { var r = (d.recordings || []).find(function (x) { return x.status === 'ready'; }); if (r) composer.addRecordingById(r.id); else A.toast('No recordings yet. Use the microphone to record one.'); });
          } }, 'My latest recording')));
      }
    } else {
      main.append(el('div', { class: 'card pad row' }, el('span', { class: 'grow ink', text: 'This plan has been sent to be made.' }), el('button', { type: 'button', class: 'btn btn-s btn-sm', onclick: function () { go('making'); } }, 'See progress')));
    }
    if (thinking) { var last = chat.lastElementChild; if (last) last.scrollIntoView({ block: 'end', behavior: 'smooth' }); }
  }

  function drawMaking() {
    var made = f.madeSoFar || 0, total = f.renderCount || 1;
    main.append(el('div', { style: { textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'center', marginTop: '32px' } },
      el('h1', { text: 'Making ' + A.plural(total, 'video') }),
      el('div', { class: 'bar' + (made ? '' : ' indeterminate'), style: { width: '100%', maxWidth: '420px' } }, el('i', { style: made ? { width: Math.round(made / total * 100) + '%' } : null })),
      el('span', { class: 'quiet', text: made ? made + ' of ' + total + ' ready so far.' : 'About 30 minutes from when you started. Review starts here as soon as they’re ready.' })));
    if (!makeTimer) watchRenders();
  }

  function drawScript() {
    main.append(el('h1', { text: script ? 'Your script' : 'What’s the video about?' }));
    if (f.scriptId && !script) { main.append(el('p', { class: 'pulse', text: 'Loading the script…' })); loadScript(); return; }
    if (!script) {
      /* Filmed already: the script step is skipped, not filled in. */
      main.append(el('div', { class: 'card pad row' },
        el('span', { class: 'grow', style: { display: 'flex', flexDirection: 'column' } },
          el('span', { class: 'ink', style: { fontWeight: 600 }, text: 'Already filmed it?' }),
          el('span', { class: 'quiet', text: 'Skip the script and upload your video. It’s cut into clips for you.' })),
        el('button', { type: 'button', class: 'btn btn-s', onclick: function () { f.skipped = true; go('upload'); } }, 'Skip to upload')));
      main.append(el('span', { class: 'quiet', text: 'Or tell Aiko what the video is about and it writes one:' }));
      composer.mount(main, 'script', false, function () { if (footState) drawFoot(); });
      return;
    }
    drawScriptEditor(main);
  }

  function drawFilm() {
    if (f.scriptId && !script) loadScript();
    main.append(el('h1', { text: 'Film it' }),
      el('span', { class: 'quiet', text: script ? 'Script: ' + script.topic : 'No script. Film whatever you like; the best moments are found for you.' }),
      el('div', { class: 'card', style: { padding: '22px', display: 'flex', flexDirection: 'column', gap: '14px' } },
        ['Hold the phone upright', 'Face a window for light', 'Mistakes are fine. Pause and say the line again.'].map(function (t) {
          return el('div', { class: 'row ink', html: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="#2C785E" stroke-width="2"></circle><path d="M8 12.5l2.5 2.5L16 9.5" fill="none" stroke="#2C785E" stroke-width="2"></path></svg>' }, el('span', { text: t }));
        })),
      script ? el('div', {}, el('button', { type: 'button', class: 'btn btn-s', onclick: openPrompter }, 'Open teleprompter')) : null);
  }

  function drawUpload() {
    main.append(el('h1', { text: 'Upload your video' }));
    if (f.take && upload.state !== 'sending') {
      var st = f.take.status || 'uploaded';
      var tag = { uploaded: ['Waiting to be cut', 'tag busy'], transcribing: ['Transcribing…', 'tag busy'], ready: ['Cutting clips…', 'tag busy'], failed: ['Failed', 'tag bad'], empty: ['No clips', 'tag'] }[st] || [st, 'tag'];
      var card = el('div', { class: 'card', style: { padding: '22px', display: 'flex', flexDirection: 'column', gap: '12px' } },
        el('div', { class: 'row', style: { justifyContent: 'space-between' } }, el('span', { class: 'ink', style: { fontWeight: 600 }, text: f.take.name }), el('span', { class: tag[1], text: tag[0] })));
      if (st === 'failed') {
        card.append(el('span', { class: 'bad-text', text: f.take.error || 'The cutting run stopped.' }),
          el('div', {}, el('button', { type: 'button', class: 'btn btn-s btn-sm', onclick: function () { A.api('/footage/retry', { id: f.take.id }).then(function () { f.take.status = 'uploaded'; save(); draw(); watchTake(); }, function (e) { A.toast(e.message); }); } }, 'Try again')));
      } else if (st === 'empty') {
        card.append(el('span', { class: 'ink', text: 'Nothing in this take opened cleanly enough to make a short. The transcript is kept under Library › Footage.' }),
          el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn btn-s btn-sm', onclick: function () { f.take = null; save(); draw(); } }, 'Upload another take'), el('a', { class: 'btn-q', href: './library.html?tab=footage' }, 'See it in Library')));
      } else {
        card.append(el('div', { class: 'bar indeterminate' }, el('i')),
          el('span', { class: 'quiet', text: st === 'ready' ? 'Transcribed. Cutting it into short clips now.' : 'Uploaded. Turning the talk into text, then finding the best moments. A ten-minute take takes a few minutes.' }));
        if (!takeTimer) watchTake();
      }
      main.append(card);
      return;
    }
    main.append(el('div', { class: 'card pad stack', style: { gap: '6px' } },
      el('span', { class: 'eyebrow', text: 'What happens to your video' }),
      el('ol', { class: 'ink', style: { margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '4px' } },
        el('li', { text: 'We turn what you say into text.' }),
        el('li', { text: 'We pick the best moments and cut them into short vertical clips with captions, automatically.' }),
        el('li', { text: 'The clips come back here for you to review, edit and approve.' })),
      el('span', { class: 'quiet', text: 'Nothing is posted until you approve a clip and schedule it.' })));
    var name = el('input', { class: 'field', maxlength: '200', placeholder: 'Filled in from the file name', 'aria-label': 'Name this video', disabled: upload.state === 'sending' });
    name.value = f.takeName || (script ? script.topic : '');
    name.addEventListener('input', function () { f.takeName = name.value; save(); });
    main.append(el('label', { class: 'stack', style: { gap: '6px' } }, el('span', { class: 'ink', style: { fontWeight: 600 }, text: 'Name this video' }), name));
    if (upload.state === 'sending') {
      main.append(el('div', { class: 'card', style: { padding: '22px', display: 'flex', flexDirection: 'column', gap: '12px' } },
        el('div', { class: 'row', style: { justifyContent: 'space-between' } }, el('span', { class: 'ink', style: { fontWeight: 600 }, text: upload.name }), el('span', { class: 'tag busy', text: 'Uploading' })),
        el('div', { class: 'bar' }, el('i', { 'data-up-bar': '', style: { width: upload.pct + '%' } })),
        el('span', { class: 'quiet', 'data-up-pct': '', text: 'Sending, ' + upload.pct + '% of ' + gb(upload.size) + '. Keep this tab open.' })));
      return;
    }
    var picker = el('input', { type: 'file', accept: 'video/mp4,video/quicktime,video/x-matroska,video/webm', hidden: true });
    function pick(file) {
      if (!file) return;
      var nm = name.value.trim() || file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 200);
      name.value = nm;
      beginUpload(file, nm);
    }
    picker.addEventListener('change', function () { pick(picker.files[0]); });
    var drop = el('div', { style: { border: '2px dashed var(--strong)', borderRadius: '4px', padding: '48px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', textAlign: 'center' } },
      el('span', { html: '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#2C785E" stroke-width="2" aria-hidden="true"><path d="M12 16V4M6 10l6-6 6 6M4 20h16"></path></svg>' }),
      el('span', { class: 'ink', style: { fontWeight: 600 }, text: 'Drop the video here' }),
      el('button', { type: 'button', class: 'btn btn-p', onclick: function () { picker.click(); } }, 'Choose file'),
      el('span', { class: 'quiet', text: 'mp4, mov, mkv or webm, up to 5GB' }), picker);
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.style.borderColor = 'var(--emerald)'; });
    drop.addEventListener('dragleave', function () { drop.style.borderColor = ''; });
    drop.addEventListener('drop', function (e) { e.preventDefault(); e.stopPropagation(); drop.style.borderColor = ''; pick(e.dataTransfer.files[0]); });
    main.append(drop);
    if (upload.error) main.append(el('p', { class: 'bad-text', role: 'alert', text: upload.error }));
  }

  function drawReview() {
    var head = el('div', { class: 'row', style: { justifyContent: 'space-between' } });
    var host = el('div', { class: 'card', style: { overflow: 'hidden' } }, el('p', { class: 'pulse', style: { padding: '22px' }, text: 'Loading…' }));
    main.append(head, host);
    A.status().then(function (s) {
      var v = currentQueueVideo(s);
      save();
      if (!v) { advance(null); return; }
      var last = f.qi + 1 >= f.queue.length;
      head.append(el('button', { type: 'button', class: 'btn-q', onclick: finishLater }, 'Save and go home'),
        el('span', { class: 'ink', style: { fontWeight: 600 }, text: 'Video ' + (f.qi + 1) + ' of ' + f.queue.length }));
      host.textContent = '';
      editor = AikoEditor.mount(host, v, {
        approveLabel: last ? 'Approve, then schedule' : 'Approve, next video',
        onApprove: function () { advance(v.id); },
        onReject: function () {
          A.toast('Rejected', function () { A.api('/videos/review', { id: v.id, status: 'review' }).then(function () { A.status(true); }); });
          advance(null);
        },
        onSent: function (_, mode) {
          A.toast(mode === 'remake' ? 'Re-make started. It’s back in To review in about 30 minutes.' : mode === 'clip' ? 'Changes sent. The new cut is back in To review in a few minutes.' : 'Changes sent. The new version is back in To review in about 10 minutes.');
          advance(null);
        },
        onNewer: function () { A.status(true).then(draw); },
      });
    });
  }

  function drawSchedule() {
    main.append(el('h1', { text: 'When should ' + ((f.batch || []).length === 1 ? 'it' : 'they') + ' go out?' }));
    var host = el('div', { class: 'stack', style: { gap: '18px' } }, el('p', { class: 'pulse', text: 'Checking your accounts…' }));
    main.append(host);
    Promise.all([loadAccounts(), A.status()]).then(function (r) {
      var acc = r[0], s = r[1];
      if (!f.plats) { f.plats = {}; Object.keys(NAMES).forEach(function (k) { f.plats[k] = acc[k] === 'on'; }); save(); }
      host.textContent = '';
      var stale = Object.keys(NAMES).filter(function (k) { return acc[k] === 'reconnect'; });
      if (stale.length) host.append(el('div', { class: 'card pad callout bad row' }, el('span', { class: 'ink grow', text: A.joinNames(stale.map(function (k) { return NAMES[k]; })) + ' needs you to sign in again before it can post.' }), el('a', { class: 'btn btn-s btn-sm', href: './schedule.html#accounts' }, 'Social accounts')));
      if (!Object.keys(NAMES).some(function (k) { return acc[k] === 'on'; })) host.append(el('div', { class: 'card pad callout row' }, el('span', { class: 'ink grow', text: 'No accounts are connected yet.' }), el('a', { class: 'btn btn-s btn-sm', href: './schedule.html#accounts' }, 'Connect accounts')));
      host.append(el('div', { class: 'stack', style: { gap: '8px' } }, el('span', { class: 'ink', style: { fontWeight: 600 }, text: 'Post to' }),
        el('div', { class: 'row', style: { gap: '8px' } }, Object.keys(NAMES).map(function (k) {
          var off = acc[k] !== 'on';
          return el('button', { type: 'button', class: 'chip', 'aria-pressed': String(Boolean(f.plats[k]) && !off), disabled: off,
            title: off ? 'Connect it under Schedule › Social accounts' : '', onclick: function () { f.plats[k] = !f.plats[k]; save(); draw(); } },
            NAMES[k] + (acc[k] === 'reconnect' ? ' · sign in again' : acc[k] === 'page' ? ' · choose a Page' : off ? ' · not connected' : ''));
        }))));
      var ytOn = f.plats.youtube && acc.youtube === 'on';
      var list = el('div', { class: 'card', style: { padding: '4px 18px' } });
      f.batch.forEach(function (id) {
        var v = s.videos.find(function (x) { return x.id === id; }) || {};
        var r = f.rows[id];
        var set = function (k) { return function (e) { r[k] = e.target.value; r.error = ''; save(); var c = e.target.parentNode.querySelector('[data-count]'); if (c) c.textContent = e.target.value.length + ' / ' + (k === 'yt' ? 100 : 2200); }; };
        var row = el('div', { style: { padding: '14px 0', borderBottom: '1px solid var(--rule)', display: 'flex', flexDirection: 'column', gap: '10px' } },
          el('div', { class: 'row', style: { gap: '14px' } },
            el('video', { src: v.url ? v.url.split('#')[0] + '#t=1' : '', preload: 'metadata', muted: true, 'aria-hidden': 'true', style: { width: '32px', height: '56px', objectFit: 'cover', borderRadius: '3px', background: '#000' } }),
            el('span', { class: 'ink grow', style: { fontWeight: 600, flexBasis: '160px' }, text: v.topic || 'Untitled' }),
            el('input', { type: 'date', class: 'field', 'aria-label': 'Date for ' + (v.topic || 'this video'), value: r.date, style: { width: 'auto', minHeight: '40px' }, oninput: set('date') }),
            el('input', { type: 'time', class: 'field', 'aria-label': 'Time for ' + (v.topic || 'this video'), value: r.time, style: { width: 'auto', minHeight: '40px' }, oninput: set('time') }),
            el('button', { type: 'button', class: 'btn-q', 'aria-expanded': String(r.open), onclick: function () { r.open = !r.open; save(); draw(); } }, r.open ? 'Close' : ytOn ? 'Edit caption and title' : 'Edit caption')),
          r.made ? el('span', { class: 'quiet', text: 'Scheduled for ' + r.made.when + '. Change it under Schedule.' }) : null,
          r.error ? el('span', { class: 'bad-text', role: 'alert', text: r.error }) : null);
        if (r.open) {
          if (ytOn) row.append(el('label', { class: 'stack', style: { gap: '4px' } }, el('span', { class: 'row', style: { justifyContent: 'space-between' } }, el('span', { class: 'ink', style: { fontWeight: 600, fontSize: '14px' }, text: 'YouTube title' }), el('span', { class: 'quiet mono', 'data-count': '', text: r.yt.length + ' / 100' })),
            el('input', { class: 'field', maxlength: '100', value: r.yt, oninput: set('yt') })));
          var cap = el('textarea', { class: 'field', rows: '3', maxlength: '2200', oninput: set('caption') }); cap.value = r.caption;
          row.append(el('label', { class: 'stack', style: { gap: '4px' } }, el('span', { class: 'row', style: { justifyContent: 'space-between' } }, el('span', { class: 'ink', style: { fontWeight: 600, fontSize: '14px' }, text: 'Caption' }), el('span', { class: 'quiet mono', 'data-count': '', text: r.caption.length + ' / 2200' })), cap));
          var det = el('details', {}, el('summary', { class: 'quiet', style: { cursor: 'pointer', minHeight: '32px' }, text: 'What it says (to lift lines from)' }));
          det.addEventListener('toggle', function () {
            if (!det.open || det.dataset.loaded) return;
            det.dataset.loaded = '1';
            var ol = el('ol', { class: 'ink', style: { margin: '6px 0 0', paddingLeft: '20px', fontSize: '14px' } }, el('li', { class: 'quiet', text: 'Loading…' }));
            det.append(ol);
            (v.kind === 'clip' ? A.api('/clips/info', { id: v.id }).then(function (d) { return [d.clip.words.filter(function (w) { return w.s >= d.clip.start_s && w.s < d.clip.end_s; }).map(function (w) { return w.t; }).join(' ')]; })
              : A.api('/videos/script', { id: v.id }).then(function (d) { return d.lines || ['No script was kept for this one.']; }))
              .then(function (ls) { ol.textContent = ''; ls.forEach(function (l) { ol.append(el('li', { text: l })); }); }, function () { ol.textContent = 'Couldn’t load it.'; });
          });
          row.append(det);
        }
        list.append(row);
      });
      host.append(list, el('span', { class: 'quiet', text: 'Times are spread out for you, a day apart. Captions start from each video’s opening line; open one to change it.' }));
      drawFoot();
    });
  }

  function drawDone() {
    var b = f.lastBatch || [];
    main.append(el('div', { style: { textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '14px', alignItems: 'center', marginTop: '20px' } },
      el('span', { html: '<svg width="48" height="48" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#2C785E"></circle><path d="M7 12.5l3.2 3L17 9" fill="none" stroke="#fff" stroke-width="2"></path></svg>' }),
      el('h1', { text: A.plural(b.length, 'video') + ' scheduled' }),
      f.lastPlats ? el('span', { class: 'quiet', text: 'Going to ' + A.joinNames(f.lastPlats.map(function (k) { return NAMES[k]; })) }) : null),
      el('div', { class: 'card', style: { padding: '4px 20px' } }, b.map(function (x) {
        return el('div', { class: 'row', style: { justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid var(--rule)' } }, el('span', { class: 'ink', style: { fontWeight: 600 }, text: x.title }), el('span', { class: 'quiet', text: x.when }));
      })),
      el('div', { class: 'row', style: { justifyContent: 'center' } },
        el('a', { class: 'btn btn-s', href: './schedule.html' }, 'See schedule'),
        el('button', { type: 'button', class: 'btn btn-p', onclick: function () { f = { screen: 'start' }; save(); draw(); } }, 'Make more')));
    A.saveFlow(null);
  }

  /* --- where to begin ------------------------------------------------------- */
  if (sessionParam) { openPlan({ id: sessionParam, updated_at: new Date(), rendered: 0 }); }
  else if (startWith === 'plan') { start('auto'); var rid = params.get('recording'); if (rid) composer.addRecordingById(rid); }
  else if (startWith === 'film') { var sid = params.get('script'); start('film', sid ? { scriptId: sid, screen: 'film' } : null); }
  else if (startWith === 'upload') start('upload');
  else if (goTo === 'review') {
    A.status(true).then(function (s) {
      var ids = s.videos.filter(function (v) { return A.videoState(v, s.posts) === 'review'; }).map(function (v) { return v.id; });
      if (!ids.length) { A.toast('Nothing to review right now'); draw(); return; }
      f = { kind: 'queue', screen: 'review', queue: ids, qi: 0, batch: [] }; save(); draw();
    });
  } else if (goTo === 'schedule') {
    A.status(true).then(function (s) {
      var ids = s.videos.filter(function (v) { return A.videoState(v, s.posts) === 'approved'; }).map(function (v) { return v.id; });
      if (!ids.length) { A.toast('Nothing approved to schedule'); draw(); return; }
      f = { kind: 'queue' }; startScheduling(ids);
    });
  } else draw();
})();
