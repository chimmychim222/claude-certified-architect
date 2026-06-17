/**
 * Stripe webhook server — runs on Render.com (free tier).
 * When a customer pays via Stripe, this sets enrolled:true in Firebase.
 *
 * Environment variables to set in Render dashboard:
 *   STRIPE_SECRET_KEY              — Stripe → Developers → API keys → Secret key
 *   STRIPE_WEBHOOK_SECRET          — Stripe → Developers → Webhooks → signing secret
 *   FIREBASE_SERVICE_ACCOUNT_JSON  — full contents of your Firebase service account .json
 *   RESEND_API_KEY                 — Resend → API Keys → Create API Key
 *                                    (domain claudecertifiedarchitects.com must be verified
 *                                    in Resend before emails will send)
 *   ADMIN_API_KEY                  — any long random string you generate yourself;
 *                                    required as the `x-admin-key` header on
 *                                    GET /admin/stale-pending-enrollments.
 *                                    Leaving it unset disables that endpoint entirely.
 *
 *   ALERT_EMAIL_TO   (optional)    — email address to notify when stale (>48h)
 *                                    pending_enrollments are found. Reuses the
 *                                    Resend setup above — no new provider needed.
 *   ALERT_WEBHOOK_URL (optional)   — a Slack or Discord "incoming webhook" URL,
 *                                    notified the same way. Set either/both/
 *                                    neither; with neither set, stale findings
 *                                    just fall back to a console.warn log line
 *                                    (visible in the Render dashboard).
 *
 *   Also see the big comment box above GET /admin/stale-pending-enrollments
 *   below for how to point a free external scheduler (cron-job.org etc.) at
 *   it — that's what makes the stale-enrollment check actually dependable on
 *   a free-tier dyno that sleeps, and keeps the instance warm as a bonus.
 */

const admin      = require('firebase-admin');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const express    = require('express');
const bodyParser = require('body-parser');

// ── Resend helper ─────────────────────────────────────────────────────────────
// Sends transactional email via Resend.com (https://resend.com).
// Uses the built-in fetch available in Node 18+.
// Returns true on success, false on failure (never throws).
async function sendViaResend({ to, subject, text }) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[resend] RESEND_API_KEY not set — email skipped.');
    return false;
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    'CCA Practice <noreply@claudecertifiedarchitects.com>',
        to:      [to],
        subject,
        text,
      }),
    });
    if (resp.ok) {
      const data = await resp.json();
      console.log('[resend] Email sent:', data.id, '→', to);
      return true;
    } else {
      const err = await resp.text();
      console.error('[resend] Send failed:', resp.status, err);
      return false;
    }
  } catch (err) {
    console.error('[resend] Fetch error:', err.message);
    return false;
  }
}

// ── GA4 Measurement Protocol purchase event ───────────────────────────────────
// Fires a server-side 'purchase' event to GA4 after every successful enrollment.
// This is additive to the client-side event in app.js — GA4 deduplicates on
// transaction_id, so if both arrive only one conversion is counted.
//
// Using the Stripe session ID as transaction_id is intentional: it's the same
// value the client-side maybeFireExamPurchaseEvent uses (via stripeSessionId in
// the users/{uid} Firestore doc), which is exactly what enables deduplication.
//
// If GA4_MEASUREMENT_ID or GA4_MP_API_SECRET are not set, this skips silently —
// a missing analytics config must never prevent a real enrollment from landing.
async function fireGA4PurchaseEvent(sessionId, ga4ClientId, uid) {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret     = process.env.GA4_MP_API_SECRET;

  if (!measurementId || !apiSecret) {
    console.warn('[GA4] GA4_MEASUREMENT_ID or GA4_MP_API_SECRET not set — purchase event skipped.');
    return;
  }

  // GA4 requires a client_id. The _ga-cookie-derived value gives proper
  // attribution back to ad clicks; the firebase_ prefix fallback is weaker
  // (no session history in GA4 to tie to) but still records the conversion.
  const clientId = ga4ClientId || ('firebase_' + uid);
  if (!ga4ClientId) {
    console.log(`[GA4] No ga4ClientId for uid=${uid} — using fallback client_id; ad-click attribution may be absent.`);
  }

  const url =
    'https://www.google-analytics.com/mp/collect' +
    `?measurement_id=${encodeURIComponent(measurementId)}` +
    `&api_secret=${encodeURIComponent(apiSecret)}`;

  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        events: [{
          name:   'purchase',
          params: {
            currency:       'USD',
            value:          49,
            transaction_id: sessionId,
            items: [{ item_id: 'cca_exam_prep', item_name: 'CCA Exam Prep', price: 49, quantity: 1 }],
          },
        }],
      }),
    });
    // GA4 MP returns 204 No Content on success
    if (resp.ok) {
      console.log(`[GA4] purchase event sent: session=${sessionId} client_id=${clientId}`);
    } else {
      const body = await resp.text().catch(() => '');
      console.warn(`[GA4] purchase event failed: HTTP ${resp.status} ${body}`);
    }
  } catch (err) {
    console.warn('[GA4] purchase event error:', err.message);
  }
}

