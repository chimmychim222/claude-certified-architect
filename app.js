
// ═══════════════════════════════════════
// CURRENCY DATA
// ═══════════════════════════════════════
const RATES = {
  USD:1,EUR:.92,GBP:.79,CAD:1.36,AUD:1.53,JPY:149.5,CNY:7.24,INR:83.1,
  BRL:4.97,KRW:1335,MXN:17.15,CHF:.88,SEK:10.42,SGD:1.34,NZD:1.63,
  ZAR:18.65,NGN:1550,AED:3.67,SAR:3.75,PLN:3.98,THB:35.5,IDR:15650,
  PHP:56.2,TWD:31.5,HKD:7.82,ILS:3.65,COP:3920,CLP:935,EGP:30.9,NOK:10.55,DKK:6.87
};
const SYMBOLS = {
  USD:'$',EUR:'€',GBP:'£',CAD:'CA$',AUD:'A$',JPY:'¥',CNY:'¥',INR:'₹',
  BRL:'R$',KRW:'₩',MXN:'MX$',CHF:'CHF ',SEK:'kr ',SGD:'S$',NZD:'NZ$',
  ZAR:'R ',NGN:'₦',AED:'د.إ ',SAR:'﷼ ',PLN:'zł ',THB:'฿',IDR:'Rp ',
  PHP:'₱',TWD:'NT$',HKD:'HK$',ILS:'₪',COP:'COL$',CLP:'CLP$',EGP:'E£',NOK:'kr ',DKK:'kr '
};
const NO_DECIMALS = ['JPY','KRW','CLP','IDR','COP','NGN'];

function formatPrice(cur) {
  const amount = 49 * RATES[cur];
  const sym = SYMBOLS[cur] || cur + ' ';
  const dec = NO_DECIMALS.includes(cur) ? 0 : 2;
  return sym + amount.toLocaleString('en-US', {minimumFractionDigits:dec, maximumFractionDigits:dec});
}
function updateCurrency() {
  const cur = document.getElementById('currency-select').value;
  const display = document.getElementById('price-display');
  const note = document.getElementById('price-note');
  // The Stripe Payment Link behind "Proceed to Secure Checkout" always
  // charges in USD — there's no multi-currency checkout wired up. So a
  // converted figure here is an FX *estimate* for the visitor's orientation
  // only, never the actual amount that will be charged. Showing it as a
  // bare "€45" would read as a price quote and surprise people at checkout
  // when Stripe charges $49 USD instead.
  //
  // The "≈ … " prefix marks it as an approximation, and the small note
  // beneath spells out the real USD charge in full — split into two
  // differently-sized lines (rather than one long string jammed into the
  // giant .price headline) so it stays legible and doesn't wrap awkwardly
  // on narrow/mobile viewports.
  //
  // (This also used to write into #modal-price and #pay-btn-price, two
  // elements that no longer exist in the page — that threw a TypeError on
  // every currency change. Both references are gone now.)
  if (cur === 'USD') {
    display.textContent = '$49.00';
    note.style.display = 'none';
  } else {
    display.textContent = '≈ ' + formatPrice(cur);
    note.textContent = 'Billed as $49.00 USD — shown amount is an estimate';
    note.style.display = 'block';
  }
}

// ═══════════════════════════════════════
// FIREBASE CONFIG
// ═══════════════════════════════════════
// ┌───────────────────────────────────────────────────────────────┐
// │  HOW TO SET UP:                                               │
// │                                                               │
// │  FIREBASE (free tier handles thousands of users):             │
// │  1. Go to https://console.firebase.google.com                 │
// │  2. Create a new project                                      │
// │  3. Enable Authentication → Email/Password sign-in method     │
// │  4. Create a Firestore Database (start in production mode)    │
// │  5. Add this Firestore security rule:                         │
// │     rules_version = '2';                                      │
// │     service cloud.firestore {                                 │
// │       match /databases/{database}/documents {                 │
// │         match /users/{userId} {                               │
// │           allow read, write: if request.auth.uid == userId;   │
// │         }                                                     │
// │       }                                                       │
// │     }                                                         │
// │  6. Go to Project Settings → Your Apps → Add Web App          │
// │  7. Copy the firebaseConfig object below                      │
// │                                                               │
// │  STRIPE:                                                      │
// │  1. Go to https://dashboard.stripe.com/payment-links          │
// │  2. Create a payment link for $49.00 USD                      │
// │  3. Under "After payment" set redirect to:                    │
// │     https://YOUR-DOMAIN.com/claude-certified-architect.html?paid=true │
// │  4. Enable "Collect email" so you can match to Firebase user  │
// │  5. Replace STRIPE_PAYMENT_LINK below with your link          │
// └───────────────────────────────────────────────────────────────┘

const firebaseConfig = {
  apiKey: "AIzaSyD33Y4s1X1XtDvjBGu3XyEpukZ07zeCpLE",
  authDomain: "claude-certification-testing.firebaseapp.com",
  projectId: "claude-certification-testing",
  storageBucket: "claude-certification-testing.firebasestorage.app",
  messagingSenderId: "1068142706417",
  appId: "1:1068142706417:web:19e94aebd76901d3813350"
};

const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/cNi28k2GE7LngeRcc03ks00';

// Without a continue URL, Firebase's verification-email link routes to its
// own generic hosted "Your email has been verified" page — a dead end with
// no way back to the site. A buyer who clicks through from their inbox would
// have to know to manually navigate back to claudecertifiedarchitects.com to
// finish unlocking their purchase. Passing this through `sendEmailVerification`
// puts a "Continue" link on that page back to the homepage, where
// onAuthStateChanged automatically re-checks (and claims) the pending
// enrollment with the now-verified token — no extra wiring needed.
const VERIFY_ACTION_CODE_SETTINGS = { url: 'https://www.claudecertifiedarchitects.com/', handleCodeInApp: false };
// Same as above but with ?claim=1 appended — used when submitAuth detects a
// likely pending purchase for this signup (see mayHavePendingPurchase there)
// and unconditionally by the "Resend verification email" button in
// showPendingVerificationBanner, which by definition only shows once a
// pending purchase is already confirmed server-side. Both want the
// verification link's landing page to auto-attempt claiming it.
const VERIFY_ACTION_CODE_SETTINGS_CLAIM = Object.assign({}, VERIFY_ACTION_CODE_SETTINGS, { url: VERIFY_ACTION_CODE_SETTINGS.url + '?claim=1' });

// Initialize Firebase
let firebaseReady = false;
let db = null;
let auth = null;
let firebaseApp = null;
let firestoreLoadPromise = null;
// Modular Auth function set (signInWithEmailAndPassword, onAuthStateChanged,
// getIdTokenResult, etc.) — populated alongside `auth` once the dynamically
// imported modular bundle loads. See the big comment at the Firebase init
// block for why `auth` must ALSO be modular now (not compat `firebase.auth()`).
let fbAuth = null;
// IMPORTANT — why `db` is a MODULAR Firestore instance, not a compat one:
// This project's Firestore data lives in a database whose literal database
// ID is the custom string "default" — a *named* database, distinct from the
// SDK's special reserved "(default)" database (which doesn't even exist for
// this project; confirmed via scripts/diagnose-firestore.js, which traced a
// blanket "5 NOT_FOUND" on every read/write through admin.firestore() back
// to exactly this mismatch — see scripts/migrate-firestore-default-db.js for
// the full investigation trail).
//
// The compat SDK (`firebase.firestore()`) can ONLY ever connect to
// "(default)" — verified by inspecting the shipped compat bundle: its
// internal factory calls getProvider("firestore").getImmediate() with no
// identifier, hard-wiring it to the default instance, with no public way to
// override it. Named databases are ONLY reachable via the modular (v9) API's
// getFirestore(app, databaseId).
//
// So `db` here is intentionally a MODULAR Firestore instance pointed at
// "default", loaded via dynamic import (works fine from a classic script).
// `window.__fs` exposes the modular function set (doc, getDoc, setDoc, etc.)
// for the rest of the app to call alongside it — see each call site for the
// v9-style usage (note: snapshot.exists is a METHOD in modular — exists() —
// not a property like in compat). Firestore (~92KB, almost entirely unused
// by an anonymous homepage visitor) is loaded lazily by ensureFirestore()
// below, separately from the app+auth bundle.
document.addEventListener('DOMContentLoaded', function() {
  // Capture gclid immediately on landing — before Firebase loads — and persist
  // to sessionStorage so openPaymentModal() can read it even if the user later
  // navigates to a different page before clicking checkout.
  (function () {
    try {
      var g = new URLSearchParams(window.location.search).get('gclid');
      if (g) sessionStorage.setItem('cca_gclid', g);
    } catch (e) {}
  })();

  // Capture ?checkout=true synchronously — before Firebase loads — so the
  // checkout intent is set before onAuthStateChanged fires. For logged-out
  // users the existing window.__pendingCheckout check (line ~549) fires
  // openPaymentModal() → openAuthModal('signup'). For logged-in users the
  // existing _hasIntent check (line ~447) fires openPaymentModal() → Stripe.
  // Clearing the URL here prevents the later URL-param handlers (lines ~534
  // and ~602) from double-calling openPaymentModal when the same param is
  // consumed by the early-intent path above.
  // ?checkout=resume is the same intent, arriving via the email-verification
  // continueUrl (see VERIFY_ACTION_CODE_SETTINGS / submitAuth) instead of a
  // marketing-page CTA — treated identically so it re-arms the same flags.
  (function() {
    try {
      const _checkoutParam = new URLSearchParams(window.location.search).get('checkout');
      if (_checkoutParam === 'true' || _checkoutParam === 'resume') {
        window.__pendingCheckout = true;
        try { sessionStorage.setItem('cca_checkout_intent', '1'); } catch(e) {}
        window.history.replaceState({}, '', window.location.pathname);
        if (typeof gtag !== 'undefined') { gtag('event', 'checkout_intent_landed', { checkout_param: _checkoutParam }); }
      }
    } catch(e) {}
  })();

  // Capture ?login=true and ?signup=true — same synchronous pattern as
  // ?checkout=true above. Consumed in onAuthStateChanged's else branch.
  // ?signup=true deliberately does NOT set cca_checkout_intent — it opens
  // the free signup modal with no purchase flow attached.
  (function() {
    try {
      if (new URLSearchParams(window.location.search).get('login') === 'true') {
        window.__pendingLogin = true;
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch(e) {}
  })();
  (function() {
    try {
      if (new URLSearchParams(window.location.search).get('signup') === 'true') {
        window.__pendingSignup = true;
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch(e) {}
  })();

  // Capture ?claim=1 synchronously — same pattern as ?checkout=/?login=/
  // ?signup= above. Arrives via the email-verification continueUrl (see
  // VERIFY_ACTION_CODE_SETTINGS_CLAIM / submitAuth's mayHavePendingPurchase
  // check, and the resend button in showPendingVerificationBanner) — this
  // account may have a pending_enrollments record waiting on email
  // verification. Consumed once auth state resolves and a user is present
  // (onAuthStateChanged below). No sessionStorage mirror needed, unlike
  // __pendingCheckout — this is consumed on the same page load it lands on,
  // not across a later reload.
  (function() {
    try {
      if (new URLSearchParams(window.location.search).get('claim') === '1') {
        window.__pendingClaim = true;
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch(e) {}
  })();

  // Restore the "this browser's payment never got matched" warning across
  // reloads — see flagPaymentNeedsReview/PAYMENT_NEEDS_REVIEW_KEY. Runs
  // before Firebase loads; if enrollment turns out to already be confirmed,
  // markEnrolled() (called from initAuthListener below) clears this and
  // replaces the banner with the success message.
  try {
    if (localStorage.getItem(PAYMENT_NEEDS_REVIEW_KEY) === '1') {
      window.__paymentNeedsManualReview = true;
      const banner = document.getElementById('success-banner');
      if (banner) {
        banner.innerHTML = unmatchedPaymentMsg();
        banner.style.display = 'block';
      }
    }
  } catch(e) {}

  // Restore the guest "create a free account to unlock your purchase" banner
  // across reloads — see the anonymous-branch ?paid=true handling and
  // PENDING_PURCHASE_KEY. Runs before Firebase loads, same as the
  // manual-review restore above. Guarded explicitly against
  // PAYMENT_NEEDS_REVIEW_KEY so precedence holds regardless of block order: a
  // payment that failed to match must keep showing "don't pay again," never
  // "create an account."
  try {
    if (localStorage.getItem(PENDING_PURCHASE_KEY) === '1' && localStorage.getItem(PAYMENT_NEEDS_REVIEW_KEY) !== '1') {
      window.__pendingPurchaseShown = true;
      const banner = document.getElementById('success-banner');
      if (banner) {
        banner.innerHTML = pendingPurchaseMsg();
        banner.style.display = 'block';
      }
    }
  } catch(e) {}

  function loadFirebase() {
  (async function() {
  try {
    // IMPORTANT: app, auth, and (lazily, via ensureFirestore below) firestore
    // must ALL come from this same modular (v9) bundle family (NOT compat
    // firebase.app()/firebase.auth()). Two failed attempts proved this
    // empirically, live:
    //   1. Mixing compat app/auth with a separately-loaded modular Firestore
    //      bundle while firebase-firestore-compat.js was still on the page:
    //      that compat script had registered a 'firestore' component on the
    //      compat app using ITS OWN bundled Firestore classes, so
    //      getFirestore(app,'default') resolved through THAT factory and
    //      returned an instance of the wrong bundle's Firestore class --
    //      failing the modular bundle's `instanceof Firestore` checks in
    //      doc()/collection() with "Expected first argument to collection()
    //      to be a CollectionReference, a DocumentReference or
    //      FirebaseFirestore".
    //   2. Removing that compat script "fixed" #1 but broke it differently:
    //      "Service firestore is not available" -- because compat
    //      firebase-app-compat.js bundles its OWN internal copy of
    //      @firebase/app with its OWN component registry, entirely separate
    //      from the one the dynamically-imported modular Firestore bundle
    //      self-registers into. Two separate bundle graphs do not share
    //      component registrations -- there is no public bridge for it.
    // The fix: app, auth, and firestore are ALL the modular (v9) SDK from the
    // same gstatic firebasejs/10.12.0 family, sharing one registry and one
    // set of classes. `auth` is therefore a MODULAR Auth instance, and
    // `fbAuth` exposes the modular auth function set
    // (signInWithEmailAndPassword(auth,...), onAuthStateChanged(auth,...),
    // getIdTokenResult(user,...), sendEmailVerification(user), etc. -- see
    // each call site for v9-style usage). Compat firebase.initializeApp /
    // firebase.auth() are no longer used anywhere in this file.
    //
    // Loading firestore separately/later (ensureFirestore, reusing this same
    // `firebaseApp` instance) rather than in this initial Promise.all was
    // verified live to still share the registry correctly: an unauthenticated
    // getDoc() against the lazily-loaded `db` returns the backend's
    // "permission-denied" (proof the modular Firestore bundle found and
    // registered against this app), not the client-side registry-collision
    // errors from #1/#2 above.
    const [{ initializeApp }, authMod] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js')
    ]);

    firebaseApp = initializeApp(firebaseConfig);
    auth   = authMod.getAuth(firebaseApp);
    fbAuth = authMod;

    firebaseReady = true;
    initAuthListener();
    checkPaymentSuccess();
  } catch(e) {
    console.warn('Firebase not configured yet. Auth features disabled.', e);
  }
  })();
  }
  if ('requestIdleCallback' in window) {
    requestIdleCallback(loadFirebase, { timeout: 2000 });
  } else {
    setTimeout(loadFirebase, 1);
  }
});

// ── Bfcache / Stripe back-button handler ──────────────────────────────────────
// When the user navigates back from Stripe (browser back button OR Stripe's
// own in-page × / back arrow), the browser may restore this page from the
// back-forward cache (bfcache) with event.persisted === true.  If the auth
// modal was left open on the "Redirecting to secure checkout…" spinner, it
// would remain frozen in that state — the user looks logged in but broken.
//
// This handler fires before onAuthStateChanged can re-run, so:
//   1. It clears the checkout intent (prevents onAuthStateChanged resuming
//      checkout automatically — the user chose to leave Stripe).
//   2. It closes the modal so the page renders in a clean, logged-in state.
//
// The Stripe Payment Link has no configurable cancel_url (it's a hosted link,
// not a Checkout Session), so browser back is the only exit path — both the
// browser back button and Stripe's own navigation button go through bfcache.
window.addEventListener('pageshow', function(e) {
  if (!e.persisted) return;
  // Abandon any pending checkout intent — the user left Stripe voluntarily.
  window.__pendingCheckout = false;
  try { sessionStorage.removeItem('cca_checkout_intent'); } catch (_) {}
  // Unconditionally reset the modal on bfcache restore — don't rely on
  // classList.contains('show') which can be unreliable mid-restore. The
  // page was mid-checkout when it left, so any modal state is stale.
  try {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    modal.classList.remove('show');
    document.body.style.overflow = '';
    const formArea  = document.getElementById('auth-form-area');
    const loadingEl = document.getElementById('auth-loading');
    const welcomeEl = document.getElementById('auth-welcome');
    const errEl     = document.getElementById('auth-error');
    if (formArea)  formArea.style.display  = 'block';
    if (loadingEl) loadingEl.style.display = 'none';
    if (welcomeEl) welcomeEl.style.display = 'none';
    if (errEl)     { errEl.style.display = 'none'; errEl.textContent = ''; }
  } catch (_) {}
  // Proactively delete the checkout_intents/{uid} Firestore doc so that if
  // the user clicks buy again, /pre-checkout returns ok:true rather than
  // recent_session — which would show the "in progress" banner on what is
  // actually a fresh checkout attempt after abandoning Stripe.
  try {
    if (window.__fs && typeof db !== 'undefined' && currentUser) {
      window.__fs.deleteDoc(
        window.__fs.doc(db, 'checkout_intents', currentUser.uid)
      ).catch(function() {});
    }
  } catch (_) {}
});

// Lazily loads the modular Firestore SDK and points it at this project's
// custom-named "default" database (see the big `db` comment above).
// Memoized so concurrent callers (e.g. the auth-state listener and a login
// submission racing each other) share one in-flight import instead of
// fetching the bundle twice.
function ensureFirestore() {
  if (db) return Promise.resolve();
  if (!firestoreLoadPromise) {
    firestoreLoadPromise = import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js')
      .then(fsMod => {
        db = fsMod.getFirestore(firebaseApp, 'default');
        window.__fs = fsMod;
      })
      .catch(e => {
        firestoreLoadPromise = null; // allow retry on next call
        throw e;
      });
  }
  return firestoreLoadPromise;
}

// ═══════════════════════════════════════
// BANK SOURCE (Stage B2 of the bank move, Oct 2026)
// ═══════════════════════════════════════
// The paid CCAR-F bank (400 items) and the five lessons live ONLY in Firestore
// (bank_ccar, one document per domain; lessons_ccar, one per module), readable
// by an account whose ID token carries enrolled:true or products.ccar:true
// (firestore.rules). Their source of truth is the private repository
// cca-question-banks; nothing paid is bundled in this file any more. Every
// enrolled mode and the lessons await activeBank(); the free surfaces (Quick
// Sprint and the Focused preview for visitors who are not enrolled) draw from
// the FREE_POOL literal further down and never touch Firestore. A failed read
// is retried three times with backoff; after that the visitor sees "Couldn't
// load your questions." with a Retry button, and ONE GA4 event bank_load_error
// (error_code, attempts, provider) is sent. Stage A (bank_shadow) and Stage B1
// (bank_fallback) are retired; their reads are in the Build Schedule.
const bankCache = {};      // product -> Promise<items[]>
const lessonsCache = {};   // product -> Promise<modules[]>

// Reads bank_<product> into one array in bank order (each item carries its
// bank index i). The promise is cached per product so concurrent callers share
// one read; a failure clears the cache so the next call can retry.
function loadBank(product) {
  if (!bankCache[product]) {
    bankCache[product] = (async () => {
      await ensureFirestore();
      const fs = window.__fs;
      const snap = await fs.getDocs(fs.collection(db, 'bank_' + product));
      const items = [];
      snap.forEach(d => { const data = d.data() || {}; (data.items || []).forEach(it => items.push(it)); });
      items.sort((a, b) => a.i - b.i);
      if (!items.length) throw Object.assign(new Error('empty bank'), { code: 'empty-bank' });
      return items;
    })().catch(e => { delete bankCache[product]; throw e; });
  }
  return bankCache[product];
}

// Reads lessons_<product> into an array of {title, content} in module order.
// Same caching and retry shape as loadBank().
function loadLessons(product) {
  if (!lessonsCache[product]) {
    lessonsCache[product] = (async () => {
      await ensureFirestore();
      const fs = window.__fs;
      const snap = await fs.getDocs(fs.collection(db, 'lessons_' + product));
      const mods = [];
      snap.forEach(d => { const data = d.data() || {}; mods.push({ order: data.order, title: data.title, content: data.content }); });
      mods.sort((a, b) => a.order - b.order);
      if (!mods.length) throw Object.assign(new Error('empty lessons'), { code: 'empty-lessons' });
      return mods;
    })().catch(e => { delete lessonsCache[product]; throw e; });
  }
  return lessonsCache[product];
}

const BANK_LOAD_TIMEOUT_MS = 8000;
const BANK_LOAD_RETRIES = 3;                     // retries after the first read: four reads in all
const BANK_LOAD_BACKOFF_MS = [1000, 2000, 4000]; // wait before retry 1, 2 and 3
const LESSONS_EXPECTED = 5;
let activeBankPromise = null;   // Promise<{bank, lessons, source}>, one load per session; cleared on final failure so Retry starts afresh
let loadedBankCounts = null;    // per-domain item counts from the loaded bank (domainQuestionCount() prefers these)
function withTimeout(p, ms, code) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(Object.assign(new Error('timeout'), { code: code })); }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}
function sleepMs(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function providerOf(user) {
  try { return (user && user.providerData && user.providerData.length) ? user.providerData.map(function (x) { return x.providerId; }).sort().join('+') : 'none'; } catch (e) { return 'unknown'; }
}
function bankExpectedItems() {
  try { return Object.keys(BANK_DOMAIN_COUNTS).reduce(function (n, k) { return n + BANK_DOMAIN_COUNTS[k]; }, 0); } catch (e) { return 400; }
}
function bankLoadError(code, attempts) {
  try { if (typeof gtag !== 'undefined') gtag('event', 'bank_load_error', { error_code: String(code || 'none').slice(0, 40), attempts: attempts, provider: providerOf(currentUser) }); } catch (e) {}
  try { window.__bankLoadError = { error_code: String(code || 'none'), attempts: attempts }; } catch (e) {}
}
// One read of the bank and the lessons, with a timeout and a shape check.
async function loadActiveBankOnce() {
  const loaded = await withTimeout(Promise.all([loadBank('ccar'), loadLessons('ccar')]), BANK_LOAD_TIMEOUT_MS, 'timeout');
  const bank = loaded[0], mods = loaded[1];
  if (bank.length !== bankExpectedItems() || mods.length !== LESSONS_EXPECTED) throw Object.assign(new Error('bad count'), { code: 'bad-count' });
  if (!bank.every(function (q) { return q && typeof q.q === 'string' && Array.isArray(q.o) && q.a !== undefined; })) throw Object.assign(new Error('bad item'), { code: 'bad-item' });
  return { bank: bank, lessons: mods, source: 'firestore' };
}
// Resolves to the loaded bank and lessons. Retries three times with backoff,
// then reports bank_load_error once and rejects; the next call starts a fresh
// load (the Retry button). Shared by startTest() for every enrolled mode and
// by the lessons renderer; prefetched from markEnrolled().
function activeBank() {
  if (!activeBankPromise) {
    const p = (async function () {
      // (A) Never read the paid bank without an entitled session: wait for the
      // first auth state, then refuse at once, with no retry and no event.
      await whenAuthSettled();
      if (!currentUser || !enrolled) throw Object.assign(new Error('not entitled'), { code: 'not-entitled' });
      let lastErr = null, attemptsMade = 0;
      for (let attempt = 1; attempt <= 1 + BANK_LOAD_RETRIES; attempt++) {
        attemptsMade = attempt;
        try {
          const r = await loadActiveBankOnce();
          const counts = {};
          r.bank.forEach(function (q) { counts[q.d] = (counts[q.d] || 0) + 1; });
          loadedBankCounts = counts;
          try { window.__bankSource = 'firestore'; window.__bankAttempts = attempt; } catch (e) {}
          try { renderDomainDrillPicker(); } catch (e) {}
          return r;
        } catch (e) {
          lastErr = e;
          // (A) A rules denial does not change by waiting: fail at once.
          if (e && e.code === 'permission-denied') break;
          if (attempt <= BANK_LOAD_RETRIES) await sleepMs(BANK_LOAD_BACKOFF_MS[attempt - 1] || 4000);
        }
      }
      bankLoadError((lastErr && (lastErr.code || lastErr.name)) || 'unknown', attemptsMade);
      throw lastErr || new Error('bank load failed');
    })();
    activeBankPromise = p;
    p.catch(function () { if (activeBankPromise === p) activeBankPromise = null; });
  }
  return activeBankPromise;
}
// The error box: "Couldn't load your questions." with a Retry button. Built
// in script so the page markup does not change; null-guarded for pages that
// have no dashboard (the diagnostic loads this file for its modal only).
const BANK_LOAD_ERROR_TEXT = 'Couldn\u2019t load your questions.';
// Returns the box markup; the caller wires the Retry button with a listener
// (no inline script, so the mode name never has to be escaped into an attribute).
function bankLoadErrorHtml() {
  return '<div class="bank-load-error" role="alert" style="display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;margin:0 0 20px;padding:14px 18px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);font-family:-apple-system,system-ui,\'Segoe UI\',sans-serif;font-size:.95rem;color:var(--text)"><span>' + BANK_LOAD_ERROR_TEXT + '</span><button type="button" class="btn-secondary btn-sm bank-load-retry">Retry</button></div>';
}
function wireBankLoadRetry(container, onRetry) {
  const btn = container && container.querySelector('.bank-load-retry');
  if (btn) btn.onclick = onRetry;
}
function showBankLoadError(type) {
  const dash = document.getElementById('dashboard-section');
  if (!dash) { console.warn('[bank] load failed and no dashboard to report it on'); return; }
  showSection('dashboard');
  let box = document.getElementById('bank-load-error');
  if (!box) {
    box = document.createElement('div');
    box.id = 'bank-load-error';
    const grid = dash.querySelector('.dash-grid');
    (grid ? grid.parentNode : dash).insertBefore(box, grid || dash.firstChild);
  }
  box.innerHTML = bankLoadErrorHtml();
  wireBankLoadRetry(box, function () { hideBankLoadError(); startTest(type); });
  box.style.display = '';
}
function hideBankLoadError() { const box = document.getElementById('bank-load-error'); if (box) box.style.display = 'none'; }
// ═══════════════════════════════════════
// AUTH STATE
// ═══════════════════════════════════════
let currentUser = null;
let enrolled = false;
// (A, 19 Oct 2026) Resolves once the first auth state AND its entitlement check
// are known, so no paid read runs before a persisted session has been restored
// (an enrolled visitor who clicks within the first second on a slow network).
// Capped so a page whose Firebase never answers still settles.
let authSettledResolve = null;
const authSettled = new Promise(function (r) { authSettledResolve = r; });
function settleAuth() { if (authSettledResolve) { authSettledResolve(); authSettledResolve = null; } }
const AUTH_SETTLE_MAX_MS = 10000;
function whenAuthSettled() { return Promise.race([authSettled, sleepMs(AUTH_SETTLE_MAX_MS)]); }
// The lesson plan shown to a visitor who is not entitled: titles only, no read.
const LESSON_PLAN_TITLES = ['Agentic Architecture &amp; Orchestration', 'Claude Code Configuration', 'Prompt Engineering &amp; Structured Output', 'Tool Design &amp; MCP Integration', 'Context Management &amp; Reliability'];
function lessonPlanPreviewHtml() {
  return '<div class="lesson-plan-preview"><p>The five lesson modules are part of the CCAR-F practice bank:</p><ol>' + LESSON_PLAN_TITLES.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ol><p><button type="button" class="btn-primary" onclick="openPaymentModal()">Unlock all 400 questions and the lessons: $49</button></p><p class="q-paywall-sub">One-time payment · Lifetime access · 10-day money-back guarantee</p></div>';
}

function updateNavUI() {
  const loggedOut = document.getElementById('nav-logged-out');
  const loggedIn = document.getElementById('nav-logged-in');
  // Pages without the full site nav (e.g. /diagnostic/, which only loads
  // app.js for its checkout/auth modal) don't have these elements. Guarded
  // here, not with an early return, so the Lessons/Progress and mobile-dropdown
  // blocks below still run on a page that has some but not all of this markup.
  if (loggedOut && loggedIn) {
    if (currentUser) {
      loggedOut.style.display = 'none';
      loggedIn.style.display = 'flex';
      document.getElementById('nav-user-email').textContent = currentUser.email;
      const badge = document.getElementById('nav-user-badge');
      if (enrolled) {
        badge.textContent = 'ENROLLED \u00B7 CCAR-F';
        badge.className = 'user-badge enrolled';
      } else {
        badge.textContent = 'FREE';
        badge.className = 'user-badge free';
      }
    } else {
      loggedOut.style.display = 'flex';
      loggedIn.style.display = 'none';
    }
  }
  // Lessons and Progress nav links are enrolled-only — hide from public nav.
  const lessonsLink  = document.getElementById('nav-lessons-link');
  const progressLink = document.getElementById('nav-progress-link');
  if (lessonsLink)  lessonsLink.style.display  = (currentUser && enrolled) ? '' : 'none';
  if (progressLink) progressLink.style.display = (currentUser && enrolled) ? '' : 'none';

  // Mobile-dropdown equivalent of the desktop cluster above. #mobile-nav-user
  // lives inside #nav-links (see index.html), unlike #nav-logged-in/out, so
  // it needs its own guard, independent of the loggedOut/loggedIn check above:
  // each element is null-checked individually, so this runs (and safely
  // no-ops) even on a page that has neither, only one, or all of this markup.
  const mobileLogin  = document.getElementById('mobile-nav-login');
  const mobileSignup = document.getElementById('mobile-nav-signup');
  const mobileUser   = document.getElementById('mobile-nav-user');
  if (mobileLogin)  mobileLogin.style.display  = currentUser ? 'none' : '';
  if (mobileSignup) mobileSignup.style.display = currentUser ? 'none' : '';
  if (mobileUser) {
    mobileUser.classList.toggle('nav-signed-in', !!currentUser);
    if (currentUser) {
      const mobileEmail = document.getElementById('mobile-nav-user-email');
      if (mobileEmail) mobileEmail.textContent = currentUser.email;
      const mobileBadge = document.getElementById('mobile-nav-user-badge');
      if (mobileBadge) {
        if (enrolled) {
          mobileBadge.textContent = 'ENROLLED \u00B7 CCAR-F';
          mobileBadge.className = 'user-badge enrolled';
        } else {
          mobileBadge.textContent = 'FREE';
          mobileBadge.className = 'user-badge free';
        }
      }
    }
  }
  // N1 grouped nav (Oct 2026): the mobile panel's Lessons and Progress rows
  // follow the desktop links; both pairs are enrolled-only. Null-guarded so
  // the old markup (deploy cache window) and /diagnostic/ are unaffected.
  const mobileLessons  = document.getElementById('mobile-nav-lessons-link');
  const mobileProgress = document.getElementById('mobile-nav-progress-link');
  if (mobileLessons)  mobileLessons.style.display  = (currentUser && enrolled) ? '' : 'none';
  if (mobileProgress) mobileProgress.style.display = (currentUser && enrolled) ? '' : 'none';
  // Badge wording per product from the cached ID token (no network call):
  // enrolled or products.ccar is CCAR-F, products.ccdv is CCDV-F, both is BOTH.
  // Access decisions are untouched; this only changes the badge text.
  if (currentUser && fbAuth && fbAuth.getIdTokenResult) {
    fbAuth.getIdTokenResult(currentUser).then(function (tok) {
      const p = (tok && tok.claims && tok.claims.products) || {};
      const ccar = enrolled || p.ccar === true, ccdv = p.ccdv === true;
      const text = ccar && ccdv ? 'ENROLLED \u00B7 BOTH' : ccdv ? 'ENROLLED \u00B7 CCDV-F' : ccar ? 'ENROLLED \u00B7 CCAR-F' : 'FREE';
      const cls  = (ccar || ccdv) ? 'user-badge enrolled' : 'user-badge free';
      // Hint for the static pages' nav (nav-auth.js reads it before Firebase loads).
      try { if (ccar || ccdv) localStorage.setItem('cca_products', ccar && ccdv ? 'both' : ccdv ? 'ccdv' : 'ccar'); else localStorage.removeItem('cca_products'); } catch (e) {}
      [document.getElementById('nav-user-badge'), document.getElementById('mobile-nav-user-badge')].forEach(function (b) {
        if (b && currentUser) { b.textContent = text; b.className = cls; }
      });
    }).catch(function () {});
  }
}

// Listen for auth state changes
let sessionId = null;
let sessionUnsubscribe = null;

// Persisted per-BROWSER (localStorage), not per-tab/page-load. Without this,
// every new tab or page reload minted a fresh ID and overwrote
// `activeSession` in Firestore — so opening the verification-email link in a
// second tab (or just navigating back after clicking it) made the *original*
// tab's listener see a "new" activeSession and immediately force-sign-out
// with the "another device" alert, even though it's the same person in the
// same browser. Reusing one ID per browser means same-browser tabs/reloads
// always agree on it, while a genuinely different browser/device (its own
// localStorage) still gets its own ID and correctly trips the anti-sharing
// check below.
const SESSION_ID_KEY = 'cca_session_id';
function getOrCreateSessionId() {
  let id;
  try { id = localStorage.getItem(SESSION_ID_KEY); } catch(e) {}
  if (!id) {
    id = Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
    try { localStorage.setItem(SESSION_ID_KEY, id); } catch(e) {}
  }
  return id;
}

async function registerSession(uid) {
  // Only commit the new sessionId to the shared variable AFTER the write
  // is acknowledged by the backend. listenForSessionChanges() compares
  // incoming snapshots against `sessionId` — if we set it eagerly (before
  // the write lands), its first server snapshot can still show the OLD
  // activeSession, look like "another device" logged in, and immediately
  // sign this brand-new session back out.
  const newSessionId = getOrCreateSessionId();
  try {
    const fs = window.__fs;
    await fs.setDoc(fs.doc(db, 'users', uid), {
      activeSession: newSessionId,
      lastLoginAt: fs.serverTimestamp()
    }, { merge: true });
    sessionId = newSessionId;
  } catch(e) { console.warn('Session registration failed:', e); }
}

function listenForSessionChanges(uid) {
  // Stop any existing listener
  if (sessionUnsubscribe) { sessionUnsubscribe(); sessionUnsubscribe = null; }

  const fs = window.__fs;
  sessionUnsubscribe = fs.onSnapshot(fs.doc(db, 'users', uid), snap => {
    if (!snap.exists() || !sessionId) return;
    // Ignore cache-only events: the cached doc may have an old activeSession
    // from a previous login before our registerSession write reached the server.
    if (snap.metadata.fromCache) return;
    const data = snap.data();
    if (data.activeSession && data.activeSession !== sessionId) {
      // Another device logged in — force logout here
      sessionId = null;
      if (sessionUnsubscribe) { sessionUnsubscribe(); sessionUnsubscribe = null; }
      fbAuth.signOut(auth).then(() => {
        enrolled = false;
        updateNavUI();
        updateDashCards();
        showSection('home');
        alert('You have been logged out because your account was accessed from another device. Only one active session is allowed at a time.');
      });
    }
  });
}

function initAuthListener() {
  if (!firebaseReady) return;
  fbAuth.onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
      // Write the localStorage hint that nav-auth.js reads on static pages for
      // an instant first-paint logged-in state (zero CLS, works before Firebase
      // finishes initialising on those pages).
      try { localStorage.setItem('cca_logged_in', user.email); } catch(e) {}
      // Discard pending auth-modal flags from static-page header buttons — the
      // user is already authenticated so no login/signup modal should open.
      if (window.__pendingLogin)  window.__pendingLogin  = false;
      if (window.__pendingSignup) window.__pendingSignup = false;
      // Show the user's email in the nav immediately (enrolled badge will update below).
      updateNavUI();

      // Check enrollment — custom claims first (immune to ad blockers, and
      // crucially Auth-only: no Firestore needed). This is what lets a
      // returning enrolled user resolve to the enrolled/dashboard state
      // immediately, without waiting on the lazily-loaded Firestore bundle
      // below. Firestore is the fallback for users not yet on the new system.
      try {
        const tokenResult = await fbAuth.getIdTokenResult(user, true);
        if (tokenResult.claims.enrolled) {
          markEnrolled(user);
          updateNavUI();
          updateDashCards();
        }
      } catch(e) { console.warn('[Auth] Token refresh error:', e.message); }
      settleAuth();

      // ?claim=1 — this account may have a pending_enrollments record
      // waiting on email verification (see the capture above). Attempt it
      // automatically now that this is a fresh sign-in following the
      // verification link. Silent on failure (no pending record, still
      // unverified, network error) — the banner / "I've verified" button
      // stays the visible fallback either way.
      if (window.__pendingClaim) {
        window.__pendingClaim = false;
        if (!enrolled) {
          try { await attemptPendingClaim(user); } catch (e) {}
        }
      }

      // "Enroll Now" while signed out opens this auth modal instead of going
      // straight to Stripe (see openPaymentModal) and sets __pendingCheckout
      // so sign-in/sign-up resumes checkout automatically — the visitor
      // shouldn't have to click "Enroll Now" a second time after logging in.
      // openPaymentModal() itself handles the "already enrolled" case (goes
      // to the dashboard instead of paying again) — see there.
      // Load Firestore BEFORE resuming a pending checkout so that
      // openPaymentModal()'s attribution write (gated on window.__fs) is
      // never silently skipped. ensureFirestore() is idempotent — the
      // second call in the try-block below is a no-op once db is set.
      try { await ensureFirestore(); } catch (e) { /* non-fatal */ }

      // Check both in-memory flag and sessionStorage so the checkout intent
      // survives any same-origin reload that wiped window.__pendingCheckout.
      {
        const _hasIntent = window.__pendingCheckout ||
          (function() { try { return !!sessionStorage.getItem('cca_checkout_intent'); } catch(e) { return false; } }());
        if (_hasIntent) {
          window.__pendingCheckout = false;
          try { sessionStorage.removeItem('cca_checkout_intent'); } catch (e) {}
          openPaymentModal();
        }
      }

      // Everything below — the Firestore enrollment fallback, the pending-
      // purchase claim's analytics write, session registration/anti-sharing,
      // attempt history, etc. — needs Firestore. Load it now: this only runs
      // for a logged-in user (anonymous homepage visitors never reach this
      // branch), so Firestore (~92KB) stays un-downloaded until there's an
      // actual session to manage.
      try {
        await ensureFirestore();

        if (!enrolled) {
          try {
            // source:'server' bypasses Firestore's local cache, which can
            // return stale data (e.g. the login session-write without enrolled).
            const fs = window.__fs;
            const docSnap = await fs.getDocFromServer(fs.doc(db, 'users', user.uid));
            if (docSnap.exists() && docSnap.data().enrolled) { markEnrolled(user); }
          } catch(e) { console.warn('[Auth] Firestore read error:', e.message); }
        }
        // Last resort: maybe this person paid via Stripe BEFORE this account
        // existed (or checked out with a different email). The webhook would
        // have stashed a "pending enrollment" for that email server-side —
        // claim it now that we can prove who they are via a verified ID token.
        if (!enrolled) {
          const claim = await claimPendingEnrollment(user);
          if (claim.reason === 'unverified_email') {
            showPendingVerificationBanner(user);
          } else if (claim.enrolled) {
            showEnrollmentClaimedBanner(user);
          }
        }
        if (!sessionId) {
          await registerSession(user.uid);
        }
        // Listen for session takeover from other devices — only if this
        // session was actually registered. If registerSession's write
        // failed, sessionId is still null and a listener here would
        // compare against nothing, treating any existing activeSession as
        // "another device" and immediately signing the user back out.
        if (sessionId) {
          listenForSessionChanges(user.uid);
        }
      } catch(e) { console.warn('[Auth] Firestore unavailable:', e.message); }

      // Returning from Stripe checkout? The redirect carries "?paid=true" as
      // a UX hint only — we deliberately do NOT trust it to grant access by
      // itself (anyone could type ?paid=true into the address bar). It just
      // triggers a short poll against server-verified enrollment sources
      // (Firebase custom claims + Firestore, both written only by the Stripe
      // webhook via the Admin SDK) so a genuine purchaser sees confirmation
      // without waiting for a manual refresh.
      const params = new URLSearchParams(window.location.search);
      if (params.get('paid') === 'true') {
        window.history.replaceState({}, '', window.location.pathname);
        if (!enrolled) confirmPaymentAndUnlock(user);
      }
      // Direct-launch via ?startTest= — used by off-site CTAs (e.g. the
      // /register/ "Full 60-Question Simulation" button). startTest() is
      // already enrollment-aware: it calls openPaymentModal() for non-enrolled
      // users, so no extra guard is needed here.
      if (params.get('startTest')) {
        window.history.replaceState({}, '', window.location.pathname);
        startTest(params.get('startTest'));
      }
      // Practice Tests hub — show the dashboard (test-mode selector) directly.
      // Also reads sessionStorage so the signup-then-hub flow works: a logged-out
      // user who arrived via ?hub=practice-tests&signup=1 stores the intent there,
      // signs up, and lands here after auth with the URL already cleared.
      {
        const _hub = params.get('hub') ||
          (function(){ try { return sessionStorage.getItem('cca_hub_intent'); } catch(_){ return null; } }());
        if (_hub === 'practice-tests') {
          window.history.replaceState({}, '', '/');
          try { sessionStorage.removeItem('cca_hub_intent'); } catch(_) {}
          showSection('dashboard');
        }
      }
      // ?checkout=true — used by marketing-page CTAs on static pages that
      // can't call openPaymentModal() directly. Handles all auth states:
      // enrolled → dashboard; not-enrolled → Stripe; logged-out → auth modal
      // which sets cca_checkout_intent so signup resumes checkout.
      if (params.get('checkout') === 'true') {
        window.history.replaceState({}, '', window.location.pathname);
        openPaymentModal();
      }
    } else {
      enrolled = false;
      sessionId = null;
      settleAuth();
      // Clear the nav-auth.js hint flags so static pages revert to logged-out state.
      try { localStorage.removeItem('cca_logged_in'); localStorage.removeItem('cca_enrolled'); } catch(e) {}
      if (sessionUnsubscribe) { sessionUnsubscribe(); sessionUnsubscribe = null; }

      // Pending checkout intent — a logged-out user previously clicked a buy
      // button (openPaymentModal() set window.__pendingCheckout and wrote
      // cca_checkout_intent to sessionStorage), was shown the auth modal, and
      // is now on a page still carrying that intent. openPaymentModal() resumes
      // the checkout: once they authenticate, onAuthStateChanged fires again
      // in the `if (user)` branch above and sends them on to Stripe.
      if (window.__pendingCheckout ||
          (function() { try { return !!sessionStorage.getItem('cca_checkout_intent'); } catch(e) { return false; } }())) {
        // Clear before calling — mirrors the if(user) branch above (508-509).
        // Without this, a blocked/no-op auto-invoke below leaves the intent
        // set, and it silently re-fires openPaymentModal() on the next full
        // page reinit (any reload of any page).
        window.__pendingCheckout = false;
        try { sessionStorage.removeItem('cca_checkout_intent'); } catch (e) {}
        openPaymentModal();
      }
      // Static-page header "Log In" / "Sign Up Free" buttons route to
      // /?login=true and /?signup=true respectively. The DOMContentLoaded
      // handlers above set these flags synchronously, then we consume them
      // here once auth state is known. ?signup=true intentionally does NOT
      // set cca_checkout_intent — it must never trigger the $49 buy flow.
      if (window.__pendingLogin) {
        window.__pendingLogin = false;
        openAuthModal('login');
      }
      if (window.__pendingSignup) {
        window.__pendingSignup = false;
        openAuthModal('signup');
        // Show a "free, no payment" subtitle so this modal is visibly distinct
        // from the checkout flow (which shows the $49 purchase subtitle instead).
        const _signupSubtitle = document.getElementById('auth-modal-subtitle');
        if (_signupSubtitle) {
          _signupSubtitle.textContent = 'Create your free account — no payment required.';
          _signupSubtitle.style.display = 'block';
        }
      }

      // Anonymous visitor returning from Stripe checkout — they paid BEFORE
      // creating a site account (the webhook stashed their purchase as a
      // "pending enrollment" keyed by checkout email; see claimPendingEnrollment).
      // The "?paid=true" handling above only runs inside the `if (user)`
      // branch, so without this, an anonymous returning buyer got zero
      // acknowledgment that anything happened — the param just sat unused in
      // the URL and they'd have to independently guess "I should sign up now."
      // We can't grant access here (only a verified account can claim the
      // pending purchase), but we CAN confirm the payment landed and name the
      // single most important detail for a smooth claim: sign up with the
      // SAME email used at checkout (a mismatch is the #1 way buyers get stuck
      // with no in-app recovery path — see claimPendingEnrollment's email-keyed lookup).
      const anonParams = new URLSearchParams(window.location.search);
      if (anonParams.get('paid') === 'true') {
        window.history.replaceState({}, '', window.location.pathname);
        window.__pendingPurchaseShown = true;
        try { localStorage.setItem(PENDING_PURCHASE_KEY, '1'); } catch(e) {}
        const banner = document.getElementById('success-banner');
        if (banner) {
          banner.innerHTML = pendingPurchaseMsg();
          banner.style.display = 'block';
        }
      }
      // Logged-out user arrived via ?startTest=. startTest() is enrollment-aware:
      // a free type (quick, focused) starts for a guest exactly as the dashboard
      // card does, and a locked type (full, deep, domain-*) reaches
      // openPaymentModal() through startTest()'s own guard, so /?startTest=full
      // still goes straight to checkout. Before this, every type went to checkout
      // for a guest, which made a free-sprint deep link impossible.
      if (anonParams.get('startTest')) {
        const anonTestType = anonParams.get('startTest');
        window.history.replaceState({}, '', window.location.pathname);
        startTest(anonTestType);
      }
      // Practice Tests hub for logged-out users.
      // If 'signup' param is set (used by the Exam page "Start Practice Exam"
      // button), store the hub intent and open signup first; the logged-in
      // branch will consume the sessionStorage key after auth completes.
      // Without 'signup', show the dashboard directly — Quick Sprint is free
      // and locked cards give a natural entry point into the buy flow.
      if (anonParams.get('hub') === 'practice-tests') {
        window.history.replaceState({}, '', '/');
        if (anonParams.get('signup')) {
          try { sessionStorage.setItem('cca_hub_intent', 'practice-tests'); } catch(_) {}
          openAuthModal('signup');
        } else {
          showSection('dashboard');
        }
      }
      // ?checkout=true — logged-out visitor from a static marketing-page CTA.
      // openPaymentModal() sets cca_checkout_intent + opens auth modal so that
      // after signup the logged-in branch resumes checkout automatically → Stripe.
      if (anonParams.get('checkout') === 'true') {
        window.history.replaceState({}, '', window.location.pathname);
        openPaymentModal();
      }
    }
    // Update nav again after Firestore enrollment check completes
    updateNavUI();
    updateDashCards();
  });
}

