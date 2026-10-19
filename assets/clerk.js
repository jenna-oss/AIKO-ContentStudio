/* ---------------------------------------------------------------------------
 * Loads Clerk, for signin.html and for assets/auth.js on every other page.
 *
 * AikoClerk.ready resolves to the loaded Clerk instance, or rejects if Clerk
 * can't be reached. The publishable key is meant to be public: it only names
 * this app's Clerk instance. The secret key is the Worker's.
 * ------------------------------------------------------------------------ */
(function () {
  'use strict';

  /* From the Clerk dashboard, API keys. pk_test_... while trying it out,
     pk_live_... once the production instance is set up. */
  var PUBLISHABLE_KEY = 'pk_test_d2FudGVkLW1vdGgtNDU1Mi5jbGVyay5hY2NvdW50cy5kZXYk';

  /* The key is pk_<env>_<base64 of "your-frontend-api-host$">, and Clerk's
     script is served from that host. */
  function frontendApi(key) {
    try {
      var host = atob(key.split('_')[2]);
      return /^[a-z0-9.-]+\.[a-z]+\$$/i.test(host) ? host.slice(0, -1) : '';
    } catch (e) { return ''; }
  }

  var host = frontendApi(PUBLISHABLE_KEY);

  var ready = new Promise(function (resolve, reject) {
    if (!host) { reject(new Error('Sign-in isn’t set up yet: assets/clerk.js needs the Clerk publishable key.')); return; }
    var s = document.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.setAttribute('data-clerk-publishable-key', PUBLISHABLE_KEY);
    s.src = 'https://' + host + '/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
    s.onload = function () {
      window.Clerk.load().then(function () { resolve(window.Clerk); }, reject);
    };
    s.onerror = function () { reject(new Error('Couldn’t reach the sign-in service. Try again.')); };
    document.head.appendChild(s);
  });

  window.AikoClerk = { ready: ready };
})();
