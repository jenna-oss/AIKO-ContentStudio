/* ---------------------------------------------------------------------------
 * Sign-in, for every page behind it.
 *
 * Loaded in <head>, before anything else draws. It loads Clerk (through
 * assets/clerk.js) and keeps the page hidden until it knows you are signed in;
 * with no session it sends you to signin.html, and back to this page
 * afterwards. It gives pages AikoAuth.fetch, which adds Clerk's session token
 * to Worker calls and sends you back to sign in when the Worker stops
 * accepting it. It also puts a Sign out button in the nav.
 *
 * Clerk keeps the session and refreshes its token by itself. The token is only
 * a key for the Worker, which checks it and the app's list on every call, so
 * nothing on this side is trusted for access.
 * ------------------------------------------------------------------------ */
(function () {
  'use strict';

  var root = document.documentElement;
  root.style.visibility = 'hidden';

  var leaving = false;
  function toSignIn(why) {
    if (leaving) return;
    leaving = true;
    root.style.visibility = 'hidden';
    var here = (location.pathname.split('/').pop() || '') + location.search;
    var q = 'next=' + encodeURIComponent(here);
    if (why) q += '&why=' + encodeURIComponent(why);
    location.replace('./signin.html?' + q);
  }

  /* An error about the session itself, as opposed to the network failing.
     Only these send you back to sign in. */
  function authError(message) {
    var e = new Error(message || 'Sign in again.');
    e.auth = true;
    return e;
  }

  var clerk = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = './assets/clerk.js';
    s.onload = function () { window.AikoClerk.ready.then(resolve, reject); };
    s.onerror = function () { reject(new Error('Couldn’t load sign-in. Try again.')); };
    document.head.appendChild(s);
  });

  function token(skipCache) {
    return clerk.then(function (c) {
      if (!c.session) throw authError();
      return c.session.getToken(skipCache ? { skipCache: true } : undefined);
    }).then(function (t) {
      if (!t) throw authError();
      return t;
    });
  }

  function withAuth(init, t) {
    var next = Object.assign({}, init || {});
    var h = new Headers(next.headers || {});
    h.set('authorization', 'Bearer ' + t);
    next.headers = h;
    return next;
  }

  function signOut(why) {
    return clerk.then(function (c) { return c.signOut(); })
      .catch(function () { /* signed out on this side regardless */ })
      .then(function () {
        if (why) toSignIn(why);
        else location.replace('./signin.html');
      });
  }

  /* fetch for Worker calls. On a 401 it gets a fresh token and retries once;
     if the Worker still says no, or says this email isn't on the list, it
     sends you to sign in. Other responses come back to the page as they are. */
  function authFetch(url, init) {
    return token()
      .then(function (t) { return window.fetch(url, withAuth(init, t)); })
      .then(function (res) {
        if (res.status === 401) {
          return token(true).then(function (t2) { return window.fetch(url, withAuth(init, t2)); })
            .then(function (again) {
              if (again.status === 401) throw authError();
              return again;
            });
        }
        if (res.status === 403) {
          return res.clone().json().then(function (body) {
            if (body && body.signin) signOut('not-listed');
            return res;
          }, function () { return res; });
        }
        return res;
      })
      .catch(function (err) {
        if (err && err.auth) toSignIn('expired');
        throw err;
      });
  }

  var email = null;

  function mountButton() {
    var nav = document.querySelector('.site-nav');
    if (!nav || document.getElementById('sign-out')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'sign-out';
    b.className = 'theme-toggle';
    b.textContent = 'Sign out';
    if (email) b.title = 'Signed in as ' + email;
    b.addEventListener('click', function () { signOut(); });
    nav.append(b);
  }

  window.AikoAuth = {
    fetch: authFetch,
    signOut: function () { return signOut(); },
    email: function () { return email; },
  };

  clerk.then(function (c) {
    if (!c.user) { toSignIn(); return; }
    var primary = c.user.primaryEmailAddress;
    email = primary ? String(primary.emailAddress).toLowerCase() : null;
    root.style.visibility = '';
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountButton);
    else mountButton();
  }, function (err) {
    /* Clerk is unreachable. Show the page rather than a blank screen; its
       Worker calls will fail with this message until Clerk is back. */
    console.error(err);
    root.style.visibility = '';
  });
})();