function updateDashCards() {
  // card-deep, card-full and card-domain: fully locked unless enrolled
  // The button label follows enrollment too. index.html ships the
  // non-enrolled label ('Unlock for $49'), the state every crawler and every
  // visitor before auth resolves is in; the Start label is restored here for
  // an enrolled account. Handlers are untouched: a non-enrolled click still
  // reaches openPaymentModal() through startTest()'s guard or the card.
  const startLabels = { 'card-deep': 'Start Practice', 'card-domain': 'Start Drill', 'card-full': 'Start Exam' };
  ['card-deep','card-full','card-domain'].forEach(id => {
    const card = document.getElementById(id);
    if (!card) return;
    const badge = card.querySelector('.lock-badge');
    const btn = card.querySelector('button');
    if (enrolled) {
      card.classList.remove('locked');
      card.onclick = null; // clear any stale locked-state handler so button clicks don't bubble to showSection('home')
      if (badge) { badge.textContent = 'ENROLLED'; badge.classList.add('unlocked'); }
      if (btn) btn.textContent = startLabels[id];
    } else {
      card.classList.add('locked');
      if (badge) { badge.textContent = 'LOCKED'; badge.classList.remove('unlocked'); }
      if (btn) btn.textContent = 'Unlock for $49';
    }
  });

  // card-quick and card-focused: never locked, never given a click handler.
  // The badge reads ENROLLED once enrolled and the card's own free label
  // otherwise. The description follows through the is-enrolled class, which
  // picks one of the two spans (.when-free / .when-enrolled) in index.html --
  // both strings live there, none here.
  [['card-quick', 'FREE'], ['card-focused', '5 FREE']].forEach(([id, freeLabel]) => {
    const card = document.getElementById(id);
    if (!card) return;
    card.classList.remove('locked');
    card.onclick = null;
    card.classList.toggle('is-enrolled', !!enrolled);
    const badge = card.querySelector('.lock-badge');
    if (badge) { badge.textContent = enrolled ? 'ENROLLED' : freeLabel; badge.classList.add('unlocked'); }
  });

  // The locked overlay kills the "Start" button with pointer-events:none, but a
  // <select> is still operable by keyboard, so disable it outright. A click on a
  // disabled control fires no event, so it bubbles to the card's openPaymentModal
  // handler below -- which is the behaviour we want on a locked card anyway.
  const drillSelect = document.getElementById('domain-drill-select');
  if (drillSelect) drillSelect.disabled = !enrolled;
  renderDomainDrillPicker();

  // Make fully-locked overlays clickable → payment (Stripe, with or without login)
  document.querySelectorAll('.dash-card.locked').forEach(card => {
    card.onclick = () => openPaymentModal();
  });

  // Show the "not sure yet? take the free diagnostic" hint above the locked
  // cards for unenrolled visitors only — an enrolled user has nothing locked
  // here and doesn't need routing toward the diagnostic funnel.
  const diagHint = document.getElementById('dash-diagnostic-hint');
  if (diagHint) diagHint.style.display = enrolled ? 'none' : '';

  // Keep the purchase CTAs in sync with enrollment too — they share the same
  // `enrolled` flips as the dashboard cards, so driving them from here means
  // every code path that calls updateDashCards() (auth state changes, claim
  // confirmation, webhook polling, etc.) automatically keeps them correct.
  updatePricingCTAs();
}

// An already-enrolled visitor who lands on the hero or pricing section should
// never be invited to pay again — Stripe has no built-in duplicate-purchase
// guard, and a second charge would just create a support headache. So once
// `enrolled` is true we relabel both purchase CTAs as a single "you're in,
// go use it" link straight to the dashboard, and restore the original
// purchase copy/handler if the user is ever unenrolled (e.g. logs into a
// different, non-enrolled account in the same session).
function updatePricingCTAs() {
  const heroBtn = document.getElementById('hero-enroll-btn');
  const checkoutBtn = document.getElementById('checkout-btn');
  const goToDashboard = () => showSection('dashboard');

  // The "Already sure you want full access?" lead-in only makes sense as a
  // question aimed at someone who hasn't bought yet — paired with a button
  // that now reads "Enrolled ✓ — Go to dashboard" it's a confusing leftover.
  // Hide just that span for enrolled visitors so the demoted block quietly
  // becomes a single "go to your dashboard" link with no purchase framing.
  const heroPrompt = document.getElementById('hero-enroll-prompt');
  if (heroPrompt) heroPrompt.style.display = enrolled ? 'none' : '';
  // The hero's primary "Unlock all 400 questions: $49" button (index.html,
  // lever 1, 12 Oct 2026) shares openPaymentModal() with #hero-enroll-btn; an
  // enrolled visitor already gets "Go to dashboard" below the stats, so this
  // one is simply hidden rather than relabeled.
  const heroBuyBtn = document.getElementById('hero-buy-btn');
  if (heroBuyBtn) heroBuyBtn.style.display = enrolled ? 'none' : '';

  if (heroBtn) {
    if (enrolled) {
      heroBtn.textContent = 'Enrolled ✓ Go to dashboard';
      heroBtn.onclick = goToDashboard;
      heroBtn.classList.add('btn-enrolled');
    } else {
      heroBtn.textContent = 'Enroll Now: $49';
      heroBtn.onclick = () => openPaymentModal();
      heroBtn.classList.remove('btn-enrolled');
    }
  }
  if (checkoutBtn) {
    if (enrolled) {
      checkoutBtn.textContent = 'Enrolled ✓ Go to dashboard';
      checkoutBtn.onclick = goToDashboard;
      checkoutBtn.classList.add('btn-enrolled');
    } else {
      checkoutBtn.textContent = 'Proceed to Secure Checkout';
      checkoutBtn.onclick = () => openPaymentModal();
      checkoutBtn.classList.remove('btn-enrolled');
    }
  }
}

// ═══════════════════════════════════════
// AUTH MODAL
// ═══════════════════════════════════════
let authMode = 'login'; // 'login' or 'signup'

function openAuthModal(mode) {
  authMode = mode || 'login';
  switchAuthMode(authMode);
  document.getElementById('auth-modal').classList.add('show');
  document.getElementById('auth-error').style.display = 'none';
  // Hide the "continue to checkout" subtitle by default — openPaymentModal()
  // shows it when this modal is opened because checkout requires login.
  var subtitle = document.getElementById('auth-modal-subtitle');
  if (subtitle) subtitle.style.display = 'none';
  // Always reset to clean form state — a previous hung submission may have
  // left the loading spinner visible and the form hidden
  document.getElementById('auth-form-area').style.display = 'block';
  document.getElementById('auth-loading').style.display = 'none';
  // Also hide any leftover post-signup welcome panel from a prior session —
  // otherwise re-opening the modal to log in could briefly flash "Welcome!"
  // before the form area below takes over.
  var welcomePanel = document.getElementById('auth-welcome');
  if (welcomePanel) welcomePanel.style.display = 'none';
  // Same reason: a payment-block message left in the modal by showPaymentBlock()
  // must not sit above the login form the next time this opens.
  var blockPanel = document.getElementById('payment-block-msg');
  if (blockPanel) blockPanel.style.display = 'none';
  var submitBtn = document.getElementById('auth-submit-btn');
  if (submitBtn) submitBtn.disabled = false;
  // Clear fields
  document.getElementById('auth-email').value = '';
  document.getElementById('auth-password').value = '';
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('auth-email').focus(), 100);
}

// Which of #auth-modal's five renderers is on screen — the login/signup form,
// the loading spinner, the post-signup welcome panel, the payment-block
// message, or the error strip. Read from COMPUTED display, not inline style:
// .auth-error and .auth-loading are hidden by their class, so el.style.display
// is '' for both until something sets it. Error outranks form because the
// error strip renders above a still-visible form area and is what the visitor
// is looking at. Must be read BEFORE .show comes off.
function authModalRenderer() {
  const visible = (id) => {
    const el = document.getElementById(id);
    return !!el && getComputedStyle(el).display !== 'none';
  };
  if (visible('payment-block-msg')) return 'payment_block';
  if (visible('auth-welcome'))      return 'welcome';
  if (visible('auth-loading'))      return 'loading';
  if (visible('auth-error'))        return 'error';
  if (visible('auth-form-area'))    return 'form';
  return 'none';
}

// A checkout redirect can be in flight while the modal is open: the 1s
// begin_checkout wait inside trackCheckoutAndGo(), and before it the 4s
// /pre-checkout fetch. Dismissing "Redirecting to secure checkout…" used to
// leave both running, so a visitor who explicitly declined was still sent to
// Stripe a moment later. checkoutCancelled is the single flag every one of
// those continuations checks; openPaymentModal() clears it at the top of each
// fresh attempt, so declining one click never blocks the next.
let checkoutCancelled = false;
let _checkoutGoTimer  = null;
let _checkoutPreCtrl  = null;

function cancelPendingCheckout() {
  checkoutCancelled = true;
  if (_checkoutGoTimer !== null) { clearTimeout(_checkoutGoTimer); _checkoutGoTimer = null; }
  // Aborting on its own would be WORSE than doing nothing: the /pre-checkout
  // chain fails open, so an abort lands in its .catch() and that .catch()
  // redirects to Stripe. checkoutCancelled is what actually stops it; the
  // abort only releases the request.
  if (_checkoutPreCtrl) {
    try { _checkoutPreCtrl.abort(); } catch (e) {}
    _checkoutPreCtrl = null;
  }
}

// Re-show the shell when there is output the visitor must see. A dismissal
// does not abort an in-flight signup — the account is still created — and
// renderAuthWelcome()/showAuthError() were writing into an overlay with no
// .show, so a visitor who dismissed mid-signup succeeded and saw nothing at
// all. Re-showing follows openAuthModalLoading() and showPaymentBlock(),
// which already re-add .show, rather than inventing a second pattern.
// Suppressing the render instead would need somewhere else to put "your
// account is ready", and on /diagnostic/ there is nowhere: #success-banner
// exists in index.html only.
function ensureAuthModalVisible() {
  const modal = document.getElementById('auth-modal');
  if (!modal || modal.classList.contains('show')) return;
  modal.classList.add('show');
  document.body.style.overflow = 'hidden';
}

// method names the dismissal path for GA4 — 'close_button', 'escape' or
// 'backdrop'. Called with NO argument by the paths that close the modal as a
// step rather than a dismissal (login succeeded, already enrolled, the welcome
// panel's own buttons); those fire nothing, so the event below counts
// dismissals only. This is the baseline the backdrop-removal commit is judged
// against — nothing on any close path was instrumented before it.
function closeAuthModal(method) {
  const renderer = authModalRenderer();
  const redirectWasPending = _checkoutGoTimer !== null || _checkoutPreCtrl !== null;
  document.getElementById('auth-modal').classList.remove('show');
  document.body.style.overflow = '';
  // The user dismissed the modal without completing sign-in/sign-up — drop
  // any "resume checkout after auth" intent set by openPaymentModal(), so a
  // later, unrelated login doesn't unexpectedly redirect to Stripe.
  window.__pendingCheckout = false;
  try { sessionStorage.removeItem('cca_checkout_intent'); } catch (e) {}
  // …and stop the redirect this dismissal was declining.
  cancelPendingCheckout();
  if (method && typeof gtag !== 'undefined') {
    gtag('event', 'auth_modal_dismissed', {
      method:             method,
      renderer:           renderer,
      redirect_cancelled: redirectWasPending,
      page_path:          location.pathname,
    });
  }
}

