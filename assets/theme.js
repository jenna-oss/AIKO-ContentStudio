/* ---------------------------------------------------------------------------
 * Theme toggle.
 *
 * The palette already resolves from :root[data-theme]; this just writes that
 * attribute and remembers the choice. Default is the system preference, not a
 * forced dark — someone on a light desktop should not be handed a dark page
 * because the mockup happened to be captured in dark.
 *
 * The attribute is set in a blocking script in <head> so the correct theme is
 * painted on the first frame rather than flashing the wrong one.
 * ------------------------------------------------------------------------ */

(function () {
  'use strict';

  var KEY = 'aiko-theme';

  function system() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark' : 'light';
  }

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  /* Runs immediately, before the body paints. */
  apply(stored() || system());

  /* Follow the system while the user has expressed no preference of their own. */
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
      if (!stored()) apply(e.matches ? 'dark' : 'light');
    });
  }

  window.AikoTheme = {
    current: function () {
      return document.documentElement.getAttribute('data-theme') || system();
    },
    toggle: function () {
      var next = this.current() === 'dark' ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
      return next;
    },
    /* Wires a button and keeps its label in step with the current theme. */
    mount: function (btn) {
      if (!btn) return;
      var label = btn.querySelector('[data-theme-label]') || btn;
      var self = this;
      function sync() {
        var t = self.current();
        label.textContent = t === 'dark' ? 'Dark' : 'Light';
        btn.setAttribute('aria-pressed', String(t === 'dark'));
      }
      btn.addEventListener('click', function () { self.toggle(); sync(); });
      sync();
    },
  };
})();