// ── Firebase init ─────────────────────────────────────────────────────────────
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const auth = admin.auth();
// IMPORTANT — do NOT use admin.firestore() (no args) here.
// This project's Firestore database has the custom database ID "default"
// (a literal, named database) — NOT the SDK's special reserved "(default)"
// database that admin.firestore() connects to by default. The "(default)"
// database is empty for this project, so admin.firestore() silently returns
// "5 NOT_FOUND" for every single read/write, while looking like a normal
// client (no error at init time). Confirmed empirically with
// scripts/diagnose-firestore.js — see that file's history for the trace.
// Must explicitly target the "default"-named database:
const { getFirestore } = require('firebase-admin/firestore');
const db   = getFirestore(admin.app(), 'default');
const app  = express();

// ── Global CORS — must come before all routes ─────────────────────────────────
app.use((req, res, next) => {
  const allowed = [
    'https://claudecertifiedarchitects.com',
    'https://www.claudecertifiedarchitects.com',
  ];
  const origin = req.headers.origin;
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Stripe webhook ────────────────────────────────────────────────────────────
app.post(
  '/stripe-webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type !== 'checkout.session.completed') {
      return res.json({ skipped: true, type: event.type });
    }

    const session           = event.data.object;
    const customerEmail     = session.customer_details?.email || session.customer_email;
    const clientReferenceId = session.client_reference_id || null;

    // ── Logged-in checkout: client_reference_id carries the Firebase UID of
    // the account that started checkout (set by openPaymentModal in app.js).
    // Enroll THAT account directly, regardless of what email was typed at
    // Stripe — this is the fix for the email-mismatch/double-payment bug
    // class, where a typo'd or different checkout email orphaned the
    // purchase in pending_enrollments and left the paying account locked out.
    // Only fall through to the email-based lookup below for genuinely
    // logged-out checkouts (no client_reference_id) or if this uid is
    // somehow stale (e.g. the account was deleted between checkout and now).
    if (clientReferenceId) {
      try {
        const userRecord     = await auth.getUser(clientReferenceId);
        const uid            = userRecord.uid;
        const existingClaims = userRecord.customClaims || {};

        // Read GA4 attribution data the client wrote to Firestore before
        // redirecting to checkout — used for the MP purchase event below.
        let ga4ClientId = null;
        try {
          const attrSnap = await db.collection('users').doc(uid).get();
          if (attrSnap.exists) ga4ClientId = attrSnap.data().ga4ClientId || null;
        } catch (e) { /* best-effort, never block enrollment */ }

        await auth.setCustomUserClaims(uid, { ...existingClaims, enrolled: true });

        await db.collection('users').doc(uid).set(
          {
            enrolled:        true,
            enrolledAt:      admin.firestore.FieldValue.serverTimestamp(),
            email:           customerEmail || userRecord.email,
            stripeSessionId: session.id,
          },
          { merge: true }
        );

        // Clean up any pending record left over from an earlier checkout
        // attempt under a different (typo'd/mismatched) email.
        if (customerEmail) {
          db.collection('pending_enrollments').doc(customerEmail.toLowerCase()).delete().catch(() => {});
        }

        console.log(`Enrolled via client_reference_id: ${customerEmail || userRecord.email} (${uid})`);
        // Fire server-side GA4 purchase event — additive, deduped by transaction_id.
        fireGA4PurchaseEvent(session.id, ga4ClientId, uid).catch(() => {});
        return res.json({ ok: true, enrolled: uid });
      } catch (err) {
        console.warn(`client_reference_id lookup failed (${clientReferenceId}):`, err.message);
        // fall through to email-based lookup below
      }
    }

    if (!customerEmail) {
      console.error('No customer email in event');
      return res.status(400).send('No customer email found');
    }

    // Look up the Firebase account for this email. If none exists yet — the
    // customer paid before signing up, or checked out with a different email
    // than they'll use to create their account — stash the purchase as a
    // "pending enrollment" so /claim-enrollment can apply it later, once a
    // matching account shows up. Returning 200 here (instead of 500) tells
    // Stripe delivery succeeded; otherwise it retries for up to 3 days and
    // then silently gives up, permanently losing the enrollment.
    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(customerEmail);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        try {
          await db.collection('pending_enrollments').doc(customerEmail.toLowerCase()).set(
            {
              email:           customerEmail,
              stripeSessionId: session.id,
              createdAt:       admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          console.log(`Pending enrollment stashed (no account yet): ${customerEmail}`);
          return res.json({ ok: true, pending: true });
        } catch (stashErr) {
          console.error('Failed to stash pending enrollment:', stashErr.message);
          return res.status(500).send(stashErr.message);
        }
      }
      console.error('Enrollment lookup error:', err.message);
      return res.status(500).send(err.message);
    }

    try {
      const uid            = userRecord.uid;
      const existingClaims = userRecord.customClaims || {};

      // Read GA4 attribution data — present if user was logged in at checkout.
      let ga4ClientId = null;
      try {
        const attrSnap = await db.collection('users').doc(uid).get();
        if (attrSnap.exists) ga4ClientId = attrSnap.data().ga4ClientId || null;
      } catch (e) { /* best-effort */ }

      await auth.setCustomUserClaims(uid, { ...existingClaims, enrolled: true });

      await db.collection('users').doc(uid).set(
        {
          enrolled:        true,
          enrolledAt:      admin.firestore.FieldValue.serverTimestamp(),
          email:           customerEmail,
          stripeSessionId: session.id,
        },
        { merge: true }
      );

      // Clear any stale pending record for this email (e.g. a Stripe retry
      // that arrived after the account was created and matched normally).
      db.collection('pending_enrollments').doc(customerEmail.toLowerCase()).delete().catch(() => {});

      console.log(`Enrolled: ${customerEmail} (${uid})`);
      fireGA4PurchaseEvent(session.id, ga4ClientId, uid).catch(() => {});
      return res.json({ ok: true, enrolled: uid });

    } catch (err) {
      console.error('Enrollment error:', err.message);
      return res.status(500).send(err.message);
    }
  }
);