// Backdrop click and Escape both dismiss the modal exactly like the × button
// — routed through closeAuthModal() itself so all three get the same "not
// now" cleanup (pending-checkout intent cleared, an in-flight Stripe redirect
// cancelled) with no navigation anywhere. Each passes its own method string so
// the three are separable in GA4.
(function() {
  const _authModalEl = document.getElementById('auth-modal');
  if (!_authModalEl) return; // pages that don't include the modal (e.g. /register)
  // A plain click handler also fires when the mousedown happened INSIDE .modal
  // and only the mouseup landed on the backdrop — which is exactly what
  // selecting a line of text and releasing past the edge of the panel does.
  // That is accidental dismissal happening today. Requiring both ends of the
  // gesture on the overlay itself makes the drag a no-op and leaves a genuine
  // backdrop click behaving as before. A tap fires the compatibility mouse
  // events, so touch is covered; a touch that scrolls the overlay (possible
  // since 562e9f7 made the overlay the scroll container) suppresses them,
  // which is also what we want.
  let _downOnBackdrop = false;
  _authModalEl.addEventListener('mousedown', (e) => {
    _downOnBackdrop = (e.target === _authModalEl);
  });
  _authModalEl.addEventListener('mouseup', (e) => {
    const dismiss = _downOnBackdrop && e.target === _authModalEl;
    _downOnBackdrop = false;
    if (dismiss) closeAuthModal('backdrop');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _authModalEl.classList.contains('show')) closeAuthModal('escape');
  });
})();

// Puts the auth modal into a loading state with a custom message — covers
// every async wait between a click and the next visible step (Firebase
// still loading, the post-auth checkout handoff, the Stripe redirect's
// begin_checkout wait) so it never looks like "my click did nothing."
// Opens the modal itself, so it's also safe to call as the very first
// response to a click (see buyNow() on /diagnostic/).
function openAuthModalLoading(message) {
  document.getElementById('auth-modal').classList.add('show');
  document.getElementById('auth-error').style.display = 'none';
  const subtitle = document.getElementById('auth-modal-subtitle');
  if (subtitle) subtitle.style.display = 'none';
  document.getElementById('auth-form-area').style.display = 'none';
  const welcomePanel = document.getElementById('auth-welcome');
  if (welcomePanel) welcomePanel.style.display = 'none';
  const blockPanel = document.getElementById('payment-block-msg');
  if (blockPanel) blockPanel.style.display = 'none';
  document.getElementById('auth-loading').style.display = 'block';
  const loadingText = document.getElementById('auth-loading-text');
  if (loadingText) loadingText.textContent = message;
  document.body.style.overflow = 'hidden';
}

function switchAuthMode(mode) {
  authMode = mode;
  const title = document.getElementById('auth-modal-title');
  const submitBtn = document.getElementById('auth-submit-btn');
  const toggleLogin = document.getElementById('auth-toggle-login');
  const toggleSignup = document.getElementById('auth-toggle-signup');
  const resetLink = document.getElementById('auth-reset-link');
  document.getElementById('auth-error').style.display = 'none';

  if (mode === 'signup') {
    title.textContent = 'Create Account';
    submitBtn.textContent = 'Create Account';
    toggleLogin.style.display = 'block';
    toggleSignup.style.display = 'none';
    resetLink.style.display = 'none';
  } else {
    title.textContent = 'Log In';
    submitBtn.textContent = 'Log In';
    toggleLogin.style.display = 'none';
    toggleSignup.style.display = 'block';
    resetLink.style.display = 'inline-block';
  }
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = 'block';
  // An error can land after the visitor dismissed the modal — a backdrop
  // click during an in-flight signup does not abort the request. Writing into
  // a hidden overlay showed them nothing at all; see ensureAuthModalVisible.
  ensureAuthModalVisible();
}

// Shared user/{uid} doc write for a brand-new account — both email/password
// signup and a first-time Google sign-in call this. merge:true so we never
// overwrite an existing enrolled:true; enrolled:false is never written, so
// Firestore keeps whatever value is already there (set by an admin script or
// the Stripe webhook). Auth has already succeeded by the time this is
// called, so a Firestore hiccup here (lazy bundle failing to load, or the
// write itself failing) just logs and moves on — it must not be treated as
// an auth failure.
async function writeUserDoc(user, email) {
  try {
    await ensureFirestore();
    window.__fs.setDoc(window.__fs.doc(db, 'users', user.uid), {
      email: email,
      createdAt: window.__fs.serverTimestamp()
    }, { merge: true }).catch(e => console.warn('Firestore user doc write failed:', e));
  } catch (e) { console.warn('[Auth] Firestore unavailable:', e.message); }
}

// One-tap alternative to submitAuth() for a $49 impulse buy — Google handles
// identity, so there's no email/password/confirm to type. Still produces the
// same Firebase UID that openPaymentModal() sends to Stripe as
// client_reference_id.
async function signInWithGoogle() {
  if (!firebaseReady) {
    showAuthError('Authentication is not configured yet. Please set up Firebase.');
    return;
  }

  // Capture before any await — onAuthStateChanged (triggered by signInWithPopup)
  // may fire and consume the intent before this function continues.
  const wasPendingCheckout = window.__pendingCheckout ||
    (function() { try { return !!sessionStorage.getItem('cca_checkout_intent'); } catch(e) { return false; } }());

  document.getElementById('auth-error').style.display = 'none';
  openAuthModalLoading('Signing you in…');

  try {
    const provider = new fbAuth.GoogleAuthProvider();
    const result = await fbAuth.signInWithPopup(auth, provider);
    const info = fbAuth.getAdditionalUserInfo(result);
    if (info && info.isNewUser) {
      await writeUserDoc(result.user, result.user.email);
    }

    if (wasPendingCheckout) {
      // See submitAuth — avoids racing onAuthStateChanged's
      // pendingCheckout-resume, which calls openPaymentModal().
      openAuthModalLoading('Setting up your purchase…');
    } else if (info && info.isNewUser) {
      document.getElementById('auth-loading').style.display = 'none';
      // Google-verified emails come back with email_verified already true,
      // so unlike the password-signup path, a matching pending_enrollments
      // record could claim (enrolled:true) right here rather than just
      // surfacing 'unverified_email' — markEnrolled() inside
      // claimPendingEnrollment() handles that case; renderAuthWelcome only
      // needs to branch on the still-unverified case.
      const claim = await claimPendingEnrollment(result.user);
      if (claim.reason === 'unverified_email' || claim.enrolled) {
        closeAuthModal();
      } else {
        renderAuthWelcome(false);
      }
    } else {
      closeAuthModal();
    }
  } catch(e) {
    document.getElementById('auth-form-area').style.display = 'block';
    document.getElementById('auth-loading').style.display = 'none';
    const msg = {
      'auth/popup-closed-by-user': 'Sign-in was cancelled.',
      'auth/cancelled-popup-request': 'Sign-in was cancelled.',
      'auth/popup-blocked': 'Your browser blocked the sign-in popup. Please allow popups for this site and try again.'
    }[e.code] || e.message;
    showAuthError(msg);
  }
}

async function submitAuth() {
  if (!firebaseReady) {
    showAuthError('Authentication is not configured yet. Please set up Firebase.');
    return;
  }

  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;

  if (!email || !password) { showAuthError('Please enter your email and password.'); return; }
  if (password.length < 6) { showAuthError('Password must be at least 6 characters.'); return; }

  // Capture before any await — onAuthStateChanged (triggered by the auth
  // calls below) reads and clears the checkout intent to resume checkout,
  // and its timing relative to this function's continuation isn't guaranteed.
  // Reading both the in-memory flag and sessionStorage now makes the
  // "resume checkout" branch below deterministic regardless of which fires first.
  const wasPendingCheckout = window.__pendingCheckout ||
    (function() { try { return !!sessionStorage.getItem('cca_checkout_intent'); } catch(e) { return false; } }());

  // Kick off the Firestore bundle load now, in parallel with the auth
  // round-trip below — both signup and login immediately write a
  // user/session doc to Firestore once auth succeeds (see writeUserDoc).
  ensureFirestore();

  const btn = document.getElementById('auth-submit-btn');
  const formArea = document.getElementById('auth-form-area');
  const loading = document.getElementById('auth-loading');
  const loadingText = document.getElementById('auth-loading-text');
  btn.disabled = true;
  formArea.style.display = 'none';
  loading.style.display = 'block';
  if (loadingText) loadingText.textContent = authMode === 'signup' ? 'Creating your account…' : 'Signing you in…';

  let cred; // hoisted so the welcome-panel logic below can read cred.user
  try {
    if (authMode === 'signup') {
      cred = await Promise.race([
          fbAuth.createUserWithEmailAndPassword(auth, email, password),
          new Promise((_, reject) => setTimeout(() => reject(new Error('auth/timeout')), 15000))
        ]);
      // Fire off email verification (fire-and-forget — don't block signup on
      // mail delivery). This is also what /claim-enrollment requires before
      // honoring a pending-purchase claim — it's the proof that this account
      // actually controls the inbox a Stripe payment may have been made
      // under, so a stranger's email can't be used to steal someone else's
      // already-paid enrollment.
      //
      // "Fire-and-forget" previously meant a silent console.warn on failure —
      // a buyer would just never receive the email and have no idea why, or
      // that "Resend verification email" (in the pending-purchase banner) was
      // their way out. Recording the failure here lets that banner open by
      // leading with the resend action instead of "check your inbox" for an
      // email that was never sent. See window.__verificationSendFailed below.
      // Write the hint flag immediately after credential resolution, before
      // the welcome panel appears or any navigation occurs — so if the user
      // clicks "Take the free diagnostic" (same-tab), the inline hint on
      // /diagnostic/ finds the key and shows logged-in state from first paint.
      // onAuthStateChanged also writes it, but its timing vs. the await
      // continuation is implementation-dependent; this write is guaranteed.
      try { localStorage.setItem('cca_logged_in', cred.user.email); } catch(e) {}
      // If this signup was triggered by a pending checkout (wasPendingCheckout,
      // captured above before any await), carry that intent through the
      // verification link's continueUrl too — a same-browser fresh tab has no
      // access to this tab's sessionStorage/__pendingCheckout. The
      // DOMContentLoaded ?checkout= handler (~line 164) reads it back on that
      // landing and re-arms the same flags. Built per-call (not baked into the
      // shared VERIFY_ACTION_CODE_SETTINGS constant) so the unrelated "Resend
      // verification email" button in showPendingVerificationBanner — used to
      // claim an *existing* purchase, not start a new one — stays on the plain
      // URL and never re-enters checkout.
      // Carry a claim signal through the verification link's continueUrl only
      // when THIS browser has local evidence of an unclaimed Stripe purchase
      // for a logged-out visitor (window.__pendingPurchaseShown /
      // PENDING_PURCHASE_KEY — set only by the ?paid=true anonymous-return
      // path, see the DOMContentLoaded restore block and the anonParams
      // handling in onAuthStateChanged). Narrower than "every signup": a free
      // diagnostic signup with no Stripe visit never carries this, so it
      // never causes a landing-time hit to /claim-enrollment (unrate-limited).
      // A buyer with no local trace of their purchase (different browser/
      // session) still gets served correctly — see the visibilitychange
      // listener in showPendingVerificationBanner, which keys off
      // window.__pendingVerification, not this param.
      const mayHavePendingPurchase = window.__pendingPurchaseShown ||
        (function() { try { return localStorage.getItem(PENDING_PURCHASE_KEY) === '1'; } catch(e) { return false; } }());
      const verifySettings = wasPendingCheckout
        ? Object.assign({}, VERIFY_ACTION_CODE_SETTINGS, { url: VERIFY_ACTION_CODE_SETTINGS.url + '?checkout=resume' })
        : mayHavePendingPurchase
          ? VERIFY_ACTION_CODE_SETTINGS_CLAIM
          : VERIFY_ACTION_CODE_SETTINGS;
      fbAuth.sendEmailVerification(cred.user, verifySettings).catch(e => {
        console.warn('Verification email failed:', e.message);
        window.__verificationSendFailed = true;
      });
      // Session registration (activeSession/lastLoginAt) is handled by
      // onAuthStateChanged → registerSession(), which awaits its write
      // before attaching the session-change listener. Writing our own
      // activeSession here too, un-awaited, raced with that listener and
      // could make this brand-new session look like "another device" logged
      // in, signing it right back out.
      await writeUserDoc(cred.user, email);
    } else {
      await Promise.race([
          fbAuth.signInWithEmailAndPassword(auth, email, password),
          new Promise((_, reject) => setTimeout(() => reject(new Error('auth/timeout')), 15000))
        ]);
      // Session registration (activeSession/lastLoginAt) is handled by
      // onAuthStateChanged → registerSession() — see signup branch comment.
    }

    if (wasPendingCheckout) {
      // Don't show the welcome panel (signup) or close the modal (login) —
      // either would race onAuthStateChanged's pendingCheckout-resume (see
      // initAuthListener), which calls openPaymentModal() to send this
      // visitor on to Stripe. A loading state converges cleanly whether that
      // resume fires before or after this point.
      openAuthModalLoading('Setting up your purchase…');
    } else if (authMode === 'signup') {
      // Don't silently close the modal on a brand-new, unenrolled account —
      // the visitor just handed us an email and has no idea what happens
      // next. Swap the spinner for a short welcome state that names the two
      // real next steps (enroll now, or try the free diagnostic first) so
      // "Sign Up Free" visibly leads somewhere. Either button in that panel
      // calls closeAuthModal() itself once the user picks one.
      //
      // A guest who already paid under this email has a pending_enrollments
      // record waiting — don't offer them a second $49 purchase here.
      // claimPendingEnrollment shares its in-flight call with
      // onAuthStateChanged (running concurrently on the same sign-in), so
      // this is one network round-trip either way, not two.
      loading.style.display = 'none';
      const claim = await claimPendingEnrollment(cred.user);
      if (claim.reason === 'unverified_email' || claim.enrolled) {
        closeAuthModal();
      } else {
        renderAuthWelcome(false);
      }
    } else {
      closeAuthModal();
    }
  } catch(e) {
    formArea.style.display = 'block';
    loading.style.display = 'none';
    const msg = {
      'auth/email-already-in-use': 'An account with this email already exists. Try logging in.',
      'auth/invalid-email': 'Please enter a valid email address.',
      'auth/user-not-found': 'No account found with this email. Try signing up.',
      'auth/wrong-password': 'Incorrect password. Try again or reset your password.',
      'auth/invalid-credential': 'Incorrect email or password. Try again or reset your password.',
      'auth/too-many-requests': 'Too many failed attempts. Please try again later.',
      'auth/weak-password': 'Password must be at least 6 characters.'
    }[e.code] || e.message;
    showAuthError(msg);
  }
  btn.disabled = false;
}

async function resetPassword() {
  if (!firebaseReady) { showAuthError('Authentication is not configured yet.'); return; }
  const email = document.getElementById('auth-email').value.trim();
  if (!email) { showAuthError('Enter your email address first, then click "Forgot password."'); return; }
  try {
    await fbAuth.sendPasswordResetEmail(auth, email);
    showAuthError(''); // clear error
    const el = document.getElementById('auth-error');
    el.style.display = 'block';
    el.style.background = 'rgba(74,222,128,.1)';
    el.style.borderColor = 'rgba(74,222,128,.3)';
    el.style.color = 'var(--green)';
    el.textContent = 'Password reset email sent! Check your inbox.';
  } catch(e) {
    showAuthError('Could not send reset email. Check that the email is correct.');
  }
}

function logOut() {
  if (firebaseReady) fbAuth.signOut(auth);
  currentUser = null;
  enrolled = false;
  updateNavUI();
  showSection('home');
}

// ═══════════════════════════════════════
// STRIPE PAYMENT (requires login)
// ═══════════════════════════════════════
const WEBHOOK_BASE = 'https://claude-certified-architect.onrender.com';

// ─────────────────────────────────────────────────────────────────────────
// GA4 "purchase" conversion event (plus legacy "exam_purchase") — fire
// exactly once per user, ever, the moment their enrolled status is first
// confirmed true, no matter which
// code path discovers it (webhook-synced custom claim on sign-in, the
// Firestore fallback read, a claimed pending enrollment, the post-checkout
// confirmation poll, the manual "I've verified" recheck, or the lazy
// re-check inside startTest — there are six distinct places `enrolled` can
// flip false → true).
//
// Guarded by a DURABLE, SERVER-SIDE flag — users/{uid}.examPurchaseEventSent
// — instead of an in-memory variable, because in-memory state resets on
// every reload/new tab/new device, which would re-fire the event each time
// an already-converted user returns.
//
// IMPORTANT: the flag is written ONLY after gtag confirms the "purchase" hit
// was dispatched (event_callback, with an event_timeout + setTimeout
// fallback in case the callback itself never runs) — NOT eagerly alongside
// the eligibility check. It used to be set atomically in the same Firestore
// transaction that decided to fire, before gtag('event','purchase',...) was
// even called, so a tab closed in the gap between that write and gtag.js
// flushing the dataLayer permanently lost the conversion (flag says "sent",
// GA4 never received it, nothing ever retries). Deferring the write means
// the flag and the actual GA4 hit can't diverge in that direction — worst
// case is an occasional duplicate fire from two near-simultaneous callers
// (two tabs, or two of the six paths racing) before either has written the
// flag yet, which is a minor over-count and far cheaper than a silent,
// permanent under-count.
async function maybeFireExamPurchaseEvent(user) {
  if (!user) return;
  // markEnrolled() calls this fire-and-forget (no .catch), so a rejection
  // here would be an unhandled promise rejection. Fail closed: if Firestore
  // can't load, skip this check — the durable examPurchaseEventSent flag
  // means the next markEnrolled() call (next page load/session) retries it,
  // nothing is lost.
  try {
    await ensureFirestore();
  } catch (e) {
    console.warn('[Analytics] Firestore unavailable, exam_purchase check skipped:', e.message);
    return;
  }
  const fs  = window.__fs;
  const ref = fs.doc(db, 'users', user.uid);

  let stripeSessionId = null;
  try {
    const snap = await fs.getDoc(ref);
    if (!snap.exists()) return;
    const data = snap.data();
    // Only the server-written `enrolled` flag counts as a real purchase
    // (it's set exclusively by the webhook / claim-enrollment via the
    // Admin SDK) — never report a conversion off local/optimistic state.
    if (data.enrolled !== true) return;
    if (data.examPurchaseEventSent === true) return;
    stripeSessionId = data.stripeSessionId || null;
  } catch (e) {
    console.warn('[Analytics] exam_purchase check failed:', e.message);
    return; // fail closed: better to retry next session than risk firing on stale data
  }

  if (typeof gtag === 'undefined') return;

  // Stripe's checkout session ID is a stable, globally-unique identifier for
  // the real transaction; fall back to the uid if the webhook hasn't
  // recorded one yet so transaction_id is never empty.
  const transactionId = stripeSessionId || user.uid;

  // Record the durable flag only once the "purchase" hit has actually been
  // handed off: transport_type:'beacon' lets it survive an immediate tab
  // close, event_callback fires once gtag.js dispatches it, and the
  // event_timeout/setTimeout pair (mirroring trackCheckoutAndGo's
  // begin_checkout pattern below) guarantees recordSent still runs even if
  // gtag.js itself never finishes loading.
  let recorded = false;
  const recordSent = () => {
    if (recorded) return;
    recorded = true;
    fs.setDoc(ref, { examPurchaseEventSent: true }, { merge: true })
      .catch(e => console.warn('[Analytics] failed to record examPurchaseEventSent:', e.message));
  };

  gtag('event', 'purchase', {
    currency:       'USD',
    value:          49,
    transaction_id: transactionId,
    transport_type: 'beacon',
    event_callback: recordSent,
    event_timeout:  1000,
  });
  // Also fire the legacy "exam_purchase" name alongside the GA4-standard
  // "purchase" event above — kept until any GA4 Key Event / Ads conversion
  // configured against "exam_purchase" can be confirmed unused and removed.
  gtag('event', 'exam_purchase', {
    currency:       'USD',
    value:          49,
    transaction_id: transactionId,
    transport_type: 'beacon',
  });
  setTimeout(recordSent, 1000);
}

// localStorage key set by confirmPaymentAndUnlock when a post-checkout poll
// never confirms enrollment — persisted (not just in-memory) so a page
// reload doesn't silently drop the "don't pay again" warning and re-enable
// the checkout CTA. Cleared again the moment enrollment is ever confirmed,
// by markEnrolled below.
const PAYMENT_NEEDS_REVIEW_KEY = 'cca_payment_needs_review';
const PENDING_PURCHASE_KEY = 'cca_pending_purchase';

function paymentDismissBtn() {
  return "<button onclick=\"document.getElementById('success-banner').style.display='none'\" style=\"margin-left:16px;color:var(--green);text-decoration:underline;font-size:.85rem;min-height:44px\">Dismiss</button>";
}

// #success-banner exists in index.html only. /diagnostic/ loads app.js but has
// no such element, so every `if (banner)` guard in this file silently no-ops
// there — which is the page the buy button lives on and the page view_offer
// fires from. This returns something to render payment-block copy into: the
// banner where there is one, otherwise a panel inside the auth modal, which was
// ported onto /diagnostic/ verbatim (same ids, same styling, its own close
// button). Nothing is added to either HTML file — the panel is created here on
// first use and reused after that.
function paymentBlockHost() {
  const banner = document.getElementById('success-banner');
  if (banner) return banner;
  const modal = document.getElementById('auth-modal');
  const shell = modal && modal.querySelector('.modal');
  if (!shell) return null;
  let panel = document.getElementById('payment-block-msg');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'payment-block-msg';
    panel.style.cssText = 'display:none;font-size:.9rem;line-height:1.6;color:var(--text2)';
    shell.appendChild(panel);
  }
  return panel;
}

