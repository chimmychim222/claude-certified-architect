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
  var LS_PRODUCTS = 'cca_products';  // 'ccar' | 'ccdv' | 'both' from the ID token claims; absent = free

  // Returns the #nav-auth-static wrapper, creating it on-the-fly if the page
  // was served from a stale CDN cache that predates the wrapper injection.
  // Falls back to finding the bare .nav-auth-login / .nav-auth-signup links and
  // wrapping them, so the swap always has a single container to innerHTML-replace.
  function getCluster() {
    var el = document.getElementById('nav-auth-static');
    if (el) return el;
    // Fallback: locate the individual auth links and wrap them dynamically.
    var login = document.querySelector('a.nav-auth-login');
    if (!login) return null; // not a static-nav page at all
    var signup = document.querySelector('a.nav-auth-signup');
    var wrapper = document.createElement('div');
    wrapper.id = 'nav-auth-static';
    login.parentElement.insertBefore(wrapper, login);
    wrapper.appendChild(login);
    if (signup) wrapper.appendChild(signup);
    return wrapper;
  }

  // N1 grouped nav (Oct 2026): the nav element carries class cnav-in while a
  // visitor is signed in; CSS inside the nav swaps the Log In / Sign Up Free
  // pair for the account button, and these fill the email and the badge.
  function navRoot() { var r = document.querySelector('nav .cnav'); return r ? r.parentNode : null; }
  function badgeFor(p) {
    return p === 'both' ? 'ENROLLED \u00B7 BOTH' : p === 'ccdv' ? 'ENROLLED \u00B7 CCDV-F' : p === 'ccar' ? 'ENROLLED \u00B7 CCAR-F' : 'FREE';
  }
  // Show the signed-in state. products is undefined until the claims are read.
  function applyLoggedIn(email, products) {
    var nav = navRoot();
    if (nav) {
      nav.classList.add('cnav-in');
      nav.querySelectorAll('[data-acct-email]').forEach(function (x) { x.textContent = email || ''; });
      if (products !== undefined) {
        nav.querySelectorAll('[data-acct-badge]').forEach(function (x) {
          x.textContent = badgeFor(products);
          x.className = 'cnav-badge ' + (products ? 'enrolled' : 'free');
        });
      }
      return;
    }
    // Pre-N1 markup (served from a cache during the deploy window): old behaviour.
    var c = getCluster(); if (!c) return;
    var name = (email || 'Account').split('@')[0].slice(0, 20);
    c.innerHTML =
      '<span class="nav-user-name" title="' + email + '">' + name + '</span>' +
      '<button class="nav-logout-btn" onclick="window.__navSO&&window.__navSO()">Log out</button>';
  }

  // Restore the signed-out state.
  function applyLoggedOut() {
    var nav = navRoot();
    if (nav) { nav.classList.remove('cnav-in'); return; }
    var c = getCluster(); if (!c) return;
    c.innerHTML =
      '<a href="/?login=true" class="nav-auth-login"' +
      ' onclick="if(window.closeNav)closeNav()">Log In</a>' +
      '<a href="/?signup=true" class="nav-auth-signup"' +
      ' onclick="if(window.closeNav)closeNav()">Sign Up Free</a>';
  }

  // ── B3 (Oct 2026): buy buttons for signed-in owners ───────────────────────
  // On the CCAR-F pages (register, cca-practice-questions, cca-foundations-exam,
  // cca-exam-guide, diagnostic) a CCAR-F owner sees every $49 button as
  // "Enrolled ✓ Go to dashboard" linking to the dashboard. On the CCDV-F page a
  // CCDV-F owner sees the same, opening the Developer tab, and a CCAR-F-only
  // owner sees the $50 add button. Logged-out and free visitors keep the
  // buttons exactly as served. Runs from the localStorage hint first (instant),
  // then again from the ID token claims; an authoritative sign-out restores
  // every button from the attributes saved on first swap.
  var BUY_SEL = 'a[href="/?checkout=true"], a[href="/?startTest=full"], button[onclick*="buyNow()"], a[href="/?checkout=ccdv"]';
  var ENROLLED_LABEL = 'Enrolled \u2713 Go to dashboard';
  function applyBuyButtons(products) {
    if (products === undefined) return;
    var ccar = products === 'ccar' || products === 'both', ccdv = products === 'ccdv' || products === 'both';
    var els = document.querySelectorAll(BUY_SEL);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.hasAttribute('data-buy-orig')) {
        el.setAttribute('data-buy-orig', el.textContent);
        el.setAttribute('data-buy-href', el.getAttribute('href') || '');
        el.setAttribute('data-buy-onclick', el.getAttribute('onclick') || '');
      }
      var isCcdv = el.getAttribute('data-buy-href') === '/?checkout=ccdv';
      var label = null, href = null;
      if (isCcdv) {
        if (ccdv) { label = ENROLLED_LABEL; href = '/?hub=practice-tests&product=ccdv'; }
        else if (ccar) { label = 'Add CCDV-F: $50'; href = '/?checkout=ccdv'; }
      } else if (ccar) { label = ENROLLED_LABEL; href = '/?hub=practice-tests'; }
      if (label) {
        el.textContent = label;
        el.classList.add('btn-enrolled');
        if (el.tagName === 'A') el.setAttribute('href', href);
        else { el.removeAttribute('onclick'); el.onclick = (function (h) { return function () { window.location.href = h; }; })(href); }
      } else if (el.classList.contains('btn-enrolled')) {
        el.textContent = el.getAttribute('data-buy-orig');
        el.classList.remove('btn-enrolled');
        if (el.tagName === 'A') el.setAttribute('href', el.getAttribute('data-buy-href'));
        else { el.onclick = null; el.setAttribute('onclick', el.getAttribute('data-buy-onclick')); }
      }
    }
  }
  function hintProducts() {
    try {
      if (!localStorage.getItem(LS_EMAIL)) return '';
      return localStorage.getItem(LS_PRODUCTS) || (localStorage.getItem(LS_ENROLLED) === 'true' ? 'ccar' : '');
    } catch (e) { return ''; }
  }
  applyBuyButtons(hintProducts());

  // ── Deferred Firebase Auth load ────────────────────────────────────────────
  // Uses requestIdleCallback (with 3 s timeout fallback) so the Firebase SDK
  // download never competes with the page's critical rendering path.
  // (G, Oct 2026) A buy button on a static page goes through the homepage
  // (/?checkout=true), whose app.js is cold for a visitor who landed here.
  // Prefetch it at idle so that hop finds it in the cache. Pages that already
  // load app.js (the diagnostic) skip this. No markup changes.
  function prefetchApp() {
    try {
      if (document.querySelector('script[src="/app.js"]') || document.querySelector('link[rel="prefetch"][href="/app.js"]')) return;
      var l = document.createElement('link'); l.rel = 'prefetch'; l.href = '/app.js'; l.as = 'script';
      document.head.appendChild(l);
    } catch (e) {}
  }

  function loadAuth() {
    if (!getCluster()) return; // not a static-nav page
    prefetchApp();

    Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js')
    ]).then(function (mods) {
      var initializeApp      = mods[0].initializeApp;
      var getApps            = mods[0].getApps;
      var getAuth            = mods[1].getAuth;
      var onAuthStateChanged = mods[1].onAuthStateChanged;
      var signOut            = mods[1].signOut;

      // Prefer the [DEFAULT] app if app.js has already initialized it (e.g. on
      // /diagnostic/). Using the same app instance means onAuthStateChanged reads
      // from the same auth session — no separate 'nav-auth' auth state that would
      // fire null and clear the localStorage hint. Fall back to a named app on
      // static pages where app.js is absent.
      var apps    = getApps();
      var defApp  = apps.find(function (a) { return a.name === '[DEFAULT]'; });
      var navApp  = apps.find(function (a) { return a.name === 'nav-auth'; });
      var app     = defApp || navApp || initializeApp(FIREBASE_CONFIG, 'nav-auth');
      var auth    = getAuth(app);

      // Record which app instance this page ended up using. onAuthStateChanged
      // below needs this: a null result is only authoritative when it comes from
      // the [DEFAULT] app (the same instance app.js signs in/out on). A null from
      // a freshly-created 'nav-auth' app means nothing — that instance has no
      // persisted session under its own name (Firebase's IndexedDB persistence
      // key is scoped by app name), so it will report null even when the visitor
      // has a real, logged-in [DEFAULT] session app.js just hasn't started yet.
      var appName = app.name;
      window.__navAuthAppName = appName; // exposed for debugging/inspection only

      // Expose signOut for the "Log out" button (set before onAuthStateChanged
      // fires so a quick click on the instant-hint logout button still works).
      window.__navSO = function () {
        signOut(auth).then(function () {
          try {
            localStorage.removeItem(LS_EMAIL);
            localStorage.removeItem(LS_ENROLLED);
            localStorage.removeItem(LS_PRODUCTS);
          } catch (e) {}
          window.location.reload();
        });
      };

      // onAuthStateChanged is the authoritative cross-browser auth check.
      // It reads from IndexedDB on Safari/iOS and works where localStorage
      // persistence would silently fail. A non-null user is always applied —
      // it's real regardless of which app instance produced it. A null result
      // is only trustworthy from the [DEFAULT] app; see appName comment above.
      onAuthStateChanged(auth, function (user) {
        if (user) {
          applyLoggedIn(user.email);
          try { localStorage.setItem(LS_EMAIL, user.email); } catch (e) {}
          // Badge wording from the cached ID token (no network call): enrolled
          // or products.ccar is CCAR-F, products.ccdv is CCDV-F, both is BOTH.
          if (user.getIdTokenResult) {
            user.getIdTokenResult().then(function (tok) {
              var cl = (tok && tok.claims) || {}, p = cl.products || {};
              var ccar = cl.enrolled === true || p.ccar === true, ccdv = p.ccdv === true;
              var prod = ccar && ccdv ? 'both' : ccdv ? 'ccdv' : ccar ? 'ccar' : '';
              try { if (prod) localStorage.setItem(LS_PRODUCTS, prod); else localStorage.removeItem(LS_PRODUCTS); } catch (e) {}
              applyLoggedIn(user.email, prod);
              applyBuyButtons(prod);
            }).catch(function () {});
          }
        } else if (appName === '[DEFAULT]') {
          // Authoritative: this is the same app instance app.js signs in/out
          // on, so null here means the visitor is genuinely not logged in.
          // Clear the hint flags so the next page load shows logged-out state.
          try {
            localStorage.removeItem(LS_EMAIL);
            localStorage.removeItem(LS_ENROLLED);
            localStorage.removeItem(LS_PRODUCTS);
          } catch (e) {}
          // If the inline hint applied logged-in state (stale localStorage),
          // correct it now that we have the authoritative answer.
          applyLoggedOut();
          applyBuyButtons('');
        }
        // else: appName === 'nav-auth' — a fresh, separately-named app with no
        // persisted session under that name. This null is not evidence of
        // logged-out; do nothing and leave whatever the inline hint rendered.
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
