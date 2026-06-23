// nav-auth.js — Lightweight auth-state navbar sync for static pages.
//
// Loaded with <script defer> so it never blocks LCP. Strategy:
//   1. (Synchronous inline hint — see renderNav() in build.js) reads localStorage
//      and swaps the nav cluster BEFORE first paint with zero CLS.
//   2. This file loads Firebase App + Auth ONLY (no Firestore, no app.js)
//      via requestIdleCallback so it does not compete with LCP resources.
//      Works on ALL browsers including iOS Safari where Firebase uses
//      IndexedDB (onAuthStateChanged is the authoritative source of truth).
//   3. Writes/refreshes the localStorage hint flags so subsequent page loads
//      get the instant first-paint hint.
//
// NOT loaded on the homepage — the homepage uses app.js / updateNavUI() instead.
// nav-auth.js bails immediately if #nav-auth-static is not in the DOM.

(function () {
  'use strict';

  var FIREBASE_CONFIG = {
    apiKey:            'AIzaSyD33Y4s1X1XtDvjBGu3XyEpukZ07zeCpLE',
    authDomain:        'claude-certification-testing.firebaseapp.com',
    projectId:         'claude-certification-testing',
    storageBucket:     'claude-certification-testing.firebasestorage.app',
    messagingSenderId: '1068142706417',
    appId:             '1:1068142706417:web:19e94aebd76901d3813350'
  };

  var LS_EMAIL    = 'cca_logged_in'; // value = user's email; absent = logged out
  var LS_ENROLLED = 'cca_enrolled';  // value = 'true' if enrolled

  function getCluster() { return document.getElementById('nav-auth-static'); }

  // Replace the static Log In / Sign Up Free links with a logged-in cluster.
  function applyLoggedIn(email) {
    var c = getCluster(); if (!c) return;
    var name = (email || 'Account').split('@')[0].slice(0, 20);
    c.innerHTML =
      '<span class="nav-user-name" title="' + email + '">' + name + '</span>' +
      '<button class="nav-logout-btn" onclick="window.__navSO&&window.__navSO()">Log out</button>';
  }

  // Restore the static Log In / Sign Up Free links.
  function applyLoggedOut() {
    var c = getCluster(); if (!c) return;
    c.innerHTML =
      '<a href="/?login=true" class="nav-auth-login"' +
      ' onclick="if(window.closeNav)closeNav()">Log In</a>' +
      '<a href="/?signup=true" class="nav-auth-signup"' +
      ' onclick="if(window.closeNav)closeNav()">Sign Up Free</a>';
  }

  // ── Deferred Firebase Auth load ────────────────────────────────────────────
  // Uses requestIdleCallback (with 3 s timeout fallback) so the Firebase SDK
  // download never competes with the page's critical rendering path.
  function loadAuth() {
    if (!getCluster()) return; // not a static-nav page

    Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js')
    ]).then(function (mods) {
      var initializeApp      = mods[0].initializeApp;
      var getApps            = mods[0].getApps;
      var getAuth            = mods[1].getAuth;
      var onAuthStateChanged = mods[1].onAuthStateChanged;
      var signOut            = mods[1].signOut;

      // Use a named app so we never collide with app.js's [DEFAULT] instance.
      // getApps() guard prevents double-init if this script somehow executes twice.
      var existing = getApps().find(function (a) { return a.name === 'nav-auth'; });
      var app  = existing || initializeApp(FIREBASE_CONFIG, 'nav-auth');
      var auth = getAuth(app);

      // Expose signOut for the "Log out" button (set before onAuthStateChanged
      // fires so a quick click on the instant-hint logout button still works).
      window.__navSO = function () {
        signOut(auth).then(function () {
          try {
            localStorage.removeItem(LS_EMAIL);
            localStorage.removeItem(LS_ENROLLED);
          } catch (e) {}
          window.location.reload();
        });
      };

      // onAuthStateChanged is the authoritative cross-browser auth check.
      // It reads from IndexedDB on Safari/iOS and works where localStorage
      // persistence would silently fail.
      onAuthStateChanged(auth, function (user) {
        if (user) {
          applyLoggedIn(user.email);
          try { localStorage.setItem(LS_EMAIL, user.email); } catch (e) {}
        } else {
          // Clear the hint flags so the next page load shows logged-out state.
          try {
            localStorage.removeItem(LS_EMAIL);
            localStorage.removeItem(LS_ENROLLED);
          } catch (e) {}
          // If the inline hint applied logged-in state (stale localStorage),
          // correct it now that we have the authoritative answer.
          applyLoggedOut();
        }
      });
    }).catch(function (e) {
      console.warn('[nav-auth] Firebase load failed:', e);
    });
  }

  if ('requestIdleCallback' in window) {
    requestIdleCallback(loadAuth, { timeout: 3000 });
  } else {
    setTimeout(loadAuth, 200);
  }
})();
