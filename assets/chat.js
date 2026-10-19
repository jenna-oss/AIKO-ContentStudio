/* ---------------------------------------------------------------------------
 * Shared chat behaviour for both pages.
 *
 * The plan page mounts it full-width; the briefing mounts it inside a
 * floating panel. Keeping one copy matters more than the few lines it saves:
 * two hand-maintained SSE parsers would drift, and the drift would show up as
 * one page answering differently from the other.
 *
 * Exposes window.AikoChat.create(...) — no modules, because both pages are
 * plain static files served straight off Pages.
 * ------------------------------------------------------------------------ */

(function () {
  'use strict';

  /* Escape first, then add the small amount of markup the model actually emits.
     Order matters: markdown links are converted before bare URLs, and the
     bare-URL pattern requires whitespace or '(' before the scheme so it cannot
     match a URL already sitting inside an href. */
  function render(md) {
    const esc = String(md)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      /* Quotes too: a URL lands inside href="…", and a " in model output (which
         can carry text from scraped ads) would otherwise close the attribute. */
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return esc
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{3}\s+(.+)$/gm, '<h4>$1</h4>')
      .replace(/^#{1,2}\s+(.+)$/gm, '<h3>$1</h3>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
               '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
               '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  }

  /* opts:
   *   workerUrl   deployed Worker base; empty disables the chat and shows setup
   *   transcript  element the conversation is appended to
   *   form        the composer <form>
   *   input       the <textarea>
   *   button      the submit <button>
   *   starters    optional NodeList/array of clickable prompt buttons
   *   buildPayload optional (brief, history) => payload, for pages that send
   *               more than free text — the planner turns 'plan 5 videos' into
   *               a planning-mode request
   *   onSubmitted optional () => void, called once per send after the payload
   *               is built — for clearing staged attachments
   *   onPlan      optional (wrapper, data) => void for planning-mode results
   *   onPlanState optional (plan) => void for session state after each change
   *   setupNote   optional element revealed when workerUrl is empty
   */
  function create(opts) {
    const {
      workerUrl, transcript, form, input, button,
      starters = [], onPlan = null, onPlanState = null, setupNote = null,
    } = opts;

    const history = [];
    let busy = false;
    const extraDisable = [];

    /* The composer is optional — a page may drive run() from its own controls
     * instead — so every reference to input/button/form below is guarded. */
    const hasComposer = Boolean(form && input && button);

    if (!workerUrl) {
      if (setupNote) setupNote.hidden = false;
      if (hasComposer) {
        input.disabled = button.disabled = true;
        input.placeholder = 'Backend not configured — see the note above';
      }
      /* starters are the containing groups, so reach the buttons inside them. */
      Array.from(starters).forEach((group) => {
        group.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      });
    }

    function addMessage(kind, who, text) {
      const el = document.createElement('div');
      el.className = 'msg ' + kind;
      const w = document.createElement('div');
      w.className = 'who';
      w.textContent = who;
      const b = document.createElement('div');
      b.className = 'bubble';
      b.textContent = text || '';
      el.append(w, b);
      transcript.append(el);
      el.scrollIntoView({ block: 'end', behavior: 'smooth' });
      return { wrapper: el, bubble: b };
    }

    function setBusy(state) {
      busy = state;
      if (hasComposer) button.disabled = state;
      extraDisable.forEach((el) => { el.disabled = state; });
    }

    async function run(payload, userLabel, botLabel) {
      setBusy(true);

      const shown = payload.brief || ('Plan ' + payload.count + ' videos.');
      const asked = addMessage('user', userLabel, shown);

      /* Show what was attached under the message that carried it. Without this
         the transcript reads as if the question were asked about nothing, and
         scrolling back you cannot tell which turn the file belonged to. */
      if (payload.attachments && payload.attachments.length) {
        const tray = document.createElement('div');
        tray.className = 'attachments';
        payload.attachments.forEach((a) => {
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.textContent = a.name;
          tray.append(chip);
        });
        asked.wrapper.append(tray);
      }

      const { wrapper, bubble } = addMessage('bot', botLabel, '');
      /* One quiet line while the agent works, instead of a row per search and
         a token count at the end. The searches still happen; watching every
         one of them go past was more than anyone needed to follow along. They
         are logged to the console for debugging. */
      const status = document.createElement('div');
      status.className = 'status';
      status.textContent = 'Thinking…';
      wrapper.append(status);

      let answer = '';
      try {
        const res = await (window.AikoAuth ? window.AikoAuth.fetch : fetch)(workerUrl.replace(/\/+$/, '') + '/ideas', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!res.ok || !res.body) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(detail.error || ('request failed (' + res.status + ')'));
        }

        /* Parse the SSE stream by hand — EventSource cannot POST. Frames can be
           cut mid-boundary, so keep the trailing partial in the buffer. */
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';

          for (const frame of frames) {
            const lines = frame.split('\n');
            const evLine = lines.find((l) => l.indexOf('event: ') === 0);
            const dataLine = lines.find((l) => l.indexOf('data: ') === 0);
            if (!evLine || !dataLine) continue;
            const event = evLine.slice(7).trim();
            let data;
            try { data = JSON.parse(dataLine.slice(6)); } catch (e) { continue; }

            if (event === 'token') {
              answer += data;
              status.hidden = true;
              bubble.classList.add('cursor');
              bubble.innerHTML = render(answer);
              bubble.scrollIntoView({ block: 'end' });
            } else if (event === 'tool') {
              console.info('[aiko] ' + data.label + (data.failed ? ' (failed)' : ''),
                data.detail, data.summary != null ? data.summary : data.count);
              /* Saving a pick reads differently from looking something up. */
              status.textContent = /lock|batch size|rejection|library|saving/i.test(data.label)
                ? 'Saving…' : 'Looking into it…';
              status.hidden = false;
              bubble.classList.remove('cursor');
            } else if (event === 'plan') {
              if (onPlan) onPlan(wrapper, data);
            } else if (event === 'plan_state') {
              /* The session state after the model's tool calls. Sent mid-turn
                 as things are agreed, and again at the end, so the page can
                 mirror it without tracking the tools itself. */
              if (onPlanState) onPlanState(data);
            } else if (event === 'note') {
              console.info('[aiko] ' + data.message);
            } else if (event === 'error') {
              bubble.classList.remove('cursor');
              status.hidden = true;
              addMessage('error', 'Problem', data.message);
            } else if (event === 'done') {
              console.info('[aiko] ' + data.model + ' · ' + data.usage.searches + ' searches · '
                + data.usage.output + ' output tokens · ' + data.usage.cacheRead + ' cached');
              /* The end of a turn, carrying whether the plan is now complete.
                 The Plan page shows its confirm-and-render list from here. */
              if (opts.onDone) opts.onDone(wrapper, data);
            }
          }
        }
      } catch (err) {
        addMessage('error', 'Problem', err.message);
      } finally {
        bubble.classList.remove('cursor');
        status.remove();
        if (answer) history.push({ role: 'user', content: shown },
                                 { role: 'assistant', content: answer });
        setBusy(false);
        if (hasComposer) input.focus();
      }
    }

    if (hasComposer) {
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const brief = input.value.trim();
      if (!brief || busy || !workerUrl) return;
      input.value = '';
      input.style.height = 'auto';
      const payload = opts.buildPayload ? opts.buildPayload(brief, history) : { brief, history };
      /* After the payload is built, so a page that stages attachments can clear
         its tray without the clearing being a side effect of building. */
      if (opts.onSubmitted) opts.onSubmitted();
      run(payload, opts.userLabel || 'You', opts.botLabel || 'Answer');
    });
    }

    Array.from(starters).forEach((group) => {
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn || busy || !workerUrl) return;
        const text = btn.textContent.trim();
        if (hasComposer) { input.value = text; form.requestSubmit(); }
        else run({ brief: text, history }, opts.userLabel || 'You', opts.botLabel || 'Answer');
      });
    });

    return {
      run,
      render,
      addMessage,
      history,
      isBusy: () => busy,
      /* Extra controls a page wants greyed out while a request is in flight. */
      disableWhileBusy: (el) => { extraDisable.push(el); },
    };
  }

  window.AikoChat = { create, render };
})();