// Reveal whatever paymentBlockHost() handed back. For #success-banner this is
// exactly what every existing call site already does, so behaviour on / is
// unchanged. For the modal panel it also clears the form, spinner and welcome
// panels so the message is the only thing showing, and opens the modal.
function showPaymentBlock(host, title) {
  if (!host) return;
  if (host.id === 'success-banner') { host.style.display = 'block'; return; }
  ['auth-form-area', 'auth-loading', 'auth-welcome', 'auth-error', 'auth-modal-subtitle'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const titleEl = document.getElementById('auth-modal-title');
  if (titleEl && title) titleEl.textContent = title;
  host.style.display = 'block';
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.add('show');
  document.body.style.overflow = 'hidden';
}

// Shown once enrollment is confirmed — see markEnrolled. Extracted because it
// was duplicated in both the manual-review and pending-purchase branches there.
function paymentSuccessBody() {
  return 'Payment successful! Welcome to the Claude Certified Architect course.';
}

function paymentSuccessMsg() {
  return paymentSuccessBody() + paymentDismissBtn();
}

// Shown to a guest (no account) returning from Stripe checkout — see the
// anonymous-branch ?paid=true handling and PENDING_PURCHASE_KEY. Extracted so
// the boot-time restore and the original guest branch render byte-identical
// markup instead of duplicating the string.
function pendingPurchaseMsg() {
  return 'Payment received! Create a free account using <strong>the same email you checked out with</strong> to unlock your purchase. ' +
    '<button onclick="openAuthModal(\'signup\')" style="margin-left:8px;color:var(--green);text-decoration:underline;font-size:.85rem;min-height:44px">Create my account</button>' +
    paymentDismissBtn();
}

// Body split out from the message so the modal fallback can render the same
// copy without paymentDismissBtn(), whose onclick hardcodes #success-banner and
// would throw on a page that has none. / renders byte-identical markup.
function unmatchedPaymentBody() {
  return "We couldn't automatically match this payment to your account. <strong>Please don't pay again</strong> — " +
    "email <a href=\"mailto:support@claudecertifiedarchitects.com\" style=\"color:var(--green);text-decoration:underline\">support@claudecertifiedarchitects.com</a> " +
    "with your payment receipt and we'll sort it out manually.";
}

function unmatchedPaymentMsg() {
  return unmatchedPaymentBody() + paymentDismissBtn();
}

// Shown when the post-checkout poll times out before enrollment confirms —
// distinct from unmatchedPaymentMsg because here we KNOW the payment was
// received; activation is just slower than the poll window (Render cold start).
// Softer tone: reassure, don't alarm. The localStorage flag set by
// flagPaymentNeedsReview still prevents a second checkout attempt.
// Body/Msg split on the same pattern as unmatchedPaymentBody/Msg: the modal
// host on /diagnostic/ cannot carry paymentDismissBtn(), whose onclick
// hardcodes #success-banner.
function paymentActivationTimeoutBody() {
  return "<strong>Your payment was received ✓</strong> — account activation is taking a little longer than usual. " +
    "Please <button onclick=\"window.location.reload()\" style=\"color:var(--green);text-decoration:underline;background:none;border:none;cursor:pointer;font-size:inherit;padding:0;min-height:44px\">reload this page</button> " +
    "in a minute or two. If you still don’t have access after 5 minutes, email " +
    "<a href=\"mailto:support@claudecertifiedarchitects.com\" style=\"color:var(--green);text-decoration:underline\">support@claudecertifiedarchitects.com</a> " +
    "with your receipt and we’ll activate manually.";
}

function paymentActivationTimeoutMsg() {
  return paymentActivationTimeoutBody() + paymentDismissBtn();
}

// Local-state setter for `enrolled` that funnels through the guarded,
// fire-once analytics check above. Every place that discovers enrollment
// calls this instead of assigning `enrolled = true` directly, so the
// conversion event lives in exactly one place rather than being scattered
// (and duplicated, or missed) across each detection path.
function markEnrolled(user) {
  enrolled = true;
  // Persist enrollment state so nav-auth.js can show it on static pages
  // without a Firestore round-trip.
  try { localStorage.setItem('cca_enrolled', 'true'); } catch(e) {}
  // Not nested in the manual-review branch below — a guest who was never
  // flagged for manual review is the normal case, and the visibilitychange
  // listener (see attemptPendingClaim) needs this cleared the moment
  // enrollment is actually confirmed, or it keeps re-attempting the claim
  // forever.
  window.__pendingVerification = false;
  let bannerRewritten = false;
  if (window.__paymentNeedsManualReview) {
    window.__paymentNeedsManualReview = false;
    try { localStorage.removeItem(PAYMENT_NEEDS_REVIEW_KEY); } catch(e) {}
    const banner = document.getElementById('success-banner');
    if (banner) {
      banner.innerHTML = paymentSuccessMsg();
      banner.style.display = 'block';
    }
    bannerRewritten = true;
  }
  // Not nested in the manual-review branch above: a guest who was NEVER
  // flagged for manual review is the normal case, and may still have the
  // "create an account" banner up (or persisted in localStorage) that needs
  // to flip to the success message now that enrollment is confirmed. The
  // bannerRewritten guard stops this from overwriting the manual-review
  // branch's write if both flags were somehow set in the same call — the key
  // and flag still clear either way.
  try { localStorage.removeItem(PENDING_PURCHASE_KEY); } catch(e) {}
  if (window.__pendingPurchaseShown) {
    window.__pendingPurchaseShown = false;
    if (!bannerRewritten) {
      const banner = document.getElementById('success-banner');
      if (banner) {
        banner.innerHTML = paymentSuccessMsg();
        banner.style.display = 'block';
      }
    }
  }
  // Refresh nav badge + dashboard cards here so enrollment always renders
  // immediately, regardless of which call site reached us. Two call sites
  // previously left the UI stale after granting access: the Firestore
  // fallback (docSnap.data().enrolled, ~line 579) and the webhook-claim path
  // inside claimPendingEnrollment() (~line 1449) — neither was followed by a
  // refresh, so an enrolled user could sit on a page still showing FREE/
  // LOCKED until something else happened to re-render. Both functions are
  // assignment-only and idempotent (see updateNavUI/updateDashCards), so
  // calling them here is safe even for callers that already refresh
  // themselves right after markEnrolled() — the external calls at
  // onAuthStateChanged (521-523), attemptPendingClaim (1516-1517),
  // confirmPaymentAndUnlock (1748-1749) and startTest (4126-4127) become
  // redundant but harmless, and are left in place rather than edited.
  updateNavUI();
  updateDashCards();
  maybeFireExamPurchaseEvent(user);
  try { activeBank().catch(function () {}); } catch (e) {}   // prefetch of the paid bank, never awaited here (see BANK SOURCE)
}

// Ask the webhook server whether a "pending enrollment" exists for the
// current user's verified email. This covers the case where someone paid via
// Stripe BEFORE creating a site account (or checked out with a different
// email than the one they later sign up / log in with): the webhook couldn't
// find a matching Firebase user at payment time, so it stashed the purchase
// server-side. When the matching account shows up, we claim it here. Returns
// true if enrollment was applied.
//
// De-duped against concurrent callers: onAuthStateChanged calls this on every
// sign-in, and the post-signup welcome-panel logic (submitAuth /
// signInWithGoogle) now also calls it right after account creation — both can
// fire within the same tick. Sharing one in-flight promise means concurrent
// callers await the same single /claim-enrollment round-trip and see the
// same resolved result, instead of racing two requests that could each pass
// the server's pendingDoc.exists() check before either deletes it (double
// claim + double GA4 purchase fire).
let __claimPendingPromise = null;
async function claimPendingEnrollment(user) {
  if (!user) return { enrolled: false, reason: null };
  if (__claimPendingPromise) return __claimPendingPromise;
  __claimPendingPromise = (async () => {
    try {
      // Force-refresh: the SDK's cached ID token is a snapshot from whenever
      // it was last minted and does NOT update itself when emailVerified
      // flips server-side (e.g. the user clicks the verification link in
      // another tab). Without `true` here, a just-verified user would keep
      // sending a stale token whose email_verified claim still reads false,
      // and the server-side gate in /claim-enrollment would keep rejecting
      // a perfectly legitimate claim.
      const token = await fbAuth.getIdToken(user, true);
      const resp  = await fetch(WEBHOOK_BASE + '/claim-enrollment', {
        method:  'POST',
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!resp.ok) return { enrolled: false, reason: null };
      const data = await resp.json();
      if (data.enrolled) {
        await fbAuth.getIdTokenResult(user, true); // refresh local claim cache
        markEnrolled(user);
        return { enrolled: true, reason: null };
      }
      // data.reason surfaces server-side gates, e.g. 'unverified_email' — a
      // pending purchase exists for this address, but we won't hand it over
      // until the account proves it controls that inbox (see /claim-enrollment).
      return { enrolled: false, reason: data.reason || null };
    } catch (e) {
      console.warn('[Enrollment] claim check failed:', e.message);
      return { enrolled: false, reason: null };
    }
  })();
  try {
    return await __claimPendingPromise;
  } finally {
    __claimPendingPromise = null;
  }
}

// Toggles the post-signup welcome panel (#auth-welcome, static markup in
// index.html / diagnostic/index.html) between its default "buy now" state
// and a "you already have a pending purchase" state. Non-destructive (hides/
// shows rather than rewriting the button away) so it's safe to call more
// than once. One JS-side source of truth means neither HTML file needs a
// second static block for the pending-purchase case.
function renderAuthWelcome(pendingUnverified) {
  const panel = document.getElementById('auth-welcome');
  if (!panel) return;
  const buyBtn = panel.querySelector('.btn-primary');
  let pendingMsg = document.getElementById('auth-welcome-pending-msg');
  if (pendingUnverified) {
    if (buyBtn) buyBtn.style.display = 'none';
    if (!pendingMsg) {
      pendingMsg = document.createElement('p');
      pendingMsg.id = 'auth-welcome-pending-msg';
      pendingMsg.style.cssText = 'color:var(--text2);font-size:.9rem;margin:0 0 10px;line-height:1.5';
      if (buyBtn) buyBtn.insertAdjacentElement('beforebegin', pendingMsg);
    }
    pendingMsg.textContent = "We found a pending $49 purchase for this email — verify your address (check your inbox) to unlock it. No need to pay again.";
    pendingMsg.style.display = 'block';
  } else {
    if (buyBtn) buyBtn.style.display = '';
    if (pendingMsg) pendingMsg.style.display = 'none';
    // Third state, additive: the buy button above stays visible. Restored
    // 16 Sep 2026 from ce058a2, which 94dedc5 removed after three same-address
    // false positives in twelve hours from rendering to every new signup. Now
    // gated on local evidence of a Stripe return, so a signup that never
    // visited checkout never sees it. Row 301's equality check lives in the
    // route (scripts/stripe-webhook.js, /link-purchase-request).
    if (hasLocalPurchaseEvidence()) renderAlreadyPaidPrompt(panel, buyBtn);
  }
  panel.style.display = 'block';
  // The signup that produced this panel was not aborted by a dismissal, so
  // the account exists whether or not the overlay is still showing. Bring it
  // back rather than telling a brand-new customer nothing; see
  // ensureAuthModalVisible.
  ensureAuthModalVisible();
}

// Local evidence that THIS browser returned from Stripe checkout without an
// account: window.__pendingPurchaseShown and PENDING_PURCHASE_KEY are set only
// by the anonymous ?paid=true return (see the DOMContentLoaded restore block
// and the anonParams handling in onAuthStateChanged) and cleared only by
// markEnrolled(). The signup path already reads the same two sources to pick
// the verification continueUrl. A free signup with no Stripe visit has
// neither, and that population produced every one of the three false
// positives that led to 94dedc5.
function hasLocalPurchaseEvidence() {
  if (window.__pendingPurchaseShown) return true;
  try { return localStorage.getItem(PENDING_PURCHASE_KEY) === '1'; } catch (e) { return false; }
}

// The third state for the welcome panel. The two branches in renderAuthWelcome
// cover "we found your purchase" and "you are new", and the guest who paid
// under one address and then signed in under another falls between them: no
// pending_enrollments record matches the token's email, so they are handed the
// $49 button with nothing on screen acknowledging the charge they already made.
// Additive: the button stays where it was. Grants nothing: it collects one
// string and hands it to a human, and the copy says so.
//
// Built here rather than in markup because #auth-welcome is static in two files
// (index.html, diagnostic/index.html) and one JS source keeps them from
// drifting. No paymentBlockHost() needed: unlike #success-banner, #auth-welcome
// exists in both files, so this renders on /diagnostic/ unchanged.
function renderAlreadyPaidPrompt(panel, buyBtn) {
  if (document.getElementById('auth-welcome-paid-prompt')) return;

  const wrap = document.createElement('div');
  wrap.id = 'auth-welcome-paid-prompt';
  wrap.className = 'form-group';
  wrap.style.cssText = 'margin:0 0 14px;text-align:left';
  wrap.innerHTML =
    '<p style="color:var(--text2);font-size:.85rem;line-height:1.5;margin:0 0 8px">' +
      '<strong>Already paid?</strong> If you checked out under a different email address, tell us which one. ' +
      'We compare it with the payment record and email you at both addresses. ' +
      'Access is not switched on automatically. You can also email ' +
      '<a href="mailto:support@claudecertifiedarchitects.com" style="color:var(--green);text-decoration:underline">' +
      'support@claudecertifiedarchitects.com</a> directly.' +
    '</p>' +
    '<div style="display:flex;gap:8px;align-items:stretch">' +
      '<input id="auth-welcome-paid-email" type="email" autocomplete="email" ' +
        'placeholder="Email used at checkout" aria-label="Email address used at checkout" ' +
        'style="flex:1;min-width:0;font-size:.85rem;min-height:44px">' +
      '<button type="button" id="auth-welcome-paid-btn" class="btn-secondary" ' +
        'style="padding:0 14px;font-size:.85rem;min-height:44px;white-space:nowrap">Send</button>' +
    '</div>' +
    '<p id="auth-welcome-paid-status" role="status" aria-live="polite" ' +
      'style="color:var(--text2);font-size:.8rem;line-height:1.5;margin:8px 0 0;display:none"></p>';

  if (buyBtn) buyBtn.insertAdjacentElement('beforebegin', wrap);
  else panel.appendChild(wrap);

  document.getElementById('auth-welcome-paid-btn')
    .addEventListener('click', submitPurchaseLinkRequest);

  // The denominator: new signups who see the prompt at all, against which
  // purchase_link_requested is the hit rate. Since the render is gated on local
  // purchase evidence, this now counts signups that returned from Stripe.
  if (typeof gtag !== 'undefined') {
    gtag('event', 'already_paid_prompt_shown', { page_path: location.pathname });
  }
}

// Posts the checkout address the visitor names to /link-purchase-request. That
// endpoint writes a record and alerts a human unless the named address equals
// the account address (row 301's equality check). It does not enrol anyone, and
// nothing here should ever be changed to expect that it might.
async function submitPurchaseLinkRequest() {
  const input  = document.getElementById('auth-welcome-paid-email');
  const btn    = document.getElementById('auth-welcome-paid-btn');
  const status = document.getElementById('auth-welcome-paid-status');
  if (!input || !status) return;

  const show = function(msg) { status.textContent = msg; status.style.display = 'block'; };
  const value = (input.value || '').trim();

  if (!value || value.indexOf('@') < 1) {
    show('Please enter the email address you used at checkout.');
    input.focus();
    return;
  }
  if (!currentUser) {
    show('Please sign in first, then tell us which address you used.');
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
  try {
    const token = await fbAuth.getIdToken(currentUser);
    const resp  = await fetch(WEBHOOK_BASE + '/link-purchase-request', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body:    JSON.stringify({ checkoutEmail: value })
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);

    input.parentElement.style.display = 'none';
    show('Thanks. We have both addresses. We will check the payment record and email you. ' +
         'Please do not pay again in the meantime.');
    if (typeof gtag !== 'undefined') {
      gtag('event', 'purchase_link_requested', { page_path: location.pathname });
    }
  } catch (e) {
    // Never dead-end someone who has already paid once. A cold Render dyno or a
    // dropped connection must not leave them staring at the $49 button with the
    // impression that telling us failed, so this falls back to the address in
    // the copy above rather than reporting a bare error.
    console.warn('[link-request] submit failed:', e.message);
    show('We could not send that just now. Please email ' +
         'support@claudecertifiedarchitects.com with both email addresses. Please do not pay again.');
    if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
  }
}

// Extracted from unlock-now-btn's click handler below. Also used by the
// ?claim=1 landing path (onAuthStateChanged) and the visibilitychange
// listener below so all three trigger the identical unlock sequence.
// opts.navigate (default true) lets the caller skip showSection('dashboard')
// — the visibilitychange listener passes navigate:false since it can fire
// while the user is mid-read on a different section; the button and the
// ?claim=1 landing both want the original unconditional-navigate behavior
// and pass nothing. Deliberately does NOT touch button-specific UI (disabled
// state, textContent, statusEl) — those stay in the click handler, the only
// caller that renders a status message on failure. fbAuth.reload/getIdToken
// CAN throw (network failure) and are left uncaught here, same as before
// this was extracted — callers that must stay silent on failure (?claim=1
// landing, visibilitychange) wrap this call in their own try/catch.
async function attemptPendingClaim(user, opts) {
  const navigate = !opts || opts.navigate !== false;
  await fbAuth.reload(user);
  await fbAuth.getIdToken(user, true);
  const claim = await claimPendingEnrollment(user);
  if (claim.enrolled) {
    markEnrolled(user);
    updateNavUI();
    updateDashCards();
    if (navigate) showSection('dashboard');
    // Host rather than #success-banner: this is the success end of the
    // pending-verification flow, and on /diagnostic/ that flow now runs in the
    // modal (see showPendingVerificationBanner). Without this the unlock button
    // there would confirm nothing on the one page it was just made to work on.
    const host = paymentBlockHost();
    if (host) {
      host.innerHTML = host.id === 'success-banner' ? paymentSuccessMsg() : paymentSuccessBody();
      showPaymentBlock(host, 'You are enrolled');
    }
  }
  return claim;
}

// Shown when a pending Stripe purchase exists for this account's email but
// the account hasn't verified ownership of that inbox yet. This is the
// user-facing side of the email_verified gate in /claim-enrollment: without
// it, legitimate pre-signup purchasers would see their claim silently fail
// and have no idea why or what to do about it.
function showPendingVerificationBanner(user) {
  if (!user) return;
  // Was `const banner = ...; if (!banner || !user) return;`. #success-banner
  // exists in index.html only, so on /diagnostic/ this returned immediately and
  // /pre-checkout's pending_purchase exit rendered nothing at all. The button
  // wiring below looks its controls up by id, so it runs unchanged in either
  // host. INTENTIONAL BEHAVIOUR CHANGE: __pendingVerification is now set on the
  // fallback path too, which arms the visibilitychange auto-claim listener for
  // /diagnostic/ buyers — without it someone who verifies in another tab never
  // unlocks, which is a worse outcome than the dead button.
  const host = paymentBlockHost();
  if (!host) return;
  const onBanner = host.id === 'success-banner';
  window.__pendingVerification = true;
  const email = user.email || 'your email address';
  const btn = "style=\"margin-left:8px;color:var(--green);text-decoration:underline;font-size:.85rem;min-height:44px\"";
  // Dismiss only in the banner: the modal has its own close button, and this
  // onclick hardcodes #success-banner.
  const dismissBtn = onBanner
    ? "<button onclick=\"document.getElementById('success-banner').style.display='none'\" style=\"margin-left:16px;color:var(--green);text-decoration:underline;font-size:.85rem;min-height:44px\">Dismiss</button>"
    : '';
  // If the original sendEmailVerification() call (fired at signup) failed,
  // telling this person to "click the link in the email" sends them to wait
  // on a message that was never sent. Lead with the resend action instead so
  // there's an actual path forward — see window.__verificationSendFailed.
  const sendFailed = window.__verificationSendFailed === true;
  const introMsg = sendFailed
    ? 'We found a pending purchase for <strong>' + email + '</strong>, but we weren&rsquo;t able to send the verification email automatically. ' +
      'Click "Resend verification email" below, then open the link in that email and hit "I&rsquo;ve verified" — no need to reload the page. ' +
      'Already verified? Just log in again from any browser or device — it&rsquo;ll unlock automatically.'
    : 'We found a pending purchase for <strong>' + email + '</strong> — verify your email address to unlock it. ' +
      'Click the link in the verification email, then hit "I&rsquo;ve verified" below — no need to reload the page. ' +
      'Already verified? Just log in again from any browser or device — it&rsquo;ll unlock automatically.';
  host.innerHTML =
    introMsg +
    ' <button id="unlock-now-btn" ' + btn + '>I&rsquo;ve verified &mdash; unlock now</button>' +
    ' <button id="resend-verify-btn" ' + btn + '>Resend verification email</button>' +
    ' <span id="verify-status-msg" style="display:block;margin-top:6px;font-size:.85rem;opacity:.85"></span>' +
    dismissBtn;
  showPaymentBlock(host, 'Verify your email to unlock');

  const statusEl  = document.getElementById('verify-status-msg');
  const unlockBtn = document.getElementById('unlock-now-btn');
  const resendBtn = document.getElementById('resend-verify-btn');

  // "I've verified — unlock now": the user's local `user` object is a
  // snapshot from sign-in time and never updates itself when emailVerified
  // flips server-side after they click the link in another tab. Without an
  // explicit recheck path, they'd be stuck staring at this banner until they
  // happen to reload the page (which re-fires onAuthStateChanged → forces a
  // token refresh) or up to ~an hour passes and the SDK auto-refreshes the
  // token on its own. This button does that recheck on demand:
  //   1. user.reload()      — re-fetches the account record from Firebase
  //                            Auth, picking up the new emailVerified value
  //   2. getIdToken(true)   — mints a fresh ID token carrying that value
  //   3. claimPendingEnrollment(user) — retries the claim with that token
  if (unlockBtn) {
    unlockBtn.onclick = async () => {
      const original = unlockBtn.textContent;
      unlockBtn.disabled = true;
      unlockBtn.textContent = 'Checking…';
      if (statusEl) statusEl.textContent = '';
      try {
        const claim = await attemptPendingClaim(user);
        if (claim.enrolled) {
          return;
        }
        if (statusEl) {
          statusEl.textContent = (claim.reason === 'unverified_email')
            ? "Still showing as unverified — make sure you clicked the link in the email (check spam too), then try again."
            : "No pending purchase matches " + (user.email || 'this account') + ". This usually means you checked out with a " +
              "different email address. Try logging out and creating (or logging into) an account using the exact email " +
              "address you entered at Stripe checkout — that's the email your purchase is linked to. Still stuck? Email " +
              "support@claudecertifiedarchitects.com with your payment receipt and we'll sort it out manually.";
        }
      } catch (e) {
        console.warn('[Enrollment] manual unlock check failed:', e.message);
        if (statusEl) statusEl.textContent = 'Something went wrong checking your status — please try again in a moment.';
      } finally {
        if (unlockBtn.isConnected) {
          unlockBtn.disabled = false;
          unlockBtn.textContent = original;
        }
      }
    };
  }

  if (resendBtn) {
    resendBtn.onclick = () => {
      resendBtn.disabled = true;
      resendBtn.textContent = 'Sending…';
      fbAuth.sendEmailVerification(user, VERIFY_ACTION_CODE_SETTINGS_CLAIM)
        .then(() => {
          window.__verificationSendFailed = false;
          resendBtn.textContent = 'Sent — check your inbox';
        })
        .catch(e => {
          console.warn('[Enrollment] resend verification failed:', e.message);
          window.__verificationSendFailed = true;
          resendBtn.disabled = false;
          resendBtn.textContent = 'Resend verification email';
          if (statusEl) statusEl.textContent = "That didn't go through — please wait a moment and try again, or check that " + (user.email || 'your email address') + " is correct.";
        });
    };
  }
}

// The verification link opens the OS default browser, which may not be the
// browser/tab holding this session (observed live). The ?claim=1 landing
// path above only covers coming back on the same tab; this covers verifying
// in a different tab of the same browser and switching back to this one.
// Debounced with a single in-flight boolean — no retry loop. Silent on
// failure, same as the ?claim=1 path: the banner / button stays the visible
// fallback. navigate:false — this can fire while the user is mid-read on a
// different section; only the button and the ?claim=1 landing jump to the
// dashboard.
let _pendingClaimAttemptInFlight = false;
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (!window.__pendingVerification) return;
  if (_pendingClaimAttemptInFlight) return;
  if (!currentUser) return;
  _pendingClaimAttemptInFlight = true;
  try {
    await attemptPendingClaim(currentUser, { navigate: false });
  } catch (e) {
  } finally {
    _pendingClaimAttemptInFlight = false;
  }
});

// Shown when claimPendingEnrollment() finds and applies a pending purchase
// during a plain sign-in — the cross-browser/new-device case where the buyer
// verified their email in one browser and is now logging in fresh in
// another. Previously silent: markEnrolled() only touches the banner for the
// unrelated __paymentNeedsManualReview case, so this was the one path with
// no on-screen confirmation at all. Only reached from the `if (!enrolled)`
// block in onAuthStateChanged, which is itself skipped once custom claims or
// the Firestore doc already show the user enrolled — so this fires on the
// transition only, never on a later page load by an already-enrolled user.
function showEnrollmentClaimedBanner(user) {
  const banner = document.getElementById('success-banner');
  if (!banner) return;
  banner.innerHTML = "Your purchase is confirmed — you're enrolled. Full access is ready below." + paymentDismissBtn();
  banner.style.display = 'block';
}

// Poll server-verified enrollment sources for a short window after returning
// from Stripe checkout. We never grant access locally based on the URL alone
// — every source checked here (custom claims, Firestore "enrolled" field via
// source:'server', and the claim-enrollment endpoint) is written exclusively
// by the webhook's Admin SDK, which only runs after Stripe confirms payment.
// This just closes the gap between "Stripe redirected me back" and "the
// webhook (possibly cold-starting on Render's free tier) has finished."
//
// Now that checkout requires login and carries client_reference_id (see
// openPaymentModal / the webhook), this poll should basically always
// succeed within the window — a timeout here means something went wrong
// server-side (e.g. the webhook never fired), not a typo'd email. If the
// window still expires without confirmation, don't tell the user to "refresh
// shortly" (which just invites a second $49 charge); flag the payment for
// manual support follow-up instead — see unmatchedPaymentMsg /
// PAYMENT_NEEDS_REVIEW_KEY and the gate in openPaymentModal.
let _confirmingPayment = false;
async function confirmPaymentAndUnlock(user) {
  if (_confirmingPayment || !user) return;
  _confirmingPayment = true;

  // May be null: #success-banner exists in index.html only, and this function
  // runs on any page loading app.js that sees ?paid=true — /diagnostic/
  // included. Every use below is guarded, and flagPaymentNeedsReview()
  // tolerates null.
  const banner     = document.getElementById('success-banner');
  const dismissBtn = paymentDismissBtn();
  // Cleared in finally whether the poll succeeds, times out, or throws.
  let midwayUpdate = null;

  try {
    await ensureFirestore();

    if (banner) {
      banner.innerHTML = 'Payment received — activating your account&hellip; this can take up to 3 minutes on first access.' + dismissBtn;
      banner.style.display = 'block';
    }

    // 180 s covers a Render cold start (~30–60 s boot) plus full webhook
    // processing time. Median observed delay is ~72 s; worst case ~300 s on
    // a very cold dyno. With an always-on instance this window will almost
    // never be needed — the poll will confirm in the first 1–2 iterations.
    const deadline = Date.now() + 180000;
    let confirmed  = false;

    // At the old 75 s threshold, swap to a reassuring mid-wait message so
    // users who see the spinner past one minute don't think something failed.
    midwayUpdate = setTimeout(() => {
      if (banner && !confirmed && banner.style.display !== 'none') {
        banner.innerHTML = 'Still activating — almost there&hellip; (server may be warming up)' + dismissBtn;
      }
    }, 80000);

    while (!confirmed && Date.now() < deadline) {
      try {
        const tok = await fbAuth.getIdTokenResult(user, true);
        // B2: a CCAR-F grant may arrive as products.ccar as well as enrolled.
        if (tok.claims.enrolled || (tok.claims.products && tok.claims.products.ccar === true)) confirmed = true;
      } catch (e) {}

      if (!confirmed) {
        try {
          const fs = window.__fs;
          const docSnap = await fs.getDocFromServer(fs.doc(db, 'users', user.uid));
          if (docSnap.exists() && docSnap.data().enrolled) confirmed = true;
        } catch (e) {}
      }

      if (!confirmed) {
        const claim = await claimPendingEnrollment(user);
        if (claim.enrolled) {
          confirmed = true;
        } else if (claim.reason === 'unverified_email') {
          // No amount of polling fixes this — the account must verify its
          // email before the server will release the pending enrollment.
          // Stop spinning and hand the user something actionable instead of
          // a three-minute "still confirming…" message that will never resolve.
          showPendingVerificationBanner(user);
          return;
        }
      }
      if (!confirmed) await new Promise(r => setTimeout(r, 5000));
    }

    if (confirmed) {
      // markEnrolled() also (idempotently, durably-guarded) fires the
      // one-time "exam_purchase" conversion event — see maybeFireExamPurchaseEvent.
      markEnrolled(user);
      if (banner) banner.innerHTML = 'Payment successful! Welcome to the Claude Certified Architect course.' + dismissBtn;
      updateNavUI();
      updateDashCards();
      showSection('dashboard');
    } else {
      // Payment is confirmed in Stripe — enrollment is just taking longer
      // than the poll window. Use a soft message (payment received, reload
      // soon) rather than the alarming "couldn't match" copy. The localStorage
      // flag still prevents the user from accidentally double-purchasing.
      flagPaymentNeedsReview(banner, paymentActivationTimeoutMsg());
    }
  } catch (e) {
    // Covers ensureFirestore() failing to load (e.g. a CDN blip right when
    // the user lands back from Stripe) as well as any other unexpected error.
    // Use the full unmatchedPaymentMsg here — we genuinely don't know what
    // happened, so telling them to contact support is the right call.
    // The finally block resets the guard so onAuthStateChanged can retry.
    console.warn('[Payment] confirmPaymentAndUnlock failed:', e.message);
    flagPaymentNeedsReview(banner);
  } finally {
    if (midwayUpdate !== null) clearTimeout(midwayUpdate);
    _confirmingPayment = false;
  }
}

// Persist "this browser's post-checkout payment never got matched to an
// account" so a reload doesn't drop the warning (see PAYMENT_NEEDS_REVIEW_KEY)
// and route any future checkout-CTA click back to this banner instead of
// Stripe (see openPaymentModal).
function flagPaymentNeedsReview(banner, msg) {
  window.__paymentNeedsManualReview = true;
  try { localStorage.setItem(PAYMENT_NEEDS_REVIEW_KEY, '1'); } catch(e) {}
  // banner is null on any page without #success-banner. Both call sites sit in
  // confirmPaymentAndUnlock's catch block, so the throw was unhandled and took
  // the rest of that handler with it — after the flag and the localStorage
  // write above had already landed. That silently and permanently gated the
  // browser on the one page where the gate then shows nothing.
  if (!banner) return;
  banner.innerHTML = msg !== undefined ? msg : unmatchedPaymentMsg();
  banner.style.display = 'block';
}

// Fire a GA4 begin_checkout event before navigating to Stripe. gtag() queues
// into dataLayer even before gtag.js has loaded, but a queued hit can be lost
// if the page unloads first — so we wait briefly for event_callback (or a 1s
// timeout) before navigating.
//
// checkoutEventSent guards against firing this twice for one checkout intent
// (e.g. openPaymentModal() runs again via onAuthStateChanged's
// pendingCheckout-resume right after a logged-out buyer authenticates) —
// without it, GA4 would log two begin_checkout events for a single click,
// making the funnel's drop-off numbers look better than reality.
let checkoutEventSent = false;

// stripe_arrived: fires on pagehide if a Stripe redirect was initiated but
// the tab is being torn down before we can otherwise confirm the browser
// actually left for Stripe (ad blocker, dead network, backgrounded tab).
// Re-armed per redirect attempt inside go(). stripeRedirectWasGuest is
// captured there too, not read fresh in the handler, because
// openPaymentModal() re-runs via onAuthStateChanged's pendingCheckout-resume
// after a logged-out buyer authenticates — currentUser differs between the
// guest call and the resumed call for the same checkout attempt.
let stripeRedirectAt = 0;
let stripeArrivedFired = false;
let stripeRedirectWasGuest = false;

function onStripePagehide() {
  if (stripeArrivedFired) return;
  if (stripeRedirectAt === 0) return;
  if (Date.now() - stripeRedirectAt > 10000) return;
  if (typeof gtag === 'undefined') return;
  stripeArrivedFired = true;
  gtag('event', 'stripe_arrived', {
    page_path:      location.pathname,
    is_guest:       stripeRedirectWasGuest,
    transport_type: 'beacon',
  });
}

function trackCheckoutAndGo(url) {
  // The visitor dismissed the modal after the click that got here. Every
  // caller is inside openPaymentModal(), which clears the flag at the top of
  // each attempt, so this only ever means "declined THIS redirect".
  if (checkoutCancelled) return;
  // Clear the checkout intent the moment we commit to the Stripe redirect.
  // This ensures that on ANY return path — bfcache restore OR full reload —
  // onAuthStateChanged finds no intent and does NOT auto-restart checkout.
  window.__pendingCheckout = false;
  try { sessionStorage.removeItem('cca_checkout_intent'); } catch (_) {}
  let navigated = false;
  const go = () => {
    // checkoutCancelled is re-read here, not captured above: the whole point
    // is the ~1s gap between arming the redirect and taking it. event_callback
    // can also fire after a dismissal, and reaches this same guard.
    if (navigated || checkoutCancelled) return;
    navigated = true;
    stripeRedirectAt = Date.now();
    stripeArrivedFired = false;
    stripeRedirectWasGuest = !currentUser;
    window.addEventListener('pagehide', onStripePagehide, { once: true });
    // Navigate via a real <a> click rather than location.href= so GA4's
    // cross-domain linker (configured for buy.stripe.com/checkout.stripe.com
    // in <head>) can decorate this navigation with its session-stitching
    // _gl param — gtag.js wires up linker decoration via a delegated click
    // listener on document, which a plain location assignment bypasses.
    const a = document.createElement('a');
    a.href = url;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  if (checkoutEventSent) { go(); return; }
  checkoutEventSent = true;
  if (typeof gtag !== 'undefined') {
    gtag('event', 'begin_checkout', { value: 49, currency: 'USD', transport_type: 'beacon', event_callback: go, event_timeout: 1000 });
    // The bare timeout is the only guarantee a buyer reaches Stripe when
    // event_callback never fires (gtag.js is deferred to window.onload), so it
    // stays exactly as it was — the handle is kept only so a dismissal can
    // clear it. Nothing about the undismissed path changes.
    _checkoutGoTimer = setTimeout(() => { _checkoutGoTimer = null; go(); }, 1000);
  } else {
    go();
  }
}

function openPaymentModal() {
  // Every path out of here is a fresh checkout attempt, so a dismissal of the
  // PREVIOUS one must not block it. This is the only place the flag is
  // cleared, which is why declining once never sticks.
  checkoutCancelled = false;
  // A previous checkout's post-payment confirmation never matched this
  // browser to an account (see confirmPaymentAndUnlock) — don't let the
  // visitor pay a second time while that's unresolved. Point them back at
  // the "don't pay again, contact support" banner instead of Stripe.
  if (window.__paymentNeedsManualReview) {
    const banner = document.getElementById('success-banner');
    // #success-banner is position:fixed at the top of the viewport, so
    // making it visible is enough — no scrolling needed. If the visitor is
    // scrolled down, bring them to the top so they actually see it.
    if (banner) banner.style.display = 'block';
    else {
      // No banner on this page (/diagnostic/), so the line above no-ops and
      // this exit rendered nothing at all: the visitor clicked buy and the
      // button was dead. Same copy in the modal, minus Dismiss.
      const host = paymentBlockHost();
      if (host) {
        host.innerHTML = unmatchedPaymentBody();
        showPaymentBlock(host, 'Payment already received');
      }
    }
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' });
    // This gate has never been sized. banner_shown separates the homepage case
    // from /diagnostic/, where #success-banner does not exist and the guard above
    // no-ops, leaving a completely dead buy button.
    if (typeof gtag !== 'undefined') {
      gtag('event', 'payment_review_blocked', {
        banner_shown: !!banner,
        page_path:    location.pathname,
      });
    }
    return;
  }

  if (!currentUser) {
    // Guest checkout — previously this walled off logged-out buyers behind a
    // forced signup modal before they could reach Stripe. The webhook's
    // pending_enrollments + /claim-enrollment path (scripts/stripe-webhook.js)
    // already reconciles a purchase made before a Firebase account exists,
    // keyed by email — so guests can go straight to Stripe and reconcile
    // after the fact instead of signing up first. Safe to reopen now that
    // /pre-checkout also rejects checkout for any caller with an unclaimed
    // pending purchase (see the pending_enrollments guard added there) —
    // that guard is what was missing when this path was last shipped.
    //
    // No client-side debounce — mirrors the logged-in path (see the
    // recent_session branch below), which never blocks a recent/duplicate
    // attempt either: it just proceeds to Stripe. A guest who abandoned
    // Stripe and clicks buy again gets a fresh redirect, not a banner that
    // falsely implies a charge may be in flight.
    openAuthModalLoading('Redirecting to secure checkout…');
    const guestUrl = new URL(STRIPE_PAYMENT_LINK);
    // Deliberately omit client_reference_id (no Firebase UID yet) and
    // prefilled_email (no known email yet) — Stripe still collects an email
    // at checkout, and the webhook's email-keyed pending_enrollments path
    // reconciles it once this buyer creates/logs into a matching account.
    if (typeof gtag !== 'undefined') { gtag('event', 'guest_checkout_redirect', {}); }
    trackCheckoutAndGo(guestUrl.toString());
    return;
  }

  // Already enrolled — don't send a paying customer back to Stripe. Land on
  // the dashboard if this page has one (homepage); otherwise (e.g.
  // /diagnostic/, which has no dashboard section) go to the homepage, which
  // will show it.
  if (enrolled) {
    // Fired before the branch below because the no-dashboard path navigates away;
    // beacon for the same reason (precedent: stripe_arrived).
    if (typeof gtag !== 'undefined') {
      gtag('event', 'already_enrolled_click', {
        page_path:      location.pathname,
        transport_type: 'beacon',
      });
    }
    if (document.getElementById('dashboard-section')) {
      closeAuthModal();
      showSection('dashboard');
    } else {
      openAuthModalLoading('Taking you to your dashboard…');
      window.location.href = '/';
    }
    return;
  }

  // Brief feedback for the begin_checkout/gtag wait below (up to ~1s) so the
  // click doesn't look like it did nothing while we redirect to Stripe.
  openAuthModalLoading('Redirecting to secure checkout…');
  const url = new URL(STRIPE_PAYMENT_LINK);
  url.searchParams.set('client_reference_id', currentUser.uid);
  url.searchParams.set('prefilled_email', currentUser.email);

  // Best-effort: save GA4 attribution to Firestore so the server-side
  // Measurement Protocol purchase event (fired from stripe-webhook.js after
  // enrollment) can stitch to the original session.
  //
  // Async IIFE — fire-and-forget, never blocks checkout. Awaits
  // ensureFirestore() so window.__fs can never be null at write time
  // (the previous if (window.__fs) guard silently skipped the write for
  // buyers who authenticated during checkout, before Firestore loaded).
  (async () => {
    try {
      await ensureFirestore();
      const fs = window.__fs;
      if (!fs) return;
      const _gaMatch    = document.cookie.match(/(?:^|;)\s*_ga=GA\d+\.\d+\.(\d+\.\d+)/);
      const _gaClientId = _gaMatch ? _gaMatch[1] : null;
      const _gclidAwMatch = document.cookie.match(/(?:^|;)\s*_gcl_aw=(GCL\.[^;]+)/);
      const _gclidAw  = _gclidAwMatch ? _gclidAwMatch[1] : null;
      const _gclidRaw = (_gclidAw ? _gclidAw.replace(/^GCL\.\d+\./, '') : null)
                        || new URLSearchParams(window.location.search).get('gclid')
                        || (() => { try { return sessionStorage.getItem('cca_gclid'); } catch (e) { return null; } })();

      const fsRef = fs.doc(db, 'users', currentUser.uid);
      const writeAttribution = (sid, snum) => {
        const data = {};
        if (_gaClientId)  data.ga4ClientId     = _gaClientId;
        if (_gclidRaw)    data.gclid           = _gclidRaw;
        if (_gclidAw)     data.gclid_aw        = _gclidAw;
        if (sid  != null) data.ga4SessionId    = String(sid);
        if (snum != null) data.ga4SessionNumber = Number(snum);
        if (Object.keys(data).length) {
          fs.setDoc(fsRef, data, { merge: true }).catch(() => {});
        }
      };

      if (typeof gtag !== 'undefined') {
        // Read session_id and session_number in parallel; write once both return.
        let sid = null, snum = null, pending = 2;
        const maybe = () => { if (--pending === 0) writeAttribution(sid, snum); };
        gtag('get', 'G-3ERZD33VQB', 'session_id',     function(v) { sid  = v; maybe(); });
        gtag('get', 'G-3ERZD33VQB', 'session_number',  function(v) { snum = v; maybe(); });
      } else {
        writeAttribution(null, null);
      }
    } catch (e) { /* best-effort, never block checkout */ }
  })();

  // Server-side pre-checkout guard: confirm the account isn't already enrolled
  // and no duplicate checkout is already in flight. Hard 4 s timeout so a cold
  // Render dyno can't freeze a legitimate buyer at the loading screen.
  // Fails open on any error — never block a first-time purchase.
  const _preUrl = url.toString();
  const _preCtrl = new AbortController();
  const _preTimer = setTimeout(() => _preCtrl.abort(), 4000);
  // Published so a dismissal can abort this fetch. The abort alone changes
  // nothing — it lands in the fail-open .catch() below, which redirects — so
  // both settle paths check checkoutCancelled before doing anything.
  _checkoutPreCtrl = _preCtrl;
  currentUser.getIdToken()
    .then(tok => fetch(WEBHOOK_BASE + '/pre-checkout', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      // B2: the product this click buys. The route reads an absent body as ccar,
      // so the older client keeps working; B3 sends the real product.
      body: JSON.stringify({ product: 'ccar' }),
      signal: _preCtrl.signal,
    }))
    .then(r => r.json())
    .then(result => {
      clearTimeout(_preTimer);
      if (_checkoutPreCtrl === _preCtrl) _checkoutPreCtrl = null;
      // Dismissed while this was in flight. Every branch below either
      // redirects or navigates, and the visitor has said no to all of them.
      if (checkoutCancelled) return;
      if (result.reason === 'already_enrolled') {
        closeAuthModal();
        if (document.getElementById('dashboard-section')) showSection('dashboard');
        else window.location.href = '/';
      } else if (result.reason === 'pending_purchase') {
        // Server found an unclaimed pending_enrollments record for this
        // account's email — they already paid once under this email; sending
        // them to Stripe again would double-charge them.
        //
        // /claim-enrollment no longer gates on email_verified (Sep 2026), so a
        // record still standing here means the sign-in claim has not run yet
        // or failed transiently (cold start, network). Retry it now rather
        // than telling a buyer who is a second away from enrolment to verify
        // an address that no longer needs verifying. attemptPendingClaim
        // enrols, navigates to the dashboard and confirms on success; on
        // failure the payment is known to be received, so show the same
        // "received, reload, else support" copy the post-checkout poll uses,
        // through paymentBlockHost() so /diagnostic/ gets the modal panel.
        //
        // Sizes the second invisible block. Unlike the localStorage gate this
        // one is server-side and account-keyed, so it follows the buyer across
        // browsers.
        if (typeof gtag !== 'undefined') {
          gtag('event', 'payment_blocked_pending', { page_path: location.pathname });
        }
        closeAuthModal();
        const showActivationPending = () => {
          const host = paymentBlockHost();
          if (!host) return;
          host.innerHTML = host.id === 'success-banner' ? paymentActivationTimeoutMsg() : paymentActivationTimeoutBody();
          showPaymentBlock(host, 'Payment received');
        };
        attemptPendingClaim(currentUser)
          .then(claim => { if (!claim.enrolled) showActivationPending(); })
          .catch(e => {
            console.warn('[Enrollment] pending-purchase claim retry failed:', e.message);
            showActivationPending();
          });
      } else if (result.reason === 'recent_session') {
        // The checkout_intents/{uid} doc is stale — the user likely returned
        // from Stripe without paying and is trying again. Delete it and proceed
        // directly to Stripe rather than showing the "in progress" banner, which
        // falsely implies the user may have been charged.
        // (The webhook independently guards against actual duplicate enrollment.)
        try {
          if (window.__fs && typeof db !== 'undefined' && currentUser) {
            window.__fs.deleteDoc(
              window.__fs.doc(db, 'checkout_intents', currentUser.uid)
            ).catch(function() {});
          }
        } catch (_) {}
        trackCheckoutAndGo(_preUrl);
      } else {
        trackCheckoutAndGo(_preUrl);
      }
    })
    // Still fails open on a real error. A dismissal reaches here too, because
    // cancelPendingCheckout() aborts the fetch — trackCheckoutAndGo() checks
    // the same flag and returns, so this stays one behaviour, not two.
    .catch(() => {
      clearTimeout(_preTimer);
      if (_checkoutPreCtrl === _preCtrl) _checkoutPreCtrl = null;
      trackCheckoutAndGo(_preUrl);
    });
}

// Legacy fallback: check URL params on load (for non-Firebase mode)
function checkPaymentSuccess() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('paid') === 'true' && !firebaseReady) {
    // Non-Firebase fallback. NOTE: this branch appears unreachable from the
    // current init flow — checkPaymentSuccess() is only ever invoked
    // immediately after `firebaseReady = true` is set (see DOMContentLoaded
    // above), and the catch-block for a failed Firebase init never calls it.
    // Left intact rather than deleted (out of scope of the analytics
    // cleanup), but its old `exam_purchase` gtag firing — a *second*,
    // independent firing location for the same event, keyed on a fabricated
    // 'anon_'+timestamp id with no de-dupe — has been removed. There's no
    // Firebase user here to hang a durable per-user flag off of, and the
    // centralized, guarded firing now lives solely in markEnrolled() /
    // maybeFireExamPurchaseEvent() above.
    enrolled = true;
    localStorage.setItem('cca_enrolled', 'true');
    document.getElementById('success-banner').style.display = 'block';
    window.history.replaceState({}, '', window.location.pathname);
    showSection('dashboard');
  } else if (!firebaseReady && localStorage.getItem('cca_enrolled') === 'true') {
    enrolled = true;
  }
}