// ── Claim a pending enrollment ────────────────────────────────────────────────
// POST /claim-enrollment
// Header: Authorization: Bearer <Firebase ID token>
//
// Covers the "paid before the account existed" gap: when the webhook above
// can't find a Firebase user for the checkout email, it stashes a pending
// enrollment keyed by that email. Once that person signs up or logs in, the
// client calls this endpoint with a verified ID token; if the token's email
// matches a pending record, we apply the enrollment (custom claim + Firestore)
// right then, exactly as the webhook would have.
app.post('/claim-enrollment', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const m = authHeader.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Missing bearer token' });

  let decoded;
  try {
    decoded = await auth.verifyIdToken(m[1]);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const uid   = decoded.uid;
  const email = (decoded.email || '').toLowerCase();
  if (!email) return res.json({ ok: true, enrolled: false });

  try {
    const pendingRef = db.collection('pending_enrollments').doc(email);
    const pendingDoc = await pendingRef.get();
    if (!pendingDoc.exists) {
      return res.json({ ok: true, enrolled: false });
    }

    // SECURITY: Firebase email/password sign-up does not prove inbox
    // ownership — anyone can register an account using a stranger's email
    // address. Without this gate, an attacker who merely knows (or guesses)
    // a real purchaser's email could sign up *as* them, claim the pending
    // enrollment under the attacker's own uid, and — because claiming
    // deletes the pending record — permanently destroy the real purchaser's
    // only path to the access they paid for. email_verified is Firebase's
    // proof that the token holder actually controls that inbox (they clicked
    // a link sent to it), which is exactly the property we need here.
    if (!decoded.email_verified) {
      return res.json({ ok: true, enrolled: false, reason: 'unverified_email' });
    }

    const pending        = pendingDoc.data();
    const userRecord     = await auth.getUser(uid);
    const existingClaims = userRecord.customClaims || {};

    await auth.setCustomUserClaims(uid, { ...existingClaims, enrolled: true });
    await db.collection('users').doc(uid).set(
      {
        enrolled:        true,
        enrolledAt:      admin.firestore.FieldValue.serverTimestamp(),
        email:           userRecord.email,
        stripeSessionId: pending.stripeSessionId || null,
      },
      { merge: true }
    );
    await pendingRef.delete();

    // Fire GA4 server-side purchase event for claimed pending enrollments.
    // Read ga4ClientId from the users doc (written by the client before checkout
    // or on a subsequent login); fall back to uid if not present.
    {
      let ga4ClientId = null;
      try {
        const attrSnap = await db.collection('users').doc(uid).get();
        if (attrSnap.exists) ga4ClientId = attrSnap.data().ga4ClientId || null;
      } catch (e) { /* best-effort */ }
      fireGA4PurchaseEvent(
        pending.stripeSessionId || ('claim_' + uid),
        ga4ClientId,
        uid
      ).catch(() => {});
    }

    console.log(`Claimed pending enrollment: ${email} (${uid})`);
    return res.json({ ok: true, enrolled: true });

  } catch (err) {
    console.error('Claim-enrollment error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Pre-checkout enrollment guard ────────────────────────────────────────────
// POST /pre-checkout
// Header: Authorization: Bearer <Firebase ID token>
//
// Called by openPaymentModal() before the browser navigates to the Stripe
// Payment Link. Prevents an already-enrolled account from accidentally paying
// again, and catches a duplicate in-flight checkout (same UID, started in the
// last 10 minutes). Returns one of:
//   { ok: false, reason: 'already_enrolled' }   — account has access; redirect to dashboard
//   { ok: false, reason: 'recent_session', ageSeconds }  — checkout in progress; wait and reload
//   { ok: true }                                 — clear to proceed to Stripe
//
// Fails open on any error so that a network hiccup or Render cold start never
// blocks a legitimate first purchase. checkout_intents/{uid} is used as a
// lightweight in-flight tracker; records are overwritten on each cleared check
// so stale entries from abandoned carts don't accumulate.
app.post('/pre-checkout', express.json(), async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const m = authHeader.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Missing bearer token' });

  let decoded;
  try {
    decoded = await auth.verifyIdToken(m[1]);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const uid = decoded.uid;

  try {
    // Belt: custom claims — fastest; no extra Firestore read when claims are fresh.
    const userRecord = await auth.getUser(uid);
    if ((userRecord.customClaims || {}).enrolled === true) {
      console.log(`[pre-checkout] Blocked (claims): uid=${uid} already enrolled`);
      return res.json({ ok: false, reason: 'already_enrolled' });
    }

    // Suspenders: Firestore — catches the window between enrollment write and
    // claim propagation (claims can lag a few seconds after setCustomUserClaims).
    const userSnap = await db.collection('users').doc(uid).get();
    if (userSnap.exists && userSnap.data().enrolled === true) {
      console.log(`[pre-checkout] Blocked (FS): uid=${uid} already enrolled`);
      return res.json({ ok: false, reason: 'already_enrolled' });
    }

    // Detect a duplicate in-flight checkout (same UID started < 10 min ago).
    const intentRef  = db.collection('checkout_intents').doc(uid);
    const intentSnap = await intentRef.get();
    if (intentSnap.exists) {
      const ts    = intentSnap.data().initiatedAt;
      const ageMs = ts ? Date.now() - ts.toMillis() : Infinity;
      if (ageMs < 10 * 60 * 1000) {
        const ageSeconds = Math.round(ageMs / 1000);
        console.log(`[pre-checkout] Recent session: uid=${uid} age=${ageSeconds}s`);
        return res.json({ ok: false, reason: 'recent_session', ageSeconds });
      }
    }

    // All clear — record intent and allow through.
    await intentRef.set({ uid, initiatedAt: admin.firestore.FieldValue.serverTimestamp() });
    console.log(`[pre-checkout] Cleared: uid=${uid}`);
    return res.json({ ok: true });

  } catch (err) {
    // Fail open — server error must not block a legitimate first checkout.
    console.warn(`[pre-checkout] Error for uid=${uid}, failing open:`, err.message);
    return res.json({ ok: true });
  }
});

// ── Stale pending-enrollment monitoring ───────────────────────────────────────
// pending_enrollments records are created when the webhook can't find a
// matching Firebase account (the customer paid before signing up — see the
// stash logic above). The expected reconciliation path is: they create or
// log into an account with the same email, verify it, and /claim-enrollment
// applies the purchase. A record still sitting here ~48h later usually means
// that path stalled — they never came back, signed up with a different
// email, or are stuck on the email_verified gate without realizing why.
// That's a real "paid and got nothing" situation that deserves a human to
// look at it (and possibly enroll them manually), not silent data rot.
//
// Render's free tier has no managed cron, so "scheduled job" here means an
// in-process interval — it only catches stale records while this instance
// happens to be awake, which for a low-traffic box is an honest limitation,
// not a guarantee. The admin endpoint below is the authoritative, on-demand
// counterpart: point an external uptime monitor at it on a daily schedule
// (which has the side benefit of keeping the instance warm) for a check that
// doesn't depend on this process's uptime.
const STALE_PENDING_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

// ── Alert delivery ────────────────────────────────────────────────────────
// Pure console.warn logging is easy to miss — Render's free tier doesn't
// push log alerts, so a stale record could sit unseen for weeks. This sends
// an actual notification, configured by env var (set either, both, or
// neither):
//
//   ALERT_EMAIL_TO     — an email address to notify. Reuses the existing
//                        Resend integration (and RESEND_API_KEY) above —
//                        nothing new to provision if that's already set up.
//   ALERT_WEBHOOK_URL  — a Slack or Discord "incoming webhook" URL. The
//                        payload below sends both `text` (which Slack reads)
//                        and `content` (which Discord requires) so the same
//                        code works for either without needing to know which
//                        one you're pointed at.
//
// If NEITHER is set — or every configured channel fails to deliver — this
// falls back to the original console.warn behavior, so a stale batch never
// goes completely unrecorded even with zero configuration.
async function sendStaleEnrollmentAlert(stale) {
  const plural  = stale.length === 1 ? '' : 's';
  const lines   = stale.map(s =>
    `• ${s.email} — Stripe session ${s.stripeSessionId || '(none)'} — ` +
    (s.ageHours === null ? 'age unknown (missing timestamp)' : `${s.ageHours}h old`)
  );
  const summary =
    `${stale.length} unclaimed Stripe purchase${plural} pending enrollment for more than 48 hours. ` +
    `These customers paid but may not have course access yet:\n\n` + lines.join('\n');

  let delivered = false;

  if (process.env.ALERT_EMAIL_TO) {
    try {
      const ok = await sendViaResend({
        to:      process.env.ALERT_EMAIL_TO,
        subject: `[CCA] ${stale.length} stale pending enrollment${plural} need review`,
        text:    summary,
      });
      delivered = delivered || ok;
    } catch (err) {
      console.error('[alert] email delivery threw:', err.message);
    }
  }

  if (process.env.ALERT_WEBHOOK_URL) {
    try {
      const resp = await fetch(process.env.ALERT_WEBHOOK_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: summary, content: summary }),
      });
      if (resp.ok) {
        delivered = true;
      } else {
        console.error('[alert] webhook delivery failed:', resp.status, await resp.text());
      }
    } catch (err) {
      console.error('[alert] webhook delivery threw:', err.message);
    }
  }

  if (!delivered) {
    // Covers two cases at once: no channel env var was set at all, or every
    // configured channel failed above. Either way, the data still lands
    // somewhere durable (Render's log dashboard).
    console.warn(
      `[pending_enrollments] ${stale.length} unclaimed record(s) older than 48h — needs manual review ` +
      `(no alert channel configured or delivery failed; set ALERT_EMAIL_TO or ALERT_WEBHOOK_URL to get pinged):`,
      JSON.stringify(stale)
    );
  }
}

async function findStalePendingEnrollments() {
  const cutoff = Date.now() - STALE_PENDING_THRESHOLD_MS;
  const snap   = await db.collection('pending_enrollments').get();
  const stale  = [];
  snap.forEach(doc => {
    const data = doc.data();
    const createdAtMs = (data.createdAt && typeof data.createdAt.toMillis === 'function')
      ? data.createdAt.toMillis()
      : null;
    // Missing timestamp (e.g. a write that raced serverTimestamp resolution)
    // is flagged as stale too — better to over-report than silently miss one.
    if (createdAtMs === null || createdAtMs <= cutoff) {
      stale.push({
        email:           data.email || doc.id,
        stripeSessionId: data.stripeSessionId || null,
        ageHours:        createdAtMs === null ? null : Math.round((Date.now() - createdAtMs) / 3600000),
      });
    }
  });
  return stale;
}

async function checkStalePendingEnrollmentsAndAlert() {
  try {
    const stale = await findStalePendingEnrollments();
    if (stale.length) {
      await sendStaleEnrollmentAlert(stale);
    }
  } catch (err) {
    console.error('[pending_enrollments] stale check failed:', err.message);
  }
}

// Once shortly after boot (catches anything that piled up while this
// instance was asleep), then every 6 hours for as long as the process stays
// up. NOTE: on Render's free tier the dyno sleeps after ~15 minutes idle, so
// this interval is a best-effort backstop, not a reliable schedule — see the
// admin endpoint + external-scheduler note below for the dependable path.
setTimeout(checkStalePendingEnrollmentsAndAlert, 60 * 1000);
setInterval(checkStalePendingEnrollmentsAndAlert, 6 * 60 * 60 * 1000);

// GET /admin/stale-pending-enrollments
// Header: x-admin-key: <ADMIN_API_KEY>
//
// On-demand, authoritative listing of unclaimed pending_enrollments older
// than 48h — email, Stripe session ID, and age in hours for each — AND the
// trigger point that actually fires the alert (see sendStaleEnrollmentAlert)
// when the list is non-empty. Returns 401 (route effectively disabled) if
// ADMIN_API_KEY isn't set, so it can't be hit with an empty/guessable key.
//
// ┌─────────────────────────────────────────────────────────────────────┐
// │ SET THIS UP: point an external scheduler at this endpoint            │
// │                                                                       │
// │ The in-process interval above only runs while the dyno happens to    │
// │ be awake — on Render's free tier that's not guaranteed. For a        │
// │ dependable check, use a free service like https://cron-job.org (or   │
// │ UptimeRobot, Better Uptime, etc.) to send a periodic GET here, e.g.  │
// │ every 4-6 hours:                                                      │
// │                                                                       │
// │   URL:     https://claude-certified-architect.onrender.com/admin/    │
// │            stale-pending-enrollments                                 │
// │   Method:  GET                                                       │
// │   Header:  x-admin-key: <your ADMIN_API_KEY value>                   │
// │                                                                       │
// │ This does double duty: it surfaces stale records on a schedule you   │
// │ control (independent of this process's uptime), AND every hit keeps  │
// │ the instance warm — directly helping the cold-start problem this     │
// │ same audit flagged for the Stripe webhook and /claim-enrollment.     │
// └─────────────────────────────────────────────────────────────────────┘
app.get('/admin/stale-pending-enrollments', async (req, res) => {
  if (!process.env.ADMIN_API_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const stale = await findStalePendingEnrollments();
    if (stale.length) {
      // Awaited rather than fire-and-forget: this route is meant to be hit
      // by an infrequent external scheduler, not a latency-sensitive
      // client — better to spend an extra second guaranteeing the alert was
      // attempted than risk losing it if the process idles out right after
      // the response goes out.
      await sendStaleEnrollmentAlert(stale);
    }
    return res.json({ ok: true, count: stale.length, stale });
  } catch (err) {
    console.error('[pending_enrollments] admin listing failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Diagnostic email capture ──────────────────────────────────────────────────
// POST /diagnostic-email
// Body: { email: string, results: { estimatedScore, passScore, weakestDomain,
//          weakestDomainWeight, domains: [{ label, examWeight, correct, total, pct }] } }
//
// 1. Logs to console (guaranteed capture even if DB/email fails)
// 2. Persists to Firestore diagnostic_leads collection
// 3. Emails results via Resend (requires RESEND_API_KEY env var +
//    claudecertifiedarchitects.com domain verified in Resend dashboard)
//
app.post('/diagnostic-email', express.json(), async (req, res) => {
  const { email, results } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  // 1. Console log — always captured in Render logs
  console.log('DIAGNOSTIC_LEAD', JSON.stringify({
    email,
    estimatedScore: results?.estimatedScore,
    weakestDomain:  results?.weakestDomain,
  }));

  // 2. Persist to Firestore (non-blocking)
  try {
    await db.collection('diagnostic_leads').add({
      email,
      results:     results || null,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      source:      'diagnostic',
    });
  } catch (err) {
    console.error('Firestore write failed (lead still logged):', err.message);
  }

  // 3. Send results email via Resend
  if (results) {
    const score    = results.estimatedScore || 0;
    const passMark = results.passScore || 720;
    const verdict  = score >= passMark
      ? '✅ Strong result — you look ready!'
      : score >= passMark * 0.85
        ? "🟡 Close — a bit more practice and you'll be there"
        : '🔴 Good start — let\'s fill those gaps';

    const domainRows = (results.domains || [])
      .map(d => `  • ${d.label}: ${d.correct}/${d.total} (${d.pct}%) — ${d.examWeight}% of exam`)
      .join('\n');

    const text = `Hi,

Here are your CCA Diagnostic Quiz results:

${verdict}

Estimated score: ${score} / 1,000  (passing mark: ${passMark})

Domain breakdown:
${domainRows}

Weakest area: ${results.weakestDomain} (${results.weakestDomainWeight}% of the real exam)

Want to close the gap? The full 400-question practice bank covers every domain at real exam weightings, with detailed explanations for every answer.

👉 https://claudecertifiedarchitects.com

Good luck with your studies!
— Claude Certified Architects`;

    await sendViaResend({
      to:      email,
      subject: `Your CCA Diagnostic Results — ${score}/1,000`,
      text,
    });
  }

  return res.json({ ok: true });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Webhook server running.'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Stripe webhook server listening on port ${PORT}`));