// ═══════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════
function showSection(id) {
  // Pages without the dashboard/SPA sections (e.g. /diagnostic/, which only
  // loads app.js for its checkout/auth modal) have nothing for this to do.
  if (!document.getElementById('home-section')) return;
  ['home','pricing','testimonials','customer-quotes','comparison','dashboard','test','results','lessons','progress'].forEach(s => {
    const el = document.getElementById(s + '-section');
    if (el) el.style.display = 'none';
  });
  document.querySelectorAll('.hero').forEach(h => h.style.display='none');
  var sqSection = document.getElementById('sample-questions');
  if (sqSection) sqSection.style.display = 'none';
  document.querySelectorAll('.dashboard,.test-view,.results-view,.lessons-view,.progress-view').forEach(el => el.style.display='none');
  document.querySelectorAll('[data-nav]').forEach(b => b.classList.remove('active'));

  if (id === 'home') {
    document.getElementById('home-section').style.display = 'block';
    if (sqSection) sqSection.style.display = 'block';
    document.getElementById('testimonials-section').style.display = 'block';
    document.getElementById('customer-quotes-section').style.display = 'block';
    document.getElementById('pricing-section').style.display = 'block';
    document.getElementById('comparison-section').style.display = 'block';
  } else if (id === 'pricing') {
    document.getElementById('testimonials-section').style.display = 'block';
    document.getElementById('customer-quotes-section').style.display = 'block';
    document.getElementById('pricing-section').style.display = 'block';
    document.getElementById('comparison-section').style.display = 'block';
    document.getElementById('pricing-section').scrollIntoView({behavior:'smooth'});
  } else if (id === 'dashboard') {
    document.getElementById('dashboard-section').style.display = 'block';
    document.querySelector('[data-nav="dashboard"]').classList.add('active');
    updateDashCards();
  } else if (id === 'test') {
    document.getElementById('test-section').style.display = 'block';
    document.querySelector('[data-nav="dashboard"]').classList.add('active');
  } else if (id === 'results') {
    document.getElementById('results-section').style.display = 'block';
    document.querySelector('[data-nav="dashboard"]').classList.add('active');
  } else if (id === 'lessons') {
    document.getElementById('lessons-section').style.display = 'block';
    document.querySelector('[data-nav="lessons"]').classList.add('active');
    if (!lessonsLoaded) renderLessons();
  } else if (id === 'progress') {
    document.getElementById('progress-section').style.display = 'block';
    const navBtn = document.querySelector('[data-nav="progress"]');
    if (navBtn) navBtn.classList.add('active');
    loadProgress();
  }
  window.scrollTo({top:0, behavior:'smooth'});
}

// ═══════════════════════════════════════
// PROGRESS DASHBOARD (enrolled users)
// ═══════════════════════════════════════
// Domain keys must match the `d` field stored on each question (see QUESTIONS
// below) and the real CCA exam weightings used throughout the site.
const PROGRESS_DOMAINS = [
  { key: 'Agentic Architecture & Orchestration',   label: 'Agentic Architecture & Orchestration',   weight: 27 },
  { key: 'Claude Code Configuration',              label: 'Claude Code Configuration & Workflows',  weight: 20 },
  { key: 'Prompt Engineering & Structured Output', label: 'Prompt Engineering & Structured Output', weight: 20 },
  { key: 'Tool Design & MCP Integration',          label: 'Tool Design & MCP Integration',          weight: 18 },
  { key: 'Context Management & Reliability',       label: 'Context Management & Reliability',       weight: 15 },
];
const PROGRESS_TYPE_LABELS = { quick: 'Quick Sprint', focused: 'Focused Session', deep: 'Deep Practice', full: 'Full Certification Exam' };

// Blueprint order, per the official CCAR-F Exam Guide v1.0 section 4 --
// Agentic 27, Tool Design 18, Claude Code Config 20, Prompt Eng 20,
// Context Mgmt 15. PROGRESS_DOMAINS is in the BANK's own order and stays that
// way: the mastery grid renders from it. This is a separate view over the same
// five domains, used by the domain drill's picker.
//
// The slug is what ?startTest=domain-<slug> carries. It is a NAME, never a
// position, so reordering this list can't silently repoint a bookmarked link
// the way an index would.
const DOMAIN_DRILL_DOMAINS = [
  { slug: 'agentic',     key: 'Agentic Architecture & Orchestration'   },
  { slug: 'tool-design', key: 'Tool Design & MCP Integration'          },
  { slug: 'claude-code', key: 'Claude Code Configuration'              },
  { slug: 'prompt',      key: 'Prompt Engineering & Structured Output' },
  { slug: 'context',     key: 'Context Management & Reliability'       },
];
const DOMAIN_DRILL_QUESTIONS = 20;   // requested; the real count is min(this, available)
const DOMAIN_DRILL_MINUTES   = 40;   // matches Focused Session's 20q / 40m shape

// The bank's `d` field is the join key used by POOL, domainScores and the stored
// attempt history, so it never changes. PROGRESS_DOMAINS carries the display name
// (the bank's `Claude Code Configuration` is truncated against the guide's
// `Claude Code Configuration & Workflows`). Falls back to the raw key so an
// unmapped domain still renders a name rather than nothing.
function progressDomain(key) { return PROGRESS_DOMAINS.find(x => x.key === key) || null; }
function domainLabel(key) {
  const d = progressDomain(key);
  return d ? d.label : key;
}

// `domain-<slug>` is the drill's test type. Returns null for every other type,
// which is what leaves getTestConfig()'s switch and startTest()'s enrollment
// guard working exactly as they did.
function domainDrillEntry(type) {
  if (typeof type !== 'string' || type.indexOf('domain-') !== 0) return null;
  return DOMAIN_DRILL_DOMAINS.find(d => d.slug === type.slice('domain-'.length)) || null;
}

// Per-domain item counts. Counted from the loaded bank once it is in memory;
// until then (and for visitors who never load it) from BANK_DOMAIN_COUNTS, a
// table scripts/build-pools.js generates from the private JSON bank so the
// drill picker and the drill size never carry a hand-typed number. Four
// other surfaces publish per-domain counts and one of them was wrong for
// four weeks; this is the one the engine trusts.
// cca:bank-domain-counts:start
const BANK_DOMAIN_COUNTS = {"Agentic Architecture & Orchestration":109,"Claude Code Configuration":80,"Prompt Engineering & Structured Output":79,"Tool Design & MCP Integration":72,"Context Management & Reliability":60};
// cca:bank-domain-counts:end
function domainQuestionCount(key) {
  if (loadedBankCounts && Object.prototype.hasOwnProperty.call(loadedBankCounts, key)) return loadedBankCounts[key];
  return BANK_DOMAIN_COUNTS[key] || 0;
}

// finishTest() stores the drill as type `domain-<slug>`. Without an entry here
// the Recent Attempts list renders that raw key. Built from the same table so
// the two can't drift apart.
DOMAIN_DRILL_DOMAINS.forEach(d => { PROGRESS_TYPE_LABELS['domain-' + d.slug] = domainLabel(d.key) + ' Drill'; });

// Fills the Domain Drill card's <select>. Blueprint order, label from
// PROGRESS_DOMAINS (so the truncated Claude Code name is corrected here too),
// exam weight beside the name per the never-a-bare-sequence rule, and the
// number of questions the domain actually holds, counted from QUESTIONS.
function renderDomainDrillPicker() {
  const sel = document.getElementById('domain-drill-select');
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = DOMAIN_DRILL_DOMAINS.map(d => {
    const dom = progressDomain(d.key);
    const w   = dom ? dom.weight + '% of exam · ' : '';
    return `<option value="${d.slug}">${domainLabel(d.key)} — ${w}${domainQuestionCount(d.key)} questions</option>`;
  }).join('');
  if (keep) sel.value = keep;
  updateDomainDrillMeta();
}

// The card's meta line shows what the drill will actually draw, which is
// min(20, available) -- not the requested 20.
function updateDomainDrillMeta() {
  const sel  = document.getElementById('domain-drill-select');
  const meta = document.getElementById('domain-drill-meta');
  if (!sel || !meta || !sel.value) return;
  const cfg = getTestConfig('domain-' + sel.value);
  if (cfg) meta.textContent = cfg.questions + ' Questions';
}

// Card button. Routes through startTest() like every other mode, so the
// enrollment guard, the shuffle and the correct-index remap all still apply.
function startDomainDrill() {
  const sel = document.getElementById('domain-drill-select');
  if (!sel || !sel.value) return;
  startTest('domain-' + sel.value);
}

async function loadProgress() {
  const emptyEl   = document.getElementById('progress-empty');
  const contentEl = document.getElementById('progress-content');
  if (!emptyEl || !contentEl) return;
  if (!currentUser || !enrolled) {
    emptyEl.style.display = 'block';
    contentEl.style.display = 'none';
    return;
  }
  try {
    await ensureFirestore();
    const fs = window.__fs;
    const attemptsQuery = fs.query(
      fs.collection(db, 'users', currentUser.uid, 'attempts'),
      fs.orderBy('takenAt', 'asc'),
      fs.limitToLast(50)
    );
    const snap = await fs.getDocs(attemptsQuery);
    if (snap.empty) {
      emptyEl.style.display = 'block';
      contentEl.style.display = 'none';
      return;
    }
    const attempts = snap.docs.map(d => d.data()).filter(a => a && a.domainScores);
    if (!attempts.length) {
      emptyEl.style.display = 'block';
      contentEl.style.display = 'none';
      return;
    }
    renderProgress(attempts);
    emptyEl.style.display = 'none';
    contentEl.style.display = 'block';
  } catch (e) {
    console.warn('[Progress] load failed:', e.message);
    // Don't show a broken/half-populated dashboard — fall back to the empty state.
    emptyEl.style.display = 'block';
    contentEl.style.display = 'none';
  }
}

function renderProgress(attempts) {
  // Aggregate correct/total per domain across every attempt, plus a
  // chronological per-attempt history (used for the "over time" trend bars).
  const agg = {};
  PROGRESS_DOMAINS.forEach(d => { agg[d.key] = { correct: 0, total: 0, history: [] }; });

  attempts.forEach(a => {
    const ds = a.domainScores || {};
    Object.keys(ds).forEach(key => {
      if (!agg[key]) agg[key] = { correct: 0, total: 0, history: [] };
      const c = ds[key].correct || 0, t = ds[key].total || 0;
      agg[key].correct += c;
      agg[key].total += t;
      if (t > 0) agg[key].history.push(Math.round((c / t) * 100));
    });
  });

  // ── Readiness estimate ──
  // Weighted by each domain's real exam percentage, renormalized across only
  // the domains the user has actually attempted (never invents data for
  // domains with zero attempts — those are simply excluded from the average).
  let weightedSum = 0, coveredWeight = 0, coveredCount = 0;
  PROGRESS_DOMAINS.forEach(d => {
    const s = agg[d.key];
    if (s.total > 0) {
      weightedSum += (s.correct / s.total) * d.weight;
      coveredWeight += d.weight;
      coveredCount++;
    }
  });
  const readinessScore = coveredWeight > 0 ? Math.round((weightedSum / coveredWeight) * 1000) : 0;
  const passScore = 720;
  const readinessCls = readinessScore >= passScore ? 'high' : readinessScore >= passScore * 0.85 ? 'mid' : 'low';

  document.getElementById('readiness-score').textContent = readinessScore.toLocaleString() + ' / 1,000';
  const bar = document.getElementById('readiness-bar');
  bar.style.width = Math.min(100, (readinessScore / 1000) * 100) + '%';
  bar.className = 'rc-bar-fill ' + readinessCls;
  document.getElementById('attempt-count').textContent = attempts.length;
  document.getElementById('readiness-coverage-note').textContent = coveredCount < PROGRESS_DOMAINS.length
    ? ` This estimate currently covers ${coveredCount} of ${PROGRESS_DOMAINS.length} exam domains — keep practicing across all domains to sharpen it.`
    : '';

  // ── Weakest domain (lowest mastery among domains with attempts) ──
  let weakest = null;
  PROGRESS_DOMAINS.forEach(d => {
    const s = agg[d.key];
    if (s.total > 0) {
      const pct = s.correct / s.total;
      if (!weakest || pct < weakest.pct) weakest = { label: d.label, weight: d.weight, pct };
    }
  });
  if (weakest) {
    const wPct = Math.round(weakest.pct * 100);
    const wCls = wPct >= 70 ? 'high' : wPct >= 50 ? 'mid' : 'low';
    document.getElementById('weakest-domain-name').textContent = weakest.label;
    document.getElementById('weakest-domain-weight').textContent = weakest.weight;
    const pctEl = document.getElementById('weakest-domain-pct');
    pctEl.textContent = wPct + '% mastery';
    pctEl.className = 'wc-pct ' + wCls;
  }

  renderDomainMasteryGrid(agg);
  renderAttemptsList(attempts);
}

function renderDomainMasteryGrid(agg) {
  const grid = document.getElementById('domain-mastery-grid');
  if (!grid) return;
  grid.innerHTML = PROGRESS_DOMAINS.map(d => {
    const s = agg[d.key];
    const hasData = s.total > 0;
    const pct = hasData ? Math.round((s.correct / s.total) * 100) : null;
    const cls = pct === null ? '' : pct >= 70 ? 'high' : pct >= 50 ? 'mid' : 'low';

    const trendHtml = hasData
      ? s.history.slice(-12).map(p => {
          const bcls = p >= 70 ? 'high' : p >= 50 ? 'mid' : 'low';
          return `<div class="dm-bar ${bcls}" style="height:${Math.max(p, 6)}%" title="${p}% on this attempt"></div>`;
        }).join('')
      : '<div class="dm-empty-trend">Not practiced yet</div>';

    return `
    <div class="domain-mastery-card">
      <div class="dm-top">
        <span class="dm-name">${d.label}</span>
        <span class="dm-weight">${d.weight}% of exam</span>
      </div>
      ${hasData
        ? `<div class="dm-pct ${cls}">${pct}% mastery</div><div class="dm-sub">${s.correct}/${s.total} correct across your attempts</div>`
        : `<div class="dm-pct dm-pct-empty">No attempts yet</div><div class="dm-sub">Take a session covering this domain to start tracking it</div>`}
      <div class="dm-trend">${trendHtml}</div>
    </div>`;
  }).join('');
}

function renderAttemptsList(attempts) {
  const list = document.getElementById('attempts-list');
  if (!list) return;
  const recent = attempts.slice(-12).slice().reverse(); // most recent first
  list.innerHTML = recent.map(a => {
    let dateStr = '—';
    if (a.takenAt && typeof a.takenAt.toDate === 'function') {
      dateStr = a.takenAt.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
    const pct = typeof a.pct === 'number' ? a.pct : (a.totalQuestions ? Math.round((a.correct / a.totalQuestions) * 100) : 0);
    const cls = pct >= 70 ? 'high' : pct >= 50 ? 'mid' : 'low';
    const typeLabel = PROGRESS_TYPE_LABELS[a.type] || a.type || 'Practice session';
    return `<div class="attempt-row">
      <span class="ar-type">${typeLabel}</span>
      <span class="ar-date">${dateStr}</span>
      <span class="ar-score ${cls}">${a.correct}/${a.totalQuestions} · ${pct}%</span>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════
// QUESTION BANK AND LESSONS
// ═══════════════════════════════════════
// Stage B2 (Oct 2026): the 400-item CCAR-F bank and the five lessons are no
// longer bundled here. They live in Firestore (bank_ccar, lessons_ccar), read
// by activeBank() above for enrolled accounts only; the source of truth is the
// private repository cca-question-banks (its README carries the editing and
// retirement rules that used to sit between the items here). The only question
// objects in this file are the 55 of FREE_POOL in the TEST ENGINE section.

// ═══════════════════════════════════════
// TEST ENGINE
// ═══════════════════════════════════════

// MR (multiple-response) support. MC questions carry no `type` field, so
// isMR(q) is false for all 401 existing questions and every helper below
// collapses to the original MC-only expression.
function isMR(q) { return q.type === 'mr'; }

function isAnswered(a) { return Array.isArray(a) ? a.length > 0 : a !== -1; }

// The free preview reveals an answer as soon as the question is answered, and
// isAnswered() is true at ONE selection — which graded and locked a two- or
// three-key MR item on the candidate's first click. Reveal an MR item only once
// the selection is COMPLETE. The required count comes from q.a.length, never a
// hardcoded 2 or 3 (31 MR items carry two keys, 12 carry three). An mr-typed
// item with a scalar q.a is a data anomaly that toggleAnswer()'s own
// Array.isArray(q.a) guard already refuses to touch, so fall through to
// isAnswered() and leave that path exactly as it is.
function isSelectionComplete(q, a) {
  if (!isMR(q) || !Array.isArray(q.a)) return isAnswered(a);
  return Array.isArray(a) && a.length === q.a.length;
}

function isCorrect(q, a) {
  if (!isMR(q)) return a === q.a;
  if (!Array.isArray(a) || a.length !== q.a.length) return false;
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedCorrect = [...q.a].sort((x, y) => x - y);
  return sortedA.every((v, i) => v === sortedCorrect[i]);
}

function isOptionCorrect(q, i) { return isMR(q) ? q.a.includes(i) : i === q.a; }

let currentTest = null;
let timerInterval = null;

function getTestConfig(type) {
  const drill = domainDrillEntry(type);
  if (drill) {
    // Context Management holds the fewest questions, so take what the domain
    // actually has rather than assuming 20 exists everywhere.
    return {
      name: domainLabel(drill.key) + ' Drill',
      questions: Math.min(DOMAIN_DRILL_QUESTIONS, domainQuestionCount(drill.key)),
      minutes: DOMAIN_DRILL_MINUTES
    };
  }
  switch(type) {
    case 'quick': return {name:'Quick Sprint', questions:10, minutes:20};
    case 'focused': return {name:'Focused Session', questions:20, minutes:40};
    case 'deep': return {name:'Deep Practice', questions:30, minutes:60};
    case 'full': return {name:'Full Certification Exam', questions:60, minutes:120};
  }
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length -1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

// -- FULL-EXAM STRATIFICATION ----------------------------------------------
// A uniform draw of 60 from a 400-item bank lands on the published weights
// only in expectation. Context Management averages 9 but runs +/- 2.6, so an
// individual attempt could serve 6 or 12 of it. These two functions make every
// attempt carry the blueprint exactly.
//
// The weights come from PROGRESS_DOMAINS, which already holds the guide figures
// beside the domain keys, so nothing here hardcodes a count. Change a weight
// there and the draw follows.

// Largest-remainder (Hare quota) allocation of `count` seats across the domains.
// 60 at 27/20/20/18/15 gives exact shares 16.20/12.00/12.00/10.80/9.00; the
// floors sum to 59, and the one leftover seat goes to the largest fractional
// part, which is Tool Design at 0.80 and is the only one above zero. Result:
// 16/12/12/11/9.
function domainQuota(count) {
  const total = PROGRESS_DOMAINS.reduce((s, d) => s + d.weight, 0);
  const rows  = PROGRESS_DOMAINS.map(d => {
    const exact = count * d.weight / total;
    return { key: d.key, n: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let short = count - rows.reduce((s, r) => s + r.n, 0);
  // Sort a COPY so `rows` keeps blueprint order; the objects are shared, so
  // incrementing here updates the originals.
  rows.slice().sort((a, b) => b.rem - a.rem).forEach(r => { if (short > 0) { r.n++; short--; } });
  return rows;
}

// Shuffle within each domain, take that domain's seats, then shuffle the result
// so the paper is not served in domain blocks. This runs on the INPUT side of
// the option shuffle -- the same place the domain drill narrows -- so the
// correct-index remap, MR handling and the option cap downstream are untouched.
function stratifiedDraw(pool, count) {
  const out = [];
  for (const row of domainQuota(count)) {
    out.push(...shuffleArray(pool.filter(q => q.d === row.key)).slice(0, row.n));
  }
  // A domain holding fewer questions than its seats would leave the paper short.
  // It cannot happen today -- the smallest domain has 60 against 9 seats -- but a
  // future retirement must shrink that domain's share, never the exam.
  if (out.length < count) {
    const taken = new Set(out);
    out.push(...shuffleArray(pool.filter(q => !taken.has(q))).slice(0, count - out.length));
  }
  return shuffleArray(out);
}

// -- FREE-PREVIEW DRAW ------------------------------------------------------
// The draw for the two surfaces a logged-out visitor can run: the Focused
// Session preview (five questions) and the unenrolled Quick Sprint (ten). Both
// draw from FREE_POOL (below), a fixed sample of the bank, never from all 400.
// It draws ONE multiple-response item and count-1 single-select items, then
// shuffles them so the MR item's slot is uniform. Every paid mode, and an
// enrolled Quick Sprint, keeps the plain uniform draw over the whole bank in
// startTest.
//
// One MR item is excluded from this draw only: the one reproduced verbatim on
// the homepage sample cards (index.html, sample-q-section). A visitor who has
// just answered it there would otherwise meet it again as their "free"
// question. It is matched by stem text, never by index, because indices shift
// when an item is retired; if that stem is ever edited in QUESTIONS, edit it
// here in the same commit. scripts/build-pools.js reads this set and aborts if
// the stem no longer matches exactly one item, so the drift cannot ship silently.
//
// Falls back to the uniform draw if either subset is unexpectedly short -- a
// free preview must never fail to start.
const FREE_PREVIEW_MR_EXCLUDE = new Set([
  "A review prompt sets out in prose the four fields every finding must carry, and the model still returns findings that drop a field and change shape between runs. Which two changes address that most directly?",
]);

function freePreviewDraw(pool, count) {
  const mrPool = pool.filter(q => isMR(q) && !FREE_PREVIEW_MR_EXCLUDE.has(q.q));
  const scPool = pool.filter(q => !isMR(q));
  if (count < 2 || mrPool.length < 1 || scPool.length < count - 1) {
    return shuffleArray(pool).slice(0, count);
  }
  const picked = [shuffleArray(mrPool)[0], ...shuffleArray(scPool).slice(0, count - 1)];
  return shuffleArray(picked);
}

// -- FREE POOL --------------------------------------------------------------
// The two logged-out surfaces above draw from FREE_POOL, a fixed sample of the
// bank, never from the paid bank: ten single-select and one multiple-response
// item per domain, chosen with no key-longest option (this is the most-viewed
// question set on the property), disjoint from the diagnostic's 40 and from
// every item quoted on a page or in the nurture emails. Stage B2 (Oct 2026)
// made these 55 objects the only question content in this file.
// THE LITERAL BELOW IS GENERATED: edit FREE_STEMS in scripts/build-pools.js and
// run it. It reads the private JSON bank (../cca-question-banks), enforces the
// pool rules above and aborts on any breach, and stamps the objects here.
// cca:free-pool:start
const FREE_POOL = [
  // Agentic Architecture & Orchestration
  {"d":"Agentic Architecture & Orchestration","q":"You are building a CI/CD pipeline agent. The agent must run linting, then unit tests, then integration tests in strict order, with each step depending on the previous step's output. Which multi-agent pattern is most appropriate?","o":["Hub-and-spoke pattern","Debate pattern","Pipeline pattern","Broadcast pattern"],"a":2,"e":"The pipeline pattern is ideal when tasks must be executed in a strict sequential order where each step's output feeds into the next step's input. CI/CD workflows are a classic example of pipeline processing where ordering and dependencies matter."},
  {"d":"Agentic Architecture & Orchestration","q":"You notice your agent is spending excessive tokens reasoning about trivial decisions like which greeting to use. What is the most effective fix?","o":["Raise budget_tokens so the model has room to settle trivial decisions quickly instead of re-deriving them","Enable extended thinking on every step with a budget_tokens value near the 1,024-token minimum, so each decision gets a short bounded reasoning pass","Move trivial decisions out of the agent loop by hardcoding them or using templates, reserving agent reasoning for complex decisions","Switch to a larger model: capacity is what determines how much reasoning a trivial decision attracts"],"a":2,"e":"Trivial decisions that do not require AI reasoning should be moved out of the agent loop. Hardcoding greetings or using templates eliminates unnecessary token consumption and latency. Agent reasoning should be reserved for decisions that genuinely benefit from the model's intelligence."},
  {"d":"Agentic Architecture & Orchestration","q":"You are implementing a self-healing mechanism in your agent. The agent tried to read a file but received a permission denied error. What should the self-healing behavior look like?","o":["Retry the read with exponential backoff and a capped attempt count, escalating to the user only once the backoff budget is exhausted and the error has not changed","Reason about the error, consider alternative approaches like requesting elevated permissions or reading from a different source, and act on the best alternative","Write the permission error into the agent's memory file so later sessions skip the path, and carry on with the remaining files in the current run","Return the error to the model as a user message rather than a tool result, since a tool result carrying an error ends the loop"],"a":1,"e":"Self-healing in an agent means the agent reasons about the error and considers alternative approaches. For a permission denied error, the agent might request different permissions, try reading from a backup location, or ask the user for help. Simply retrying the same failed operation is not self-healing."},
  {"d":"Agentic Architecture & Orchestration","q":"A hook intercepts outgoing tool calls and blocks any process_refund call exceeding $500, redirecting to human escalation. Why is this preferred over a prompt instruction saying 'do not process refunds over $500'?","o":["Hooks execute before the model call rather than after it, so the refund policy adds no latency to the request path","Hooks provide deterministic compliance guarantees whereas prompt instructions are probabilistic: the model might occasionally ignore them","A hook is re-evaluated on every turn while a prompt instruction is read only once at the start, so the hook stays in force as the context fills up","A PostToolUse hook can inspect the refund call after it runs and roll it back when the amount is too high"],"a":1,"e":"The key distinction is deterministic vs probabilistic compliance. Hooks guarantee that the policy is enforced every single time. Prompt-based instructions rely on the model following them, which has a non-zero failure rate. For business rules requiring guaranteed compliance, hooks are the correct approach."},
  {"d":"Agentic Architecture & Orchestration","q":"When escalating a customer issue to a human agent, your AI agent sends the entire conversation transcript. Why is this suboptimal?","o":["Transcript handoffs are truncated to the most recent turns by the escalation channel itself, so the opening messages where the customer states the original problem are the ones the human agent never receives","The handoff should include a structured summary with customer ID, root cause analysis, refund amount, and recommended action: human agents may lack access to the full transcript","The handoff should carry the agent's own tool-call reasoning trace so the human can audit which lookups ran and in what order, rather than the customer-facing messages","Transcripts belong in the compliance retention store, so passing them into the escalation payload duplicates records already held there"],"a":1,"e":"Structured handoff protocols should include compiled summaries with key details (customer ID, root cause, refund amount, recommended action) rather than raw transcripts. Human agents receiving escalations may not have access to or time to read the full conversation transcript."},
  {"d":"Agentic Architecture & Orchestration","q":"When should you use prompt chaining (fixed sequential pipeline) versus dynamic adaptive decomposition for task breakdown?","o":["Choose by task length: prompt chaining for anything that fits in a single context window, dynamic decomposition once the work spans more turns than one window can hold","Use prompt chaining for predictable multi-aspect reviews; use dynamic decomposition for open-ended investigation tasks where subtasks emerge based on findings","Prompt chaining passes each step's full transcript to the next, so it is the choice whenever later steps need earlier reasoning; dynamic decomposition discards it between subtasks","Run both and keep whichever completes in fewer tool calls, since cost is what separates the two approaches"],"a":1,"e":"Prompt chaining works well for predictable workflows with known steps (multi-aspect code reviews, fixed processing pipelines). Dynamic adaptive decomposition suits open-ended investigation tasks where subtasks emerge based on intermediate findings and the plan must adapt."},
  {"d":"Agentic Architecture & Orchestration","q":"Why should all subagent communication be routed through the coordinator rather than allowing direct peer-to-peer communication?","o":["The SDK exposes no channel between sibling subagents, so a coordinator hop is the only path a message can take between them","Routing through the coordinator provides observability, consistent error handling, and controlled information flow throughout the system","Peer-to-peer messages would cut a hop from each exchange, and the coordinator relay latency is what dominates wall-clock time across a long multi-agent run","Subagents run without network access of their own, so any message between them has to be relayed by the process that spawned them"],"a":1,"e":"Routing all communication through the coordinator ensures observability (you can monitor all interactions), consistent error handling (one place to handle failures), and controlled information flow (the coordinator decides what context each subagent receives)."},
  {"d":"Agentic Architecture & Orchestration","q":"A customer explicitly says 'I want to speak to a human agent.' Your support agent has already identified the issue and knows it can resolve it in one step. What should the agent do?","o":["Resolve the issue first since it's a quick fix, then offer to connect to a human","Immediately honor the customer's request and escalate to a human agent","Ask the customer if they'd like the agent to try resolving it first before escalating","Offer the resolution but note that a human agent is available if preferred"],"a":1,"e":"When a customer explicitly requests a human agent, the agent should honor that request immediately without first attempting investigation or resolution. This is a core escalation principle: explicit customer requests for humans are always escalated, regardless of how simple the issue appears to the agent."},
  {"d":"Agentic Architecture & Orchestration","q":"An orchestrator spawns a subagent but never receives a response. The subagent is likely stuck in a retry loop on a failing tool. What timeout and fallback pattern handles this?","o":["Have the failing tool return an errorCategory of transient with an isRetryable flag, which classifies the failure for the subagent but leaves the orchestrator waiting","Set a maximum wall-clock timeout on the subagent call; if it expires, cancel the subagent and return a structured timeout error to the orchestrator","Rely on the orchestrator's own iteration limit, since a subagent call that has not returned still counts as an iteration and the loop ends on its own","Have the orchestrator poll the subagent for a progress update, which reports what it is doing without ending the call"],"a":1,"e":"A wall-clock timeout on subagent calls prevents the orchestrator from blocking indefinitely. When the timeout fires, cancel the subagent and return a structured error that tells the orchestrator what was attempted and that the operation timed out. The orchestrator can then decide to retry, use a fallback, or escalate — rather than hanging."},
  {"d":"Agentic Architecture & Orchestration","q":"Your orchestrator needs to decide at runtime whether to use a fast cheap model or a powerful expensive model for each subtask. What routing strategy is most effective?","o":["Send every subtask to the most powerful model and rely on prompt caching to hold the cost down: cached input tokens are billed at the cheaper model's rate regardless of the model","Route by task complexity: use heuristics or a lightweight classifier to assign simple tasks to cheaper models and escalate complex reasoning to powerful models","Expose the model tier as a parameter on each subtask so the calling application picks it, keeping the routing decision outside the orchestrator entirely","Route by subtask input length, sending anything under a token threshold to the cheap model and everything longer to the powerful one"],"a":1,"e":"Dynamic model routing by task complexity captures most of the quality benefit of powerful models while controlling cost. Simple tasks like formatting, classification, and extraction rarely need frontier models; complex reasoning, multi-step planning, and edge-case handling do. A lightweight classifier or rule-based router directs traffic accordingly."},
  {"d":"Agentic Architecture & Orchestration","q":"A customer's message raises both a billing dispute and a shipping-address change in the same turn. Which three practices does correct multi-concern decomposition call for?","o":["Treat the billing dispute and the address change as two distinct items rather than one combined issue","Investigate both items in parallel, sharing the customer's account context across both investigations","Synthesize the two investigation results into a single unified resolution rather than two separate responses","Treat the message as one open-ended task and let a dynamic decomposition plan discover the sub-issues as it investigates","Escalate the entire request to a human agent, since two concerns in one message signal ambiguity","Route the billing dispute and the address change to two separate coordinator agents, each with an independent context window"],"a":[0,1,2],"type":"mr","e":"Task 1.4's skill bullet names all three correct facets — decompose into distinct items, investigate in parallel using shared context, synthesize into one resolution — and each is independently checkable. Treating the message as one open-ended task and letting a dynamic decomposition plan discover the sub-issues is real Task 1.6 content at the wrong problem — this request's two concerns are already known upfront, not discovered mid-investigation. Escalating the entire request to a human misapplies escalation: Task 5.2's actual triggers are explicit customer requests, policy gaps, or inability to progress — not multiple concerns arriving in one message. Routing the billing dispute and the address change to separate coordinators with independent context windows is a real mechanism at the wrong scope — it is the opposite of the shared context correct decomposition calls for."},
  // Claude Code Configuration
  {"d":"Claude Code Configuration","q":"Your agent applies changes through the file editing tools, and you want a formatting script to run every time one of those edits completes successfully. Which hook event should the script be registered on?","o":["PreToolUse, which runs before the edit is applied and so cannot examine a file that has not been written yet","PostToolUse, which runs once a tool call has completed successfully and can examine what the edit produced","A standing instruction in CLAUDE.md, which is loaded at session start rather than on tool completion","The allowed-tools frontmatter of a skill, which pre-approves the tools it lists rather than causing anything to run afterwards"],"a":1,"e":"PostToolUse is the event that fires after a tool call has completed, which is what a formatting script needs: the file has to exist before it can be formatted. PreToolUse is a real event and the guide's tool call interception mechanism, but it runs before the edit is applied, so the file it would format has not been written yet; blocking a call is a different job from acting on its result. A standing instruction in CLAUDE.md is Task 3.1 configuration that is loaded into context at the start of a session, so nothing about it is bound to the completion of a tool call. The allowed-tools frontmatter is Task 3.2 skill configuration that grants rather than narrows: it pre-approves the tools it lists for the turn that invokes the skill, so Claude may use them without a permission prompt, while tools it does not list stay available under the usual permission settings. Either way it is declarative configuration read when a skill is invoked, so nothing about it causes anything to run once an edit completes."},
  {"d":"Claude Code Configuration","q":"A Claude Code settings.json lists several specific Bash commands in the permissions allow array. In the default permission mode, Claude proposes a Bash command that none of those entries covers. What happens?","o":["Claude Code refuses to run the command, because adding any allow rule closes the session to the entries named on that list and blocks everything else","Claude Code stops and asks the developer to approve it, because an allow rule grants automatic approval and does not deny what it omits","Claude Code runs it without a prompt, because an allow entry for one Bash command grants automatic approval across that whole tool","Claude Code has the model judge whether it is close enough to an allowed command, and runs it whenever the model decides that it is"],"a":1,"e":"An allow rule is an automatic-approval rule rather than a boundary. It lets the command it names run without a prompt, and a command that no entry covers falls through to the ordinary permission prompt, where the developer approves or declines it. The mode that denies whatever has not been pre-approved is dontAsk, and the rule that stops a command outright is a deny rule, evaluated ahead of ask and ahead of allow so that no later allow entry can reopen it. An allow entry also covers the pattern it names rather than the whole tool, so permitting one Bash command does not quietly permit the rest. Permission rules are enforced by Claude Code itself rather than by the model, so nothing is admitted on a judgement that it resembles something already allowed."},
  {"d":"Claude Code Configuration","q":"A developer is working out how request logging is wired through an unfamiliar service before adding a field to it. Reading the files involved has already taken up much of the session, and the change itself still has to be made in the same conversation. Which approach keeps room available for it?","o":["Run /compact once the reading is finished, so that everything gathered while working through the service is condensed before the change is attempted","Hand the reading to the Explore subagent, which works through the service in its own context and returns a summary to the main session","Open plan mode before the reading starts, so the wiring is investigated and an approach is agreed ahead of any code change","Set context: fork on the skill being used, so its work is carried out by an isolated sub-agent rather than in the main conversation"],"a":1,"e":"The Explore subagent carries out a verbose discovery phase in its own context and returns a summary, so the files it opens never enter the main conversation and the room they would have taken stays available for the work that follows. Running /compact is a real mechanism aimed at the wrong point in the sequence: it reclaims context after the reading has already been spent, and what it condenses away is the detail the change still depends on. Plan mode defers edits until an approach is settled, but the investigating it does is read into the same session, so the cost of discovery is unchanged. The context: fork setting isolates the output of a skill and belongs in SKILL.md frontmatter, and no skill is being invoked here."},
  {"d":"Claude Code Configuration","q":"A new team member reports that Claude Code isn't following the project's coding conventions. The conventions are defined in ~/.claude/CLAUDE.md. What's the likely issue?","o":["The conventions are loaded but truncated: a CLAUDE.md is read only to its first two hundred lines, so a long conventions file is cut off before the section the teammate needs is reached","User-level settings in ~/.claude/CLAUDE.md apply only to that user and are not shared with teammates via version control: the conventions should be in a project-level CLAUDE.md","Move the conventions into ~/.claude/rules/ as a path-scoped rule file, since rules with a paths pattern load ahead of any CLAUDE.md and apply across every project on the machine","CLAUDE.md is context rather than enforced configuration: an instruction that must hold every time belongs in a hook"],"a":1,"e":"The CLAUDE.md hierarchy has three levels: user-level (~/.claude/CLAUDE.md) for personal settings not shared with teammates, project-level (.claude/CLAUDE.md or root CLAUDE.md) shared via version control, and directory-level for subdirectory-specific rules. Team conventions belong at the project level."},
  {"d":"Claude Code Configuration","q":"A developer wants their own version of the team's /audit skill, carrying two extra checks that only they care about. The team's skill is checked into the repository and other contributors rely on it as it stands. What should the developer do?","o":["Add a variant under ~/.claude/skills/ under a name of its own, where it reaches that developer alone and the team's copy in the repository is untouched","Edit the team's SKILL.md in .claude/skills/ and leave that file permanently unstaged, so the two extra checks never reach a commit that other contributors pull","Set context: fork on the team's SKILL.md, so the two extra checks run in an isolated sub-agent and their output stays clear of other contributors' sessions","Copy the team's SKILL.md into the developer's own ~/.claude/CLAUDE.md, so the two extra checks load in each of their sessions without the repository changing"],"a":0,"e":"A personal variant belongs in the user-scoped skills directory under a name of its own: it applies to that developer, it is never committed, and the team's skill keeps working unchanged for everyone else. Leaving a tracked file permanently unstaged does not create a variant at all, it edits the shared skill and leaves the working tree permanently dirty, so any checkout or broad add undoes it. context: fork is a real frontmatter option aimed at a different problem, keeping a verbose skill's output out of the main conversation, and it governs where output goes rather than which people a skill reaches. CLAUDE.md holds instructions and context rather than skill definitions, so pasting a SKILL.md into it does not give the developer a skill they can invoke by name."},
  {"d":"Claude Code Configuration","q":"You need to choose between putting team conventions in CLAUDE.md (always loaded) versus a custom skill (on-demand). When should you use a skill?","o":["Use a skill when the convention must be enforced rather than suggested, since a skill runs deterministically and CLAUDE.md is advisory","Use skills for task-specific workflows invoked on-demand, and CLAUDE.md for universal standards that should always be active","Use a skill whenever the guidance is long, since a skill's body is summarised into the session while CLAUDE.md is loaded in full","Use a skill when the rule changes often, so edits do not disturb CLAUDE.md"],"a":1,"e":"CLAUDE.md is for always-loaded universal standards (naming conventions, code style rules). Skills are for task-specific workflows invoked on-demand (generating boilerplate, running specific analysis patterns). The distinction is always-active vs on-demand."},
  {"d":"Claude Code Configuration","q":"Your CI pipeline needs Claude Code to produce machine-parseable structured output for posting as inline PR comments. What flags should you use?","o":["--output-format json on its own, since the schema is taken from the shape of the first response and applied to every later response in the run","--output-format json with --json-schema to produce machine-parseable structured findings for automated posting as inline PR comments","--output-format text together with --json-schema, which wraps the free-form answer in the schema once the run completes","--json-schema on its own from an interactive session, so the run returns validated objects for the pipeline to post"],"a":1,"e":"The --output-format json and --json-schema CLI flags enforce structured output in CI contexts. This produces machine-parseable findings that can be automatically posted as inline PR comments, rather than free-form text that would be difficult to process programmatically."},
  {"d":"Claude Code Configuration","q":"A developer adds a /changelog entry point and it works for them every time. Another contributor on the same project does not see it at all. What best explains that?","o":["It was written into the project's CLAUDE.md, which supplies Claude Code with context and instructions rather than with definitions of this kind","The contributor's user-level CLAUDE.md takes precedence over the project's configuration and is holding the project-scoped entry out of their menu","It was created under ~/.claude/commands/, which is scoped to its author and is never carried to anyone else by the repository itself","It depends on a server declared in the project's .mcp.json which the contributor has not approved, so it stays unavailable on their machine"],"a":2,"e":"User-scoped entries live in the author's home directory and are never version-controlled, which is exactly the pattern described: the author holds the file locally so it works for them, and nothing carries it across to anybody else. The other three explanations all fail the part of the scenario that says it works for the author. Something written into CLAUDE.md would not be invocable for anyone, since that file carries context rather than definitions. Configuration precedence is real but it settles which instructions win, not what appears in a menu, and it would not spare the author either. MCP servers are configured in .mcp.json and supply tools, so one left unapproved is not what makes /changelog invisible."},
  {"d":"Claude Code Configuration","q":"A team asks Claude Code to normalise the postal addresses in a supplier catalogue, and each round comes back in a different shape. They rewrite the instruction at greater length and the output stays inconsistent. What should they supply instead?","o":["A fuller written specification of the address rule, on the grounds that the inconsistency shows the earlier wording still left too much room for interpretation","Two or three worked pairs showing a sample address exactly as supplied and exactly as it should come back, so the intended shape is unambiguous","The address rule recorded in CLAUDE.md, so that every later session loads it rather than depending on what was said in conversation","A round of questions from Claude Code about the awkward addresses, so the considerations behind the rule surface before the next attempt"],"a":1,"e":"Worked input and output pairs are the most effective way to communicate an expected transformation when a written description is being interpreted inconsistently, because they show the intended result rather than describing it. Lengthening the description is the move the scenario has already tried, and a longer wording carries the same ambiguity in more words. Recording the rule in CLAUDE.md changes when the instruction is loaded rather than how precisely it reads, and the instruction is already reaching the model. The interview pattern surfaces considerations nobody has anticipated in an unfamiliar domain, which is a different problem: here the required shape is already known and simply has to be stated without ambiguity."},
  {"d":"Claude Code Configuration","q":"A monorepo's standards have grown large enough that loading all of them at the start of every session measurably reduces the room left for the work itself. Which property of a .claude/rules/ file with a paths field addresses that?","o":["Running /compact once the standards are no longer being consulted reclaims the room they occupy, so a long session recovers the space partway through","Referencing each standards file from its own package's CLAUDE.md with @import, so that package's file carries only the standards its maintainers need","Splitting the standards into separate skills, so that each set is loaded at the point a developer invokes it by name and at no other time","Its rules are read in only while a file its glob matches is being edited, so a session that never opens such a file never carries them at all"],"a":3,"e":"A paths field makes a rule conditional on what is being edited, so the cost of a standards file is paid only in the sessions that touch the files it governs and a session working elsewhere carries none of it. The three wrong answers are all real mechanisms doing something else. /compact reduces context that has already accumulated, which recovers room after the cost has been paid rather than avoiding it. @import genuinely keeps a CLAUDE.md modular and is the right answer to a different task statement, but it divides the standards by package rather than making any of them conditional, and a package's own file still loads in full. Skills are invoked on demand, which is the wrong shape for standards that have to apply whether or not somebody remembers to ask for them."},
  {"d":"Claude Code Configuration","q":"An infrastructure-as-code repository has Terraform files spread across dozens of service directories. Which two reasons make a .claude/rules/ file with paths: [\"terraform/**/*\"] a better fit than a directory-level CLAUDE.md for enforcing Terraform conventions?","o":["The glob pattern matches every Terraform file by name pattern regardless of which service directory it lives in, while a directory-level CLAUDE.md only covers one directory","Terraform conventions only enter context when a Terraform file is actually being edited, instead of loading for every file in whichever directories happen to contain Terraform","A .claude/rules/ glob pattern is matched against the absolute filesystem path, so the same paths: [\"terraform/**/*\"] pattern behaves differently depending on where the repository is cloned on disk","A directory-level CLAUDE.md automatically cascades into every subdirectory beneath it, so one placed in terraform/ would already cover every nested service directory",".claude/rules/ files are loaded with higher priority than any CLAUDE.md file, regardless of directory depth"],"a":[0,1],"type":"mr","e":"This is the guide's own stated advantage — glob rules apply to files by type regardless of directory location, while directory-level CLAUDE.md only affects files in that specific directory (Task 3.3 Knowledge and Skill); the token-usage benefit follows from the same conditional loading (Task 3.3 Knowledge). Claiming the glob pattern is matched against the absolute filesystem path misdescribes the matching mechanism: paths in .claude/rules/ frontmatter are matched relative to the project root, so the same pattern behaves identically regardless of where the repository is cloned. Claiming a directory-level CLAUDE.md cascades into every nested service directory misdescribes its scope, which is confined to its own directory. Claiming .claude/rules/ files load with higher priority than any CLAUDE.md file invents a precedence rule the guide never states — the real advantage is about scope, not precedence."},
  // Prompt Engineering & Structured Output
  {"d":"Prompt Engineering & Structured Output","q":"A legal document review system uses Claude to summarize long contracts in multi-turn conversations. After 20 turns, summaries become less accurate. What is the most effective strategy?","o":["Start a new conversation every five turns and re-paste the contract text at the top of each one, so the model always works from the source document rather than an accumulating history","Implement a summarization strategy where earlier conversation turns are progressively summarized while keeping the most recent turns and critical case facts in full","Enable context editing so the oldest turns are cleared once the input passes its trigger threshold: the cleared turns are summarized in place, so nothing is lost","Raise max_tokens on each request so the model has room to restate the full contract in every summary"],"a":1,"e":"Progressive summarization compresses older turns while keeping recent turns and critical facts in full detail. This manages the context window effectively without losing important information. Simply starting new conversations loses context, while trying to keep everything in full will eventually exceed the context window."},
  {"d":"Prompt Engineering & Structured Output","q":"Your extraction prompt says 'extract the relevant information.' Claude produces inconsistent output formats across different documents. What's the most effective fix?","o":["Add a validation step that checks each extraction against the schema and resends the document with the errors attached, leaving the vague instruction in place","Add 2-4 few-shot examples that demonstrate the exact desired output format, including handling of ambiguous cases and varied document structures","Expand the instruction into a detailed prose specification of the expected fields, their order and their formatting, without showing a worked example","Set tool_choice to any, since forcing a tool call is what makes the returned output conform to a fixed format"],"a":1,"e":"Few-shot examples are the most effective technique for achieving consistently formatted, actionable output when detailed instructions alone produce inconsistent results. Examples demonstrate the exact format and show how to handle edge cases like ambiguous inputs and varied document structures."},
  {"d":"Prompt Engineering & Structured Output","q":"Your pipeline has a pre-merge code check that blocks merging. Should you use the synchronous API or the Batches API?","o":["The Batches API, since most batches finish in under an hour and one that has not returned can be cancelled and re-sent synchronously without losing the fifty percent discount","Synchronous API: blocking workflows like pre-merge checks require guaranteed latency, which the batch API cannot provide with its up-to-24-hour processing window","The Batches API with the check moved to a scheduled nightly run, so the merge is gated on the previous night's result rather than on the diff actually being merged","Either, since batch results stay retrievable for twenty-nine days after creation and the check can read whichever result finished first"],"a":1,"e":"Blocking workflows like pre-merge checks need guaranteed latency — developers can't wait up to 24 hours for results. The synchronous API provides immediate responses. The Batches API is appropriate for non-blocking workloads (overnight reports, weekly audits, nightly test generation)."},
  {"d":"Prompt Engineering & Structured Output","q":"You are designing the review architecture for a service where a typical change touches several modules and also the data that moves between them. How should the review passes be arranged?","o":["Order the modules by how much of the change each one carries and review the largest first, so the closest reading lands where most of the edit sits","Run a local analysis pass over each module on its own, then a separate integration pass whose subject is the data crossing module boundaries","Run one pass per module and take the union of their findings as the finished review, since every line of the change is then read by exactly one pass","Have the session that wrote the change carry out the review, since it already holds the reasoning behind each module and needs no integration pass"],"a":1,"e":"Splitting the work into per-module local passes plus a separate pass for what crosses module boundaries is the architecture the guide describes, and it is the arrangement that gives each module a full reading while still leaving something responsible for the data flow between them. Ordering by size is a real triage habit that changes which module is read first and nothing about whether the boundaries are read at all. Taking the union of per-module passes covers every line and still misses every interaction, because an inconsistency between two modules belongs to neither pass on its own. Handing the review to the session that produced the change is the least effective option available: a session retains its own reasoning from writing the code and is correspondingly unlikely to question decisions it has already committed to."},
  {"d":"Prompt Engineering & Structured Output","q":"Your extraction pipeline encounters a document with inconsistent source formatting — dates appear as 'Jan 5', '01/05/2024', and '2024-01-05' in different sections. How should you handle this?","o":["Reject documents whose internal formatting is inconsistent and route them to manual entry, so the extraction schema only ever sees sources that already agree with it","Include format normalization rules in prompts alongside strict output schemas, so the model normalizes varied source formats into the schema's expected format","Extract the first date style encountered in each document and apply that pattern to the rest, so one document never yields more than one representation","Set a strict output schema and rely on it to coerce the varied source formats, since schema validation rejects any value that does not match the declared type"],"a":1,"e":"Including format normalization rules in prompts alongside strict output schemas handles the common reality of inconsistent source formatting. The model is instructed how to normalize varied formats (different date styles, measurement units) into the schema's expected consistent format."},
  {"d":"Prompt Engineering & Structured Output","q":"You design a self-correction validation flow that extracts both calculated_total and stated_total from invoices. Why extract both?","o":["Capturing both gives the extraction a second field to fall back on when one is missing from the document, so a torn or partially scanned invoice still yields a usable total for the ledger","Extracting both allows flagging discrepancies: adding a conflict_detected boolean identifies inconsistent source data where the stated total doesn't match calculated line items, preventing silent errors","Requiring two numeric fields makes the model recompute the arithmetic while generating, and that recomputation is what raises accuracy above a single-field extraction","Storing the stated and the derived figure separately preserves what the document said alongside what was computed from it, which is what an audit needs when a total is challenged months after the invoice was filed"],"a":1,"e":"Extracting calculated_total (sum of line items) alongside stated_total enables automatic detection of inconsistent source data. A conflict_detected boolean flags when they don't match, alerting downstream systems to potential errors in the source document rather than silently passing incorrect data."},
  {"d":"Prompt Engineering & Structured Output","q":"Your application instructs Claude in the system prompt to return only a JSON object. The model produces valid JSON but adds commentary after it. A migration to tool use is scheduled for a later release, so the fix has to work with the current prompt-based call. What additional technique should you use?","o":["Set max_tokens to limit the response length","Add stop_sequences to stop generation after the JSON closes (e.g., a trailing newline)","Add 'return only JSON' to the prompt","Switch the call to tool use with a JSON schema, so the object arrives without trailing commentary"],"a":1,"e":"Setting stop_sequences, for example a blank line after the JSON, precisely controls where Claude stops generating and prevents post-JSON commentary. It pairs with a system prompt format instruction for clean structured output extraction. Tool use with a JSON schema is the most reliable route to structured output and Task 4.3 names it as such, but it replaces the prompt-based call rather than adding to it, and the stem holds that migration to a later release. Capping max_tokens truncates at an arbitrary point and can cut the JSON itself, and restating the instruction in the prompt does not bound where generation stops."},
  {"d":"Prompt Engineering & Structured Output","q":"A support pipeline extracts a structured case record from each incoming ticket, and the returns policy is applied automatically from the purchase date the record carries. Many tickets never state a purchase date. Every field in the schema is required, and the model supplies a plausible date when the ticket is silent, placing some cases inside the returns window and others outside it. What is the correct fix?","o":["Add a validation step that checks the extracted purchase date against the order record and rejects the record when the two disagree","Change the purchase date to a free-text string so the model can record whatever the ticket says, including that no date was given","Make the purchase date field optional and nullable, and define null as the signal that the ticket did not state a date","Route any case record whose purchase date falls near the edge of the returns window to a human reviewer before the policy is applied"],"a":2,"e":"A required field pressures the model to produce a value where the source contains none, and here the invented value is not merely inaccurate data sitting in a record, it is the input a policy decision runs on. Making the field nullable and defining null as the absence signal removes the pressure and lets the pipeline see that the ticket was silent, which is the condition the policy step actually needs to branch on. Checking the extracted date against the order record is real validation work, but it repairs the output after fabrication has already happened and only catches cases where an order record exists to disagree with. Free text keeps a value flowing while removing the contract that makes the field usable downstream, so the policy step is left parsing prose. Routing edge cases to a human reviewer is a sound way to spend limited review capacity, and it addresses uncertainty about a date that was genuinely extracted rather than a date that was never in the ticket at all."},
  {"d":"Prompt Engineering & Structured Output","q":"You need Claude to extract up to five key claims from a document. Sometimes there are fewer than five claims. What output schema handles this correctly?","o":["A required array field with exactly 5 elements: fill with empty strings if fewer claims exist","An optional array field with a minimum of 0 and maximum of 5 elements","A single string field with claims separated by newlines","Five separate optional string fields: claim_1 through claim_5"],"a":1,"e":"An optional array with a bounded size (0–5 elements) is the semantically correct schema for 'up to N items.' It accommodates variable counts without forcing empty-value padding. Five separate named fields are awkward to iterate over; a string with newlines loses structure; a fixed 5-element array forces fabrication when fewer claims exist."},
  {"d":"Prompt Engineering & Structured Output","q":"You are extracting dates from documents in many different formats (14/05/2026, May 14 2026, 2026-05-14). Your output schema requires ISO 8601 format (YYYY-MM-DD). What prompt instruction ensures consistent normalisation?","o":["Tighten the output schema and rely on strict mode to reject any value that is not already ISO 8601, on the assumption that a rejected date makes the model convert rather than restate it","Add an explicit normalisation instruction: 'Extract all dates and convert them to ISO 8601 format (YYYY-MM-DD) regardless of the format they appear in the source'","Add a validation-retry loop that resends the document with the failed extraction and the specific format errors attached, so each local-format date costs a second call","Normalise after extraction in application code, with a parser covering each format the corpus has produced so far"],"a":1,"e":"An explicit normalisation instruction tells the model what to do when it encounters any date format, not only the ones the corpus has produced so far. A parser applied after extraction handles the formats it was written for and breaks on new ones. A strict output schema rejects a value that is not already ISO 8601 but converts nothing itself, so a rejected date comes back rejected rather than normalised. A validation-retry loop corrects each document after the fact and leaves the prompt still saying nothing about the target format. The instruction approach generalises to all formats the model can parse."},
  {"d":"Prompt Engineering & Structured Output","q":"Your validation-retry loop appends the specific validation error to the prompt and asks Claude to correct a failed extraction. Which two statements correctly describe when this approach will succeed and when it will not?","o":["It will succeed when the failure is a format or structural mismatch, since the model can correct its output once the specific error is pointed out","It will fail when the required value is simply absent from the source document, since no amount of retrying invents data that was never there","It becomes more reliable purely by attempting more retries, so a value that fails on a third attempt will typically appear by a tenth attempt","It is fixed by making the missing field optional and nullable in the schema, which is a schema design change rather than a property of the retry loop itself","It is fixed by raising max_tokens on the retry request, giving the model more room to locate the missing value"],"a":[0,1],"type":"mr","e":"The two correct statements mark the boundary the guide draws: retry-with-feedback works on failures the model can act on, and fails on information that is not there. A format or structural mismatch succeeds, because naming the specific error gives the model something to correct. A value genuinely absent from the source document fails, because no amount of retrying invents data that was never there. The wrong answers all sit on the far side of that boundary. Claiming the loop grows more reliable purely with attempt count is a false behaviour claim — if the data is not in the document, the tenth attempt fails exactly as the third did. Making the missing field optional and nullable is a real Task 4.3 fix at the wrong scope: it is a schema design decision, not a property of the retry loop itself. Raising max_tokens misapplies a real API parameter — it controls output length, not whether the information exists to extract."},
  // Tool Design & MCP Integration
  {"d":"Tool Design & MCP Integration","q":"In a tool_result message, how should you handle a large result that might consume too many tokens?","o":["Return the full result with a summary of its key values placed at the start of the message, so that position effects do not bury the fields that matter","Trim or summarize the tool result to include only the most relevant information, potentially with a note that the full result was truncated","Return isError with a message that the payload was too large, since the model reads that as a signal to reissue a narrower query","Split the result across several tool_result blocks so that no single message carries all of it"],"a":1,"e":"Large tool results should be trimmed or summarized to include only the most relevant information. Returning full results for large data sets wastes context window space and can push important information out of the model's attention. Including a note about truncation helps the model know that more data exists if needed."},
  {"d":"Tool Design & MCP Integration","q":"A project configuration lists three MCP servers: one for Jira, one for an internal search index, and one for a metrics warehouse. A developer believes only one server can be attached at a time and writes a helper that rewrites the configuration before each task so a single server is left in place. What does that helper misunderstand?","o":["Server scope governs which developers a server reaches, so moving all three into the user-level configuration would attach them without any rewriting","Tools from every configured MCP server are discovered when the session connects, so all three servers offer their tools to the agent at once","Environment variable expansion supplies each server's credentials at connection time, so the rewriting is only needed to stop the three tokens colliding","Exposing the three servers' catalogs as MCP resources would show the agent what data exists without any of the servers needing to be attached"],"a":1,"e":"All configured MCP servers are discovered at connection time and their tools are available to the agent simultaneously, so nothing has to be swapped out and the helper is solving a problem that does not exist. Scope is a real distinction but it decides who receives a server, project-level for shared tooling against user-level for personal ones, not how many can be connected. Environment variable expansion is the documented way to keep credentials out of a committed file and has no bearing on how many servers attach. Resources do expose content catalogs to reduce exploratory tool calls, but they are served by a connected server rather than replacing the connection. Current Claude Code releases enable MCP tool search by default, loading only tool names and server instructions at session start and deferring the full tool definitions from each server until Claude needs them."},
  {"d":"Tool Design & MCP Integration","q":"A tool query returns zero results. The agent treats this as an error and retries repeatedly. How should the tool differentiate between 'no results found' and 'query failed'?","o":["Return isError: true for both cases and let the agent read the message text, since retry logic is driven by the message body rather than by the flag and an empty-result string will not trigger one","Return successful responses with empty results for valid queries with no matches, and error responses with isError: true for actual failures; this prevents wasted retry attempts","Include the number of matches in the response body and have the agent branch on it, so an empty set and a failure are told apart after the call rather than by the response type","State in the tool description that an empty list means no matches, so the model learns to stop retrying from the schema rather than from the response"],"a":1,"e":"Distinguishing between access failures (needing retry decisions) and valid empty results (representing successful queries with no matches) prevents the agent from wasting retries on successful-but-empty queries. The tool should return success with empty data vs error with failure details."},
  {"d":"Tool Design & MCP Integration","q":"You have a generic analyze_document tool that handles extraction, summarization, and fact-checking. It often produces mixed-quality results. What's the better design?","o":["Keep the single tool but add a required 'task' enum with values for extraction, summarization and fact-checking, so the model states which mode it wants and the server branches on that value","Split the generic tool into purpose-specific tools: extract_data_points, summarize_content, and verify_claim_against_source, each with defined input/output contracts","Register the tool through an MCP server so the three behaviours are exposed as separate resources: the model reads them before it calls anything","Raise the model's max_tokens for the tool's calls, since truncation is what degrades extraction and summarization output on longer documents"],"a":1,"e":"Splitting generic tools into purpose-specific tools with defined input/output contracts improves reliability. Each focused tool (extract_data_points, summarize_content, verify_claim_against_source) can have clear expectations, making selection more reliable and results more consistent."},
  {"d":"Tool Design & MCP Integration","q":"The Edit tool fails because the old_string you provided matches multiple locations in the file. What's the correct fallback?","o":["Re-issue the same edit with replace_all enabled, since that flag resolves the ambiguity by applying the change to the first match it encounters and leaving the remaining occurrences in the file untouched","Provide a larger string with more surrounding context to make it unique, or use Read to load the full file contents followed by Write as a fallback for reliable file modifications","Split the change into one edit per occurrence and apply them in sequence, so each call matches a single location and the ambiguity never arises","Read the file first to establish its current state and then re-run the identical edit, since the failure is a stale-file error rather than an ambiguous match"],"a":1,"e":"When Edit fails due to non-unique text matches, you have two options: provide a larger old_string with more surrounding context to make it unique, or fall back to Read (load full file) + Write (rewrite with changes) for reliable modifications."},
  {"d":"Tool Design & MCP Integration","q":"You need to provide a scoped cross-role tool to a synthesis agent — specifically a verify_fact tool — while keeping the agent focused on synthesis. How should you configure this?","o":["Give the synthesis agent the full tool set and rely on its system prompt to say which tools are in scope: the model then makes the selection itself at call time","Provide the synthesis agent with its core synthesis tools plus the verify_fact tool as a limited cross-role tool, while routing complex fact-checking cases through the coordinator","Keep the synthesis agent tool-free and have the coordinator verify each claim before the findings are handed over for synthesis","Spawn a dedicated verification subagent for every claim the synthesis agent produces, and have the coordinator merge the returned verdicts into the draft before the synthesis is handed back to the caller"],"a":1,"e":"Scoped cross-role tool access means giving agents their primary tools plus limited cross-role tools for specific high-frequency needs. The synthesis agent gets verify_fact for quick checks, while complex cases are still routed through the coordinator to the dedicated verification subagent."},
  {"d":"Tool Design & MCP Integration","q":"An agent is asked which parts of a service still depend on a legacy date utility. The utility is re-exported through two wrapper modules under different names, so a search for the original function name finds only a fraction of the call sites. Which approach locates all of them?","o":["Identify every name the utility is exported under, the wrapper aliases included, then search the codebase for each of those names in turn","Grep for import statements that name the utility's module path, on the basis that any file depending on the utility has to name that path where it imports","Glob for every file under the utility's module directory and read each one to see which of them call the function directly","Read the utility's source in full and follow the imports it declares outward until the modules that depend on it have been reached"],"a":0,"e":"Tracing usage across wrapper modules means first establishing the full set of exported names and then searching for each one, because a dependent that imports an alias never mentions the original name anywhere. Searching for the module path fails for the same reason: a file importing from a wrapper references the wrapper's path, not the utility's. Glob matches files by path pattern and the dependents are scattered outside that directory, so listing the module's own folder returns the wrong set. Following the utility's own imports runs the dependency the wrong way, since a module's imports are what it relies on rather than what relies on it."},
  {"d":"Tool Design & MCP Integration","q":"You want to expose your team's Jira project data to Claude Code through MCP. Your team already uses a standard Jira workflow. Should you build a custom MCP server or use an existing community server?","o":["Always build custom for better control and security","Use an existing community MCP server for standard integrations like Jira; reserve custom servers for team-specific workflows","Expose Jira as an MCP prompt run from the slash menu, since prompts are discovered from connected servers and need no server of their own","Configure Jira access through CLAUDE.md instructions"],"a":1,"e":"For standard integrations like Jira, existing community MCP servers are preferred over custom implementations. They're battle-tested and maintained. Reserve custom MCP server development for team-specific workflows that don't have community solutions. MCP prompts are surfaced by servers that are already connected, so they cannot stand in for the server itself, and CLAUDE.md can't provide API access, so configuring access through it is also wrong."},
  {"d":"Tool Design & MCP Integration","q":"An MCP tool call to a downstream service fails. The tool currently returns the generic message 'Operation failed' with no further detail. What change to the error response most improves the agent's ability to recover?","o":["Set the MCP isError flag on the response and leave the message text exactly as it is, since the flag is what tells the agent a call failed and the text is only ever surfaced to the user","Return structured error metadata (an errorCategory of 'transient', an isRetryable: true flag, and a human-readable description) so the agent can decide whether to retry","Retry the call three times inside the tool before returning, so the agent sees a failure only when the service is genuinely down and the message it gets can stay as it is","Append the downstream service's HTTP status code to the message so the agent can look up what went wrong"],"a":1,"e":"Generic error messages like 'Operation failed' prevent the agent from making an appropriate recovery decision. Structured error metadata — categorizing the failure as transient, validation, business, or permission, with an isRetryable flag and a clear description — lets the agent decide whether to retry, fix its input, or escalate. Suppressing the error as an empty 'success' result hides the failure entirely and is a documented anti-pattern."},
  {"d":"Tool Design & MCP Integration","q":"You are designing a tool schema for a function that accepts a start date and end date for a report. What input validation should the schema enforce?","o":["Accept both dates as free-text strings and validate the ordering inside the tool implementation instead, returning an errorCategory of validation when end_date falls before start_date","Define both as ISO 8601 date strings with format validation, and add a constraint that end_date must be after start_date in the description or using schema constraints","Declare both as plain strings and rely on strict mode to reject a range whose end falls before its start, since strict validation covers semantic constraints as well as syntax","Take a single 'date_range' string such as '2026-01-01 to 2026-03-31' and split it inside the tool, keeping the parameter count down"],"a":1,"e":"Schema-level validation (ISO 8601 format) prevents format ambiguity and reduces parsing errors. Documenting the end > start constraint in the description gives the model the semantic rule it needs to call the tool correctly. Accepting free-text shifts validation burden to application code and allows the model to produce hard-to-handle edge cases."},
  {"d":"Tool Design & MCP Integration","q":"Your legal-tech agent has a process_document tool whose entire description reads 'Analyzes data.' The agent almost never selects it correctly. Which two additions would most directly fix this?","o":["State the tool's expected input format and give a concrete example query showing a realistic call","State the boundary that explains when to use this tool instead of other document-related tools available to the agent","Add a routing layer that inspects the user's message for legal keywords and pre-selects the tool before the model reasons about it","Reduce the agent's overall tool count to fewer than 5, since fewer tools always select more reliably","Increase the tool's max_tokens limit so its response has room to include more detail"],"a":[0,1],"type":"mr","e":"Stating the input format plus example query, and separately stating a boundary explanation, are independent elements from Task 2.1's account of description quality. Pre-selecting the tool with a keyword-based routing layer is the Task 1.1 pre-configured decision-tree anti-pattern applied to tool selection. Reducing the agent's overall tool count misapplies Task 2.3's tool-count principle at the wrong scope and overstates it as absolute. Increasing the tool's max_tokens limit misuses a real API parameter (output length) for a selection problem it can't affect."},
  // Context Management & Reliability
  {"d":"Context Management & Reliability","q":"A SaaS platform uses Claude to serve multiple customers. How should they ensure that one customer's data never leaks into another customer's context?","o":["Rely on the system prompt to state that each request concerns a single named customer and that data about any other customer must not be referenced, so the boundary is enforced by instruction at the top of every call","Implement strict multi-tenant isolation: each customer's requests must be completely separate API calls with no shared conversation history, and validate that no cross-customer data is included in any context","Issue a separate API key per customer so requests are attributable and rate-limited per tenant, keeping billing and quota boundaries aligned with the customer boundary","Batch several customers' requests into one conversation and instruct the model to answer each in a separately labelled section, cutting per-call overhead"],"a":1,"e":"Multi-tenant isolation requires that each customer's API calls are completely separate with no shared conversation history or context. Each request should only contain data belonging to that specific customer. Input validation should verify no cross-customer data leaks into contexts. API key separation alone is insufficient without proper data isolation."},
  {"d":"Context Management & Reliability","q":"In Claude API pricing, output tokens are significantly more expensive than input tokens. How should this affect your design decisions?","o":["Shift the work to the input side: trim the system prompt, drop redundant few-shot examples and compress retrieved context before each call, since the prompt is where token volume actually accumulates and a trimmed prefix pays back on every request that reuses it","Design prompts and max_tokens settings to minimize unnecessary output. Use structured output formats that are concise, set appropriate max_tokens limits, and avoid prompts that encourage verbose responses for cost-sensitive applications.","Enable prompt caching so the cache discount applies to generated tokens as well as the prefix, which brings the output rate down to the cached input rate for any request shape that repeats often enough to stay warm","Route anything that tolerates delay through the Message Batches API, which processes non-urgent work at a reduced rate and is the standard lever for lowering spend on bulk workloads"],"a":1,"e":"Since output tokens cost more than input tokens, cost-optimized designs should minimize unnecessary output. Using concise structured formats (like JSON instead of verbose explanations), setting appropriate max_tokens limits, and designing prompts that encourage concise responses can significantly reduce costs without sacrificing quality."},
  {"d":"Context Management & Reliability","q":"Your production Claude application experiences intermittent failures. What observability setup should you have in place?","o":["Alert on 429 and 529 responses alone, since intermittent production failures are rate limiting by definition and any other error class points to a fault in your own application code rather than in the API itself","Implement comprehensive monitoring including API response times, error rates by type, token usage per request, cost tracking, model output quality metrics, and alerting for anomalies","Subscribe to the provider's status feed and alert on it, since intermittent failures originate upstream and surface there earlier than in your own error rates","Track monthly spend and request volume per environment, since a cost anomaly is the earliest visible symptom of an intermittent failure loop"],"a":1,"e":"Comprehensive observability should include API response times, error rates categorized by type (429s, 500s, timeouts), token usage per request, cost tracking, and output quality metrics. Alerting on anomalies enables rapid detection and response to issues like degraded model performance, rate limiting spikes, or unexpected cost increases."},
  {"d":"Context Management & Reliability","q":"A high-availability system using Claude needs to handle API outages gracefully. What pattern should be implemented?","o":["Wrap every call in exponential backoff with jitter and raise the maximum attempt count, so the system rides out the failure by retrying harder rather than by adding failure-handling machinery","Implement circuit breaker patterns with graceful degradation: stop sending requests once the API is detected down, and serve cached responses or fallback functionality until it recovers","Add a health-check endpoint that polls the API on a short interval and pages the on-call engineer when it fails, so a human decides whether to disable the feature for the duration","Route requests through a load balancer across regional endpoints, since regional failover absorbs provider outages transparently while the remaining regions continue serving normally"],"a":1,"e":"Circuit breaker patterns detect API failures and stop sending requests to prevent cascading failures. Graceful degradation provides fallback functionality (cached responses, simplified non-AI features) so users still get value during outages. Automatic recovery detection restores normal operation when the API comes back."},
  {"d":"Context Management & Reliability","q":"When handing off context between agents in a multi-agent system, what's the most important consideration?","o":["Subagents inherit the parent's conversation history automatically, so the handoff should trim that history to the last few turns and leave the subagent's context window free for its own work","Ensure all relevant context is explicitly included since subagents do not inherit parent context automatically: include findings, constraints, and quality criteria in the handoff","Pass a pointer to the shared workspace (the branch name, the file paths and the ticket) and let the subagent re-read what it needs and reconstruct the parent's conclusions itself","Give every agent in the chain the same model and sampling settings, since a handoff fails when the receiver reasons differently from the sender"],"a":1,"e":"Subagents operate with isolated context and do not inherit the parent agent's conversation history. Every piece of relevant information — prior findings, constraints, quality criteria — must be explicitly included in the handoff prompt for the subagent to work effectively."},
  {"d":"Context Management & Reliability","q":"Your agent processes customer requests but occasionally provides different responses to identical queries. What reliability technique helps ensure consistent behavior?","o":["Set temperature to 0, which makes the API return a deterministic response for identical inputs: the same request will produce a byte-identical completion on every call regardless of when it is made","Implement structured prompts with explicit decision criteria and few-shot examples, combined with validation checks that verify responses meet defined standards before returning them to users","Log every request and response with a trace identifier so divergent outputs can be found after the fact and replayed against a revised prompt version","Route all of a customer's requests through a single long-lived conversation so the model can see how it answered earlier and match its own precedent"],"a":1,"e":"Consistency requires structured prompts with clear decision criteria (so the model reasons the same way each time), few-shot examples (so it follows established patterns), and validation checks (so inconsistent responses are caught before reaching users). Temperature alone doesn't guarantee consistency."},
  {"d":"Context Management & Reliability","q":"Your multi-agent system has no centralized logging. When errors occur in production, you cannot determine which agent failed or why. What should you implement?","o":["Wrap every tool call in a try/except that writes the exception and a stack trace to that agent's own local log file, so each agent keeps a complete record of the failures it hit during its own portion of the run","Implement observability through centralized logging at the coordinator level: all agent interactions, tool calls, and results should be logged for debugging and monitoring production issues","Have each agent return a structured status field alongside its result and surface a failure summary at the end of the run, so the person who hit the error can report which stage broke","Move orchestration to a larger model with stronger instruction following, since most multi-agent failures come from agents mis-reading their own task briefs"],"a":1,"e":"Agent observability requires centralized logging of all interactions, tool calls, and results. Routing all communication through the coordinator (which logs everything) provides a single point for monitoring, debugging, and auditing the multi-agent system in production."},
  {"d":"Context Management & Reliability","q":"Your production system processes 1000 requests per hour during peak times. What should you plan for regarding Claude API reliability?","o":["Request a rate limit increase ahead of the peak, since an approved limit reserves that capacity for your organisation and guarantees requests inside it are served even during a provider-side incident","Implement graceful degradation: have fallback responses or cached results for when the API is unavailable or rate-limited, and design the system to continue functioning with reduced capabilities","Benchmark end-to-end latency for a single request at peak concurrency and size the worker pool from that figure, so queue depth stays bounded while throughput is held at target","Submit the hour's requests through the Message Batches API instead, so peak load is absorbed asynchronously rather than served inline"],"a":1,"e":"Production systems should implement graceful degradation for API unavailability or rate limiting. Fallback responses, cached results, and the ability to continue with reduced capabilities ensure the system doesn't completely fail during API issues, maintaining a baseline level of service."},
  {"d":"Context Management & Reliability","q":"Your customer support agent handles multi-issue sessions. After 20+ turns, it starts confusing Order #1234's refund amount with Order #5678's details. What context management strategy addresses this?","o":["Summarise the transcript every ten turns and keep only the summaries, since progressive summarisation preserves exact figures such as order numbers while compressing the prose","Extract transactional facts (order numbers, amounts, dates, statuses) into a persistent 'case facts' block included in each prompt, outside summarized history","Have the agent write each order's details to a scratchpad file and consult it on the turns where it notices a figure is missing rather than wrong","Open a separate session for each order so that no single transcript ever holds more than one case's figures"],"a":1,"e":"Persistent case facts blocks extract critical transactional details into a structured block that is never summarized. Progressive summarization would condense these exact details into vague summaries, losing the precision needed. The facts block persists key figures, timestamps, and statuses across the entire session."},
  {"d":"Context Management & Reliability","q":"An agent exploring an unfamiliar codebase runs a content search that returns every matching line across 60 files, and the full match bodies accumulate in context across a long session. Its next step is to open the most promising files and follow their imports. Which way of trimming the search result keeps it useful?","o":["Keep one representative matched line from each file and drop the paths, since the line text is what shows whether a file is worth opening at all","Leave the result intact and have the agent record its key findings in a scratchpad file that it consults on later questions","Replace the result with a short prose summary of what the search found, written before any of it enters the conversation","Keep the file path and line number for each match and drop the matched line bodies, since the next step opens the files themselves"],"a":3,"e":"Trimming a verbose tool result means keeping the fields the next step consumes, and here the next step is opening files and following imports, so what has to survive is the address of each match rather than its text. Paths and line numbers are small, and they are the part the agent cannot reconstruct once the result is gone. Keeping a representative line per file inverts this, discarding the addresses and retaining content that will be read again anyway the moment the file is opened. A prose summary compresses hardest of all and leaves the agent knowing that something was found without knowing where, which is the one thing it needed. The scratchpad file is a real way to carry findings across a long exploration and it is the right tool when context degrades over many turns, but it records what the agent has concluded rather than stopping the raw result from accumulating, so the tokens this question is about are still spent."},
  {"d":"Context Management & Reliability","q":"A document-analysis subagent is partway through analyzing a batch of 20 source documents when it hits a permission error on the remaining 6, an error it has no way to resolve on its own. Which three of the following are anti-patterns for how the subagent should report this to the coordinator?","o":["Returning a generic document-access-failed status with no further detail, discarding the fact that 14 of the 20 documents were already analyzed successfully.","Marking the batch as successfully completed and silently omitting the 6 inaccessible documents from the results, leaving the coordinator no way to know coverage is incomplete.","Halting the entire four-agent pipeline the moment the permission error occurs, discarding the other three subagents' completed work along with the 14 documents already analyzed.","Retrying the 6 permission-denied documents immediately with exponential backoff before reporting anything to the coordinator.","Confirming that the tool_choice setting on the document tool automatically routes different error codes to different recovery subagents, so no additional detail needs to be reported.","Having the coordinator route all inter-subagent communication through itself so it can log every message centrally."],"a":[0,1,2],"type":"mr","e":"Three anti-patterns are named across Task Statement 5.3's knowledge bullets, and all three appear here. Returning a generic document-access-failed status hides valuable context — the coordinator never learns that 14 of the 20 documents were analyzed successfully. Marking the batch as completed while silently omitting the 6 inaccessible documents suppresses the failure as success, leaving coverage incomplete with no way to detect it. Halting the entire four-agent pipeline over a single recoverable failure is disproportionate, and discards three other subagents' finished work as well. Retrying the permission-denied documents with exponential backoff misapplies a real technique to the wrong problem: permission errors are access failures, not transient ones, so retrying does not help. The claim that tool_choice routes different error codes to different recovery subagents misdescribes what that setting does — it controls whether or which tool the model must call, not error-code routing. Routing all inter-subagent communication through the coordinator is true, but it belongs to Task Statement 1.2's hub-and-spoke pattern, not to what a failure report should contain."},
];
// cca:free-pool:end

async function startTest(type) {
  // quick: always free. focused: first 5 free. deep/full: need enrollment.
  if (type !== 'quick' && type !== 'focused' && !enrolled) {
    if (!currentUser) { openPaymentModal(); return; }
    // The global `enrolled` can lag if onAuthStateChanged fired concurrently.
    // Re-verify from the in-memory cached JWT — no network call, instant.
    try {
      const tok = await fbAuth.getIdTokenResult(currentUser); // cached, not forced
      if (tok.claims.enrolled) {
        markEnrolled(currentUser); // fix the stale global + fire-once analytics in one shot
        updateNavUI();     // sync the badge too
        updateDashCards(); // sync the card badges too
      }
    } catch(e) { console.warn('[startTest] token check failed', e.message); }
    if (!enrolled) { openPaymentModal(); return; }
  }

  const config = getTestConfig(type);
  // An unrecognised type -- a mistyped ?startTest= in the address bar, or a
  // drill slug that no longer exists -- used to throw on config.questions and
  // leave the visitor looking at a blank test screen.
  if (!config) { console.warn('[startTest] unknown test type:', type); return; }
  const isFreePreview = (type === 'focused' && !enrolled);
  const questionCount = isFreePreview ? 5 : config.questions;

  // Narrow on the INPUT side of the shuffle. Everything downstream -- the
  // option shuffle, the correct-index remap, MR handling, the option cap --
  // then runs untouched, which is why the drill inherits MR support for free.
  // The logged-out free tier (the Focused preview and the unenrolled Quick
  // Sprint) draws from FREE_POOL, the fixed sample resolved above. Every
  // enrolled mode draws from the whole bank.
  const isFreeQuickSprint = (type === 'quick' && !enrolled);
  // Stage B2: every enrolled mode draws from the loaded bank; the two free
  // surfaces draw from FREE_POOL and never wait on the read. If the bank
  // cannot be loaded after the retries, the dashboard shows the error box.
  let BANK;
  if (isFreePreview || isFreeQuickSprint) BANK = FREE_POOL;
  else { try { BANK = (await activeBank()).bank; } catch (e) { showBankLoadError(type); return; } }
  const drill = domainDrillEntry(type);
  const pool  = drill ? BANK.filter(q => q.d === drill.key)
              : (isFreePreview || isFreeQuickSprint) ? FREE_POOL
              : BANK;

  // The full exam is stratified so each domain carries its published share on
  // every attempt. Every other mode stays a uniform draw over its own pool,
  // with one exception: the two LOGGED-OUT surfaces guarantee a multiple-response
  // item. The hero says "Both -- question formats, MC and MR", and a uniform
  // draw from a bank that is ~11% MR left roughly 57% of five-question previews
  // and 32% of ten-question sprints with no MR item at all. freePreviewDraw()
  // takes exactly one MR item and the rest single-select, then shuffles. The
  // Focused preview (five) and the unenrolled Quick Sprint (ten) both use it;
  // an ENROLLED Quick Sprint and every paid mode keep the plain uniform draw.
  const drawn = (type === 'full')  ? stratifiedDraw(pool, questionCount)
              : (isFreePreview || isFreeQuickSprint)
                                   ? freePreviewDraw(pool, questionCount)
                                   : shuffleArray(pool).slice(0, questionCount);
  const selected = drawn.map(q => {
    const indices = q.o.map((_, i) => i);
    const shuffledIdx = shuffleArray(indices);
    const remappedA = isMR(q) ? q.a.map(orig => shuffledIdx.indexOf(orig)) : shuffledIdx.indexOf(q.a);
    return { d:q.d, q:q.q, o:shuffledIdx.map(i => q.o[i]), a:remappedA, e:q.e, type:q.type };
  });

  currentTest = {
    type,
    config: Object.assign({}, config, { questions: questionCount }),
    questions: selected,
    answers: new Array(questionCount).fill(-1),
    current: 0,
    timeLeft: config.minutes * 60,
    finished: false,
    freePreview: isFreePreview,
  };

  showSection('test');
  renderQuestion();
  renderDots();

  if (isFreePreview) {
    document.getElementById('test-timer').style.visibility = 'hidden';
  } else {
    // Set the display immediately so it shows the correct time from the first frame,
    // not whatever the previous test left behind.
    const timerEl = document.getElementById('test-timer');
    const initM = Math.floor(currentTest.timeLeft / 60);
    const initS = currentTest.timeLeft % 60;
    timerEl.textContent = `${initM}:${initS.toString().padStart(2,'0')}`;
    timerEl.classList.remove('warning');
    timerEl.style.visibility = 'visible';
    startTimer();
  }
}

function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (currentTest.timeLeft <= 0) {
      clearInterval(timerInterval);
      finishTest();
      return;
    }
    currentTest.timeLeft--;
    const m = Math.floor(currentTest.timeLeft / 60);
    const s = currentTest.timeLeft % 60;
    const el = document.getElementById('test-timer');
    el.textContent = `${m}:${s.toString().padStart(2,'0')}`;
    if (currentTest.timeLeft < 60) el.classList.add('warning');
    else el.classList.remove('warning');
  }, 1000);
}

function renderQuestion() {
  const t = currentTest;
  const q = t.questions[t.current];
  const total = t.config.questions;
  const revealed = isSelectionComplete(q, t.answers[t.current]);

  document.getElementById('test-progress').textContent = `Question ${t.current+1} of ${total}`;
  document.getElementById('test-progress-bar').style.width = `${((t.current+1)/total)*100}%`;

  let html = `<div class="question-card">
    <div class="q-num">${domainLabel(q.d)} — Question ${t.current+1}</div>
    <div class="q-text">${q.q}</div>`;

  if (t.freePreview && revealed) {
    // Show correct/incorrect state — options locked
    q.o.forEach((opt, i) => {
      let cls = '';
      const selected = Array.isArray(t.answers[t.current]) ? t.answers[t.current].includes(i) : i === t.answers[t.current];
      if (isOptionCorrect(q, i)) cls = ' correct';
      else if (selected) cls = ' incorrect';
      // user-selected carries the "Your answer" tag (index.html, .option.user-selected::after),
      // the same marking reviewTest gives a paid attempt: a chosen key and an
      // unchosen key are otherwise painted alike once both read as correct.
      html += `<button class="option${cls}${selected ? ' user-selected' : ''}" disabled>${String.fromCharCode(65+i)}. ${opt}</button>`;
    });
    const questionCorrect = isCorrect(q, t.answers[t.current]);
    html += `<div class="q-explanation">
      <div class="q-explanation-label ${questionCorrect ? 'correct' : 'incorrect'}">${questionCorrect ? '✓ Correct!' : '✗ Incorrect'}</div>
      <p class="q-explanation-text">${q.e}</p>
    </div>`;
  } else if (isMR(q)) {
    // "Select N." is derived from q.a.length, not authored text, so it can
    // never desync from what isCorrect() actually grades. n<2 is a data
    // anomaly for an MR item (multiple-response implies 2+ correct answers)
    // — omit the line rather than show a confusing "Select one."
    const mrCount = q.a.length;
    if (mrCount >= 2) {
      const MR_COUNT_WORDS = ['zero','one','two','three','four','five','six','seven','eight','nine'];
      const countWord = MR_COUNT_WORDS[mrCount] || String(mrCount);
      const selectedArr = Array.isArray(t.answers[t.current]) ? t.answers[t.current] : [];
      const selectedCount = selectedArr.length;
      const atCap = selectedCount >= mrCount;
      const noteText = atCap
        ? `Select ${countWord}. (${selectedCount} of ${mrCount} — deselect one to change)`
        : `Select ${countWord}. (${selectedCount} of ${mrCount} selected)`;
      html += `<p class="mr-select-note" style="margin:0 0 12px;font-size:.85rem;font-weight:600;font-style:italic;color:var(--text3)">${noteText}</p>`;
    }
    q.o.forEach((opt, i) => {
      const sel = Array.isArray(t.answers[t.current]) && t.answers[t.current].includes(i) ? ' selected' : '';
      html += `<button class="option option-mr${sel}" onclick="toggleAnswer(${i})"><span class="mr-box"></span>${String.fromCharCode(65+i)}. ${opt}</button>`;
    });
  } else {
    q.o.forEach((opt, i) => {
      const sel = t.answers[t.current] === i ? ' selected' : '';
      html += `<button class="option${sel}" onclick="selectAnswer(${i})">${String.fromCharCode(65+i)}. ${opt}</button>`;
    });
  }

  html += `</div>`;
  document.getElementById('question-area').innerHTML = html;

  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');

  if (t.freePreview) {
    prevBtn.style.visibility = 'hidden';
    if (revealed) {
      nextBtn.style.visibility = 'visible';
      const isLast = t.current === total - 1;
      nextBtn.textContent = isLast ? 'See full access →' : 'Next question →';
    } else {
      nextBtn.style.visibility = 'hidden';
    }
  } else {
    prevBtn.style.visibility = t.current === 0 ? 'hidden' : 'visible';
    nextBtn.style.visibility = 'visible';
    nextBtn.textContent = t.current === total - 1 ? 'Finish Test' : 'Next →';
  }
}

function selectAnswer(i) {
  currentTest.answers[currentTest.current] = i;
  renderQuestion();
  renderDots();
}

function toggleAnswer(i) {
  const t = currentTest;
  const q = t.questions[t.current];
  if (!Array.isArray(q.a)) return;
  if (!Array.isArray(t.answers[t.current])) t.answers[t.current] = [];
  const arr = t.answers[t.current];
  const pos = arr.indexOf(i);
  if (pos === -1) {
    if (arr.length >= q.a.length) return;
    arr.push(i);
  } else {
    arr.splice(pos, 1);
  }
  renderQuestion();
  renderDots();
}

function prevQuestion() {
  if (currentTest.current > 0) { currentTest.current--; renderQuestion(); renderDots(); }
}

function nextQuestion() {
  const t = currentTest;
  // In free preview, last question leads to paywall
  if (t.freePreview && t.current === t.config.questions - 1) {
    showFocusedPaywall();
    return;
  }
  if (t.current < t.config.questions - 1) {
    t.current++;
    renderQuestion();
    renderDots();
  } else {
    finishTest();
  }
}

function renderDots() {
  const t = currentTest;
  let html = '';
  for (let i = 0; i < t.config.questions; i++) {
    let cls = '';
    if (i === t.current) cls = 'current';
    else if (isAnswered(t.answers[i])) cls = 'answered';
    html += `<div class="q-dot ${cls}" onclick="jumpToQuestion(${i})" role="button" tabindex="0" aria-label="Question ${i+1}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();jumpToQuestion(${i})}">${i+1}</div>`;
  }
  document.getElementById('question-dots').innerHTML = html;
}

function jumpToQuestion(i) {
  currentTest.current = i;
  renderQuestion();
  renderDots();
}

function finishTest() {
  clearInterval(timerInterval);
  currentTest.finished = true;

  const t = currentTest;
  let correct = 0;
  const domainScores = {};

  t.questions.forEach((q, i) => {
    if (!domainScores[q.d]) domainScores[q.d] = {correct:0, total:0};
    domainScores[q.d].total++;
    if (isCorrect(q, t.answers[i])) { correct++; domainScores[q.d].correct++; }
  });

  const pct = Math.round((correct / t.config.questions) * 100);
  // Real CCA exam uses scaled 720/1,000 scoring — this % is unscaled practice only.
  const timeUsed = (t.config.minutes * 60) - t.timeLeft;
  const mUsed = Math.floor(timeUsed / 60);
  const sUsed = timeUsed % 60;

  document.getElementById('results-score').textContent = pct + '%';
  document.getElementById('results-score').className = 'score';
  document.getElementById('results-verdict').textContent = 'Practice complete';
  document.getElementById('results-verdict').style.color = 'var(--text2)';
  document.getElementById('results-detail').textContent =
    `You answered ${correct} out of ${t.config.questions} questions correctly in ${mUsed}m ${sUsed}s. Practice score only — the real CCA exam uses a scaled 720 / 1,000 scoring system, not a raw percentage.`;

  let breakdownHTML = `
    <div class="rb-card"><div class="rb-val" style="color:var(--accent)">${correct}/${t.config.questions}</div><div class="rb-label">Correct answers</div></div>
    <div class="rb-card"><div class="rb-val" style="color:var(--gold)">${mUsed}m ${sUsed}s</div><div class="rb-label">Time used</div></div>
    <div class="rb-card"><div class="rb-val" style="color:var(--text)">${pct}%</div><div class="rb-label">Practice score · unscaled</div></div>`;

  for (const [domain, scores] of Object.entries(domainScores)) {
    const dpct = Math.round((scores.correct/scores.total)*100);
    breakdownHTML += `<div class="rb-card"><div class="rb-val" style="color:var(--text)">${dpct}%</div><div class="rb-label">${domainLabel(domain)}</div></div>`;
  }
  document.getElementById('results-breakdown').innerHTML = breakdownHTML;
  document.getElementById('review-area').innerHTML = '';
  showSection('results');

  // Persist this attempt for the Progress dashboard (enrolled users only —
  // the dashboard itself is gated to enrolled accounts). Fire-and-forget:
  // never block the results screen on a Firestore write.
  if (enrolled && currentUser) {
    ensureFirestore().then(() => {
      const fs = window.__fs;
      return fs.addDoc(fs.collection(db, 'users', currentUser.uid, 'attempts'), {
        type: t.type,
        totalQuestions: t.config.questions,
        correct: correct,
        pct: pct,
        domainScores: domainScores,
        timeUsedSec: timeUsed,
        takenAt: fs.serverTimestamp()
      });
    }).catch(e => console.warn('[Progress] attempt save failed:', e.message));
  }
}

function reviewTest() {
  const t = currentTest;
  let html = '';
  t.questions.forEach((q, i) => {
    const userAns = t.answers[i];
    const questionCorrect = isCorrect(q, userAns);
    html += `<div class="question-card" style="border-color:${questionCorrect?'var(--green)':'var(--red)'}">
      <div class="q-num" style="color:${questionCorrect?'var(--green)':'var(--red)'}">${questionCorrect?'✓ CORRECT':'✗ INCORRECT'} — ${domainLabel(q.d)}</div>
      <div class="q-text">${q.q}</div>`;
    q.o.forEach((opt, j) => {
      let cls = '';
      const selected = Array.isArray(userAns) ? userAns.includes(j) : j === userAns;
      if (isOptionCorrect(q, j)) cls = 'correct';
      else if (selected && !questionCorrect) cls = 'incorrect';
      html += `<div class="option ${cls}${selected ? ' user-selected' : ''}" style="cursor:default">${String.fromCharCode(65+j)}. ${opt}</div>`;
    });
    html += `<div class="explanation-box show"><h4>Explanation</h4><p>${q.e}</p></div></div>`;
  });
  document.getElementById('review-area').innerHTML = html;
  document.getElementById('review-area').scrollIntoView({behavior:'smooth'});
}

function exitTest() {
  clearInterval(timerInterval);
  if (currentTest && !currentTest.finished) {
    if (!confirm('Exit test? Your progress will be lost.')) return;
  }
  currentTest = null;
  window.location.href = '/';
}

// ═══════════════════════════════════════
// LESSONS
// ═══════════════════════════════════════
let lessonsLoaded = false;
let currentLesson = 0;

let ACTIVE_LESSONS = [];
async function renderLessons() {
  lessonsLoaded = true;
  // (A) The lessons are paid content. Wait for the session to settle, then show
  // the plan with an unlock button to anyone not entitled; no Firestore read.
  {
    const nav0 = document.getElementById('lesson-nav'), content0 = document.getElementById('lesson-content');
    if (content0 && !(currentUser && enrolled)) content0.innerHTML = '<p>Loading…</p>';
    await whenAuthSettled();
    if (!currentUser || !enrolled) {
      lessonsLoaded = false;
      if (nav0) nav0.innerHTML = '';
      if (content0) content0.innerHTML = lessonPlanPreviewHtml();
      return;
    }
  }
  // Stage B2: the lessons come with the bank from Firestore. On a failed load
  // the view shows the error box; Retry renders again from a fresh load.
  try { ACTIVE_LESSONS = (await activeBank()).lessons; }
  catch (e) {
    lessonsLoaded = false;
    const nav = document.getElementById('lesson-nav'), content = document.getElementById('lesson-content');
    if (nav) nav.innerHTML = '';
    if (content) { content.innerHTML = bankLoadErrorHtml(); wireBankLoadRetry(content, function () { renderLessons(); }); }
    return;
  }
  let navHTML = '';
  ACTIVE_LESSONS.forEach((l, i) => {
    navHTML += `<button class="${i===0?'active':''}" onclick="showLesson(${i})" data-lesson="${i}">${i+1}. ${l.title}</button>`;
  });
  document.getElementById('lesson-nav').innerHTML = navHTML;
  showLesson(0);
}

function showLesson(i) {
  currentLesson = i;
  document.getElementById('lesson-content').innerHTML = ACTIVE_LESSONS[i].content;
  document.querySelectorAll('[data-lesson]').forEach(b => b.classList.remove('active'));
  document.querySelector(`[data-lesson="${i}"]`).classList.add('active');
}

// ═══════════════════════════════════════
// MOBILE NAV
// ═══════════════════════════════════════
function toggleMobileNav() {
  const nav = document.getElementById('nav-links');
  const hamburger = document.getElementById('hamburger');
  nav.classList.toggle('mobile-open');
  hamburger.classList.toggle('open');
  hamburger.setAttribute('aria-expanded', nav.classList.contains('mobile-open') ? 'true' : 'false');
}
function closeMobileNav() {
  const nav = document.getElementById('nav-links');
  const hamburger = document.getElementById('hamburger');
  nav.classList.remove('mobile-open');
  hamburger.classList.remove('open');
  hamburger.setAttribute('aria-expanded', 'false');
}
// Close mobile nav when a nav link is clicked
document.querySelectorAll('.nav-links button[data-nav]').forEach(btn => {
  btn.addEventListener('click', closeMobileNav);
});

// Initialize — show the correct section from first paint (before Firebase loads).
// ?hub=practice-tests must show the dashboard immediately; any other load shows home.
// onAuthStateChanged still runs later and calls showSection('dashboard') + updateDashCards()
// for enrollment state — this early check is purely cosmetic: prevents the visible flash
// where /?hub=practice-tests briefly renders the homepage hero before Firebase swaps it.
if (!enrolled) {
  const _earlyHub = new URLSearchParams(window.location.search).get('hub');
  showSection(_earlyHub === 'practice-tests' ? 'dashboard' : 'home');
}

// updateDashCards() also renders the picker, but it only runs from
// onAuthStateChanged. Populate it here too so the card is never an empty
// dropdown if Firebase is slow or blocked.
renderDomainDrillPicker();

// ═══════ SCROLL REVEAL (IntersectionObserver) ═══════
(function(){
  const revealEls = document.querySelectorAll('.reveal,.reveal-left,.reveal-right,.reveal-scale');
  if (!revealEls.length) return;
  // Fallback: if IntersectionObserver doesn't fire within 2s, make everything visible
  var fallbackTimer = setTimeout(function(){
    revealEls.forEach(function(el){ el.classList.add('visible'); });
  }, 2000);
  var observed = 0;
  var obs = new IntersectionObserver(function(entries) {
    entries.forEach(function(e) {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        var counters = e.target.querySelectorAll('.counter[data-count],.num[data-count]');
        counters.forEach(animateCounter);
        obs.unobserve(e.target);
        observed++;
        if (observed >= revealEls.length) clearTimeout(fallbackTimer);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  revealEls.forEach(function(el){ obs.observe(el); });
})();

// ═══════ ANIMATED COUNTERS ═══════
function animateCounter(el) {
  if (el.dataset.animated) return;
  el.dataset.animated = '1';
  const target = parseFloat(el.dataset.count);
  const suffix = el.dataset.suffix || '';
  const decimals = parseInt(el.dataset.decimals) || 0;
  const duration = 2000;
  const start = performance.now();
  function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = eased * target;
    el.textContent = (decimals > 0 ? current.toFixed(decimals) : Math.floor(current)) + suffix;
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// Also animate hero stat counters that are already visible
document.querySelectorAll('.hero-stats .num[data-count]').forEach(el => {
  const obs2 = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) { animateCounter(e.target); obs2.unobserve(e.target); }
    });
  }, { threshold: 0.3 });
  obs2.observe(el);
});

// ═══════ PRE-WARM THE RENDER WEBHOOK SERVER ═══════
// scripts/stripe-webhook.js runs on Render's free tier, which spins down
// after ~15 minutes idle and can take 30-60+ seconds to cold-start (this is
// exactly the latency confirmPaymentAndUnlock's poll above has to absorb).
// Today the server's first real wake-up call is usually the Stripe webhook
// firing seconds after checkout — too late to dodge the cold start. Someone
// scrolling to the pricing section is a strong "about to buy" signal, so
// nudge the server awake right then with a no-op GET to its health route.
//
// Strictly fire-and-forget: must never block the UI, throw, or surface
// anything to the user if Render is asleep, slow, mid-deploy, or simply
// unreachable — this is a best-effort latency optimization, nothing more.
// Debounced to once per page session (a `let` flag, reset on reload) since
// a single hit is enough to keep the instance warm for the ~15 minutes a
// typical pricing-to-checkout journey takes.
(function(){
  const pricingSection = document.getElementById('pricing-section');
  if (!pricingSection || !window.IntersectionObserver) return;
  let warmed = false;
  const warmObs = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting && !warmed) {
        warmed = true;
        warmObs.disconnect();
        // mode:'no-cors' — we don't read the response (and don't need CORS
        // headers for it); the round trip to the server is what wakes it.
        fetch(WEBHOOK_BASE + '/', { method: 'GET', mode: 'no-cors', cache: 'no-store' })
          .catch(() => { /* swallow — purely best-effort */ });
      }
    });
  }, { threshold: 0.2 });
  warmObs.observe(pricingSection);
})();

// ═══════ HERO ANIMATION (safe for iOS) ═══════
(function(){
  var hero = document.querySelector('.hero');
  if (!hero) return;
  // Only animate if user hasn't disabled motion
  var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (mq && mq.matches) return;
  // Trigger animations after paint to ensure elements are rendered visible first
  requestAnimationFrame(function(){ hero.classList.add('hero-animated'); });
})();

// ═══════ HERO PARTICLES ═══════
(function(){
  const container = document.getElementById('particles');
  if (!container) return;
  const count = 25;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDuration = (8 + Math.random() * 12) + 's';
    p.style.animationDelay = (Math.random() * 10) + 's';
    p.style.width = p.style.height = (1 + Math.random() * 2.5) + 'px';
    if (Math.random() > 0.6) p.style.background = 'var(--gold)';
    container.appendChild(p);
  }
})();

// ═══════ TESTIMONIALS ═══════
// The auto-scrolling testimonial carousel that lived here has been removed. It
// hardcoded a five-star rating and a "PASSED FIRST ATTEMPT" badge into every
// card, neither of which this site can stand behind, and it advanced on a timer,
// which hides cards from anyone who does not wait. Real customer quotes are
// published as a plain static grid in index.html's #customer-quotes-section.

// ═══════ NAV SCROLL EFFECT ═══════
(function(){
  let ticking = false;
  const nav = document.querySelector('nav');
  window.addEventListener('scroll', function() {
    if (!ticking) {
      requestAnimationFrame(function() {
        if (window.scrollY > 60) {
          nav.style.background = 'rgba(245,243,234,.98)';
          nav.style.boxShadow = '0 1px 8px rgba(0,0,0,.06)';
        } else {
          nav.style.background = 'rgba(245,243,234,.92)';
          nav.style.boxShadow = 'none';
        }
        ticking = false;
      });
      ticking = true;
    }
  });
})();

// ═══════ SMOOTH SECTION TRANSITIONS ═══════
(function(){
  const origShowSection = window.showSection;
  if (!origShowSection) return;
  window.showSection = function(section) {
    // Find currently visible section content
    const targets = document.querySelectorAll('.hero, .dashboard, .test-view, .results-view, .lessons-view, #pricing-section');
    targets.forEach(t => { t.style.transition = 'opacity .25s ease'; });
    origShowSection(section);
    // Trigger reveal animations in the newly shown section
    setTimeout(() => {
      document.querySelectorAll('.reveal:not(.visible),.reveal-left:not(.visible),.reveal-right:not(.visible),.reveal-scale:not(.visible)').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight && rect.bottom > 0) {
          el.classList.add('visible');
          el.querySelectorAll('.counter[data-count],.num[data-count]').forEach(animateCounter);
        }
      });
    }, 100);
  };
})();

// Sample question answer reveal
function toggleSampleQ(btn) {
  var card = btn.closest('.sq-card');
  var answer = card.querySelector('.sq-answer');
  var textEl = btn.querySelector('.sq-toggle-text');
  var open = answer.classList.contains('sq-visible');
  if (!open) {
    // Every card is graded here, on request, never on a click: the engine
    // grades at finishTest, and Show answer is the sample's equivalent.
    var need = parseInt(card.getAttribute('data-select') || '1', 10);
    if (!card.classList.contains('sq-answered')) gradeSampleAnswerMulti(card, need);
    // Update result label if user already made a guess
    var label = card.querySelector('.sq-answer-label');
    var result = card.getAttribute('data-result');
    if (result === 'correct') {
      label.innerHTML = '&#x2713;&nbsp;Correct — well done!';
      label.style.color = 'var(--green)';
    } else if (result === 'wrong') {
      label.innerHTML = card.getAttribute('data-select')
        ? '&#x2715;&nbsp;Incorrect — correct answers highlighted above.'
        : '&#x2715;&nbsp;Incorrect — correct answer highlighted above.';
      label.style.color = 'var(--red)';
    }
    // sq-revealed is permanent once set (keeps correct option green)
    card.classList.add('sq-revealed', 'sq-answered');
  }
  answer.classList.toggle('sq-visible', !open);
  if (!open) {
    // The panel opens below the button, which on a phone is often the last thing
    // on screen. 'nearest' brings it in without moving a panel already in view,
    // but a panel taller than the space under the fixed header ends up with its
    // top behind the header (nearest aligns the bottom edge). In that case align
    // the top instead; .sq-answer's scroll-margin-top (index.html) carries the
    // header height from --banner-h and --nav-h, so the verdict lands just under it.
    answer.scrollIntoView({ block: 'nearest' });
    var rootStyle = getComputedStyle(document.documentElement);
    var headerH = (parseFloat(rootStyle.getPropertyValue('--banner-h')) || 0) + (parseFloat(rootStyle.getPropertyValue('--nav-h')) || 64);
    if (answer.getBoundingClientRect().top < headerH) answer.scrollIntoView({ block: 'start' });
  }
  btn.classList.toggle('open', !open);
  btn.setAttribute('aria-expanded', String(!open));
  answer.setAttribute('aria-hidden', String(open));
  textEl.textContent = open ? 'Show answer' : 'Hide answer';
}

// Click an option to attempt answer.
// data-select="N" on the card is the cap, 1 when absent. Every card stays open
// until Show answer: pick, change or clear, then it is graded on reveal, as the
// engine allows changes until a test is finished.
function selectSampleAnswer(li) {
  var card = li.closest('.sq-card');
  if (card.classList.contains('sq-answered')) return;
  selectSampleAnswerMulti(card, li, parseInt(card.getAttribute('data-select') || '1', 10));
}

// Sample selection, on the engine's convention (toggleAnswer, above): add
// until `need` are chosen, remove at any time. At the cap a single-select
// card MOVES the selection to the clicked option; a multiple-response card
// refuses the add and says so in the engine's own words, "deselect one to
// change". Nothing is graded here. gradeSampleAnswerMulti() runs from Show
// answer, and the card locks there.
function selectSampleAnswerMulti(card, li, need) {
  var chosen = card.querySelectorAll('.sq-options li.sq-chosen');
  if (!li.classList.contains('sq-chosen') && chosen.length >= need) {
    if (need > 1) return;
    Array.prototype.forEach.call(chosen, function (el) { el.classList.remove('sq-chosen'); });
  }
  li.classList.toggle('sq-chosen');
  chosen = card.querySelectorAll('.sq-options li.sq-chosen');
  var note = card.querySelector('.sq-mr-note');
  if (!note) return;
  if (!chosen.length) {
    note.textContent = need === 1 ? 'Select one answer' : 'Select ' + (need === 2 ? 'two' : need) + ' answers';
  } else if (need === 1) {
    note.textContent = 'Answer selected. Click another to change it, or Show answer to check.';
  } else if (chosen.length < need) {
    note.textContent = chosen.length + ' of ' + need + ' selected. Click a selected answer again to deselect it.';
  } else {
    note.textContent = need + ' of ' + need + ' selected. Deselect one to change, or click Show answer to check.';
  }
}

// Grades a sample card when the reader asks for the answer. No pick means no
// verdict. A partial pick is graded wrong, matching isCorrect(): the count
// must equal the key count. The note nearest the options carries the verdict;
// the label inside the answer panel carries it too.
function gradeSampleAnswerMulti(card, need) {
  var chosen = card.querySelectorAll('.sq-options li.sq-chosen');
  if (!chosen.length) return;
  var allCorrect = chosen.length === need, wrongPick = false;
  Array.prototype.forEach.call(chosen, function (el) {
    if (!el.classList.contains('sq-correct')) { el.classList.add('sq-selected'); allCorrect = false; wrongPick = true; }
  });
  card.setAttribute('data-result', allCorrect ? 'correct' : 'wrong');
  var note = card.querySelector('.sq-mr-note');
  // Wrong with no wrong pick means fewer picks than the cap, which only a
  // multiple-response card can reach: a single-select card holds at most one
  // chosen option, and one chosen option is either the key or a wrong pick.
  if (note) note.textContent = allCorrect ? 'Correct.'
    : !wrongPick ? 'Incorrect. The correct answers are highlighted in green. You selected fewer than the question asks for.'
    : need > 1 ? 'Incorrect. The correct answers are highlighted in green, yours in pink.'
    : 'Incorrect. The correct answer is highlighted in green, yours in pink.';
}

// Shuffle sample question cards on every page load
(function() {
  var grid = document.getElementById('sample-q-grid');
  if (!grid) return;
  var cards = Array.from(grid.children);
  for (var i = cards.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    grid.appendChild(cards[j]);
    cards.splice(j, 1);
  }
})();

function showFocusedPaywall() {
  clearInterval(timerInterval);
  document.getElementById('question-area').innerHTML = `
    <div class="q-paywall">
      <div class="q-paywall-icon">🔓</div>
      <h2>You've seen the first 5. Unlock all 400 questions and timed exams for $49</h2>
      <p>All 400 scenario-based questions across five CCAR-F domains, four timed exam modes, and every answer fully explained.</p>
      <button class="btn-primary" onclick="openPaymentModal()">Unlock full access: $49</button>
      <p class="q-paywall-altlink">Not sure yet? <a href="/diagnostic/">Take the free diagnostic</a> to see your weakest domain first</p>
      <div class="q-paywall-sub">One-time payment · Lifetime access · 10-day money-back guarantee</div>
    </div>`;
  document.getElementById('question-dots').innerHTML = '';
  document.getElementById('test-progress').textContent = '';
  document.getElementById('test-progress-bar').style.width = '100%';
  document.getElementById('prev-btn').style.visibility = 'hidden';
  document.getElementById('next-btn').style.visibility = 'hidden';
  document.getElementById('test-timer').style.visibility = 'hidden';
}
