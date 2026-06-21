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
const crypto     = require('crypto');

// ── Resend helper ─────────────────────────────────────────────────────────────
// Sends transactional email via Resend.com (https://resend.com).
// Uses the built-in fetch available in Node 18+.
// Returns true on success, false on failure (never throws).
async function sendViaResend({ to, subject, text, html, replyTo, listUnsubscribeUrl }) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[resend] RESEND_API_KEY not set — email skipped.');
    return false;
  }
  try {
    const payload = {
      from:    'CCA Practice <noreply@claudecertifiedarchitects.com>',
      to:      [to],
      subject,
      text,
    };
    if (html)              payload.html     = html;
    if (replyTo)           payload.reply_to = replyTo;
    if (listUnsubscribeUrl) {
      payload.headers = {
        'List-Unsubscribe':      `<${listUnsubscribeUrl}>, <mailto:support@claudecertifiedarchitects.com?subject=Unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
    }
    const resp = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
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
async function fireGA4PurchaseEvent(sessionId, ga4ClientId, uid, gclidAw, ga4SessionId, ga4SessionNumber) {
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
            params: Object.assign(
              {
                currency:       'USD',
                value:          49.0,
                transaction_id: sessionId,
                items: [{ item_id: 'cca_exam_prep', item_name: 'CCA Exam Prep', price: 49.0, quantity: 1 }],
              },
              // session_id + session_number stitch this server-side hit to the
              // original browser session so GA4 reports source/medium correctly
              // instead of "(not set) / (not set)".
              ga4SessionId     ? { session_id:     String(ga4SessionId) }     : {},
              ga4SessionNumber ? { session_number: Number(ga4SessionNumber) } : {}
            ),
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
        let ga4ClientId    = null;
        let gclidAw        = null;
        let ga4SessionId   = null;
        let ga4SessionNumber = null;
        try {
          const attrSnap = await db.collection('users').doc(uid).get();
          if (attrSnap.exists) {
            const d = attrSnap.data();
            ga4ClientId    = d.ga4ClientId     || null;
            gclidAw        = d.gclid_aw        || null;
            ga4SessionId   = d.ga4SessionId    || null;
            ga4SessionNumber = d.ga4SessionNumber != null ? d.ga4SessionNumber : null;
          }
        } catch (e) { /* best-effort, never block enrollment */ }

        await auth.setCustomUserClaims(uid, { ...existingClaims, enrolled: true });

        await db.collection('users').doc(uid).set(
          {
            enrolled:        true,
            enrolledAt:      admin.firestore.FieldValue.serverTimestamp(),
            email:           customerEmail || userRecord.email,
            stripeSessionId: session.id,
            ...(gclidAw ? { gclid_aw: gclidAw } : {}),
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
        fireGA4PurchaseEvent(session.id, ga4ClientId, uid, gclidAw, ga4SessionId, ga4SessionNumber).catch(() => {});
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
      let ga4ClientId    = null;
      let gclidAw        = null;
      let ga4SessionId   = null;
      let ga4SessionNumber = null;
      try {
        const attrSnap = await db.collection('users').doc(uid).get();
        if (attrSnap.exists) {
          const d = attrSnap.data();
          ga4ClientId    = d.ga4ClientId     || null;
          gclidAw        = d.gclid_aw        || null;
          ga4SessionId   = d.ga4SessionId    || null;
          ga4SessionNumber = d.ga4SessionNumber != null ? d.ga4SessionNumber : null;
        }
      } catch (e) { /* best-effort */ }

      await auth.setCustomUserClaims(uid, { ...existingClaims, enrolled: true });

      await db.collection('users').doc(uid).set(
        {
          enrolled:        true,
          enrolledAt:      admin.firestore.FieldValue.serverTimestamp(),
          email:           customerEmail,
          stripeSessionId: session.id,
          ...(gclidAw ? { gclid_aw: gclidAw } : {}),
        },
        { merge: true }
      );

      // Clear any stale pending record for this email (e.g. a Stripe retry
      // that arrived after the account was created and matched normally).
      db.collection('pending_enrollments').doc(customerEmail.toLowerCase()).delete().catch(() => {});

      console.log(`Enrolled: ${customerEmail} (${uid})`);
      fireGA4PurchaseEvent(session.id, ga4ClientId, uid, gclidAw, ga4SessionId, ga4SessionNumber).catch(() => {});
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

    // Read attribution data before the enrollment write so gclid_aw can be
    // included in the Firestore record (for Stripe→ad-click cross-referencing).
    let ga4ClientId    = null;
    let gclidAw        = null;
    let ga4SessionId   = null;
    let ga4SessionNumber = null;
    try {
      const attrSnap = await db.collection('users').doc(uid).get();
      if (attrSnap.exists) {
        const d = attrSnap.data();
        ga4ClientId    = d.ga4ClientId     || null;
        gclidAw        = d.gclid_aw        || null;
        ga4SessionId   = d.ga4SessionId    || null;
        ga4SessionNumber = d.ga4SessionNumber != null ? d.ga4SessionNumber : null;
      }
    } catch (e) { /* best-effort */ }

    await auth.setCustomUserClaims(uid, { ...existingClaims, enrolled: true });
    await db.collection('users').doc(uid).set(
      {
        enrolled:        true,
        enrolledAt:      admin.firestore.FieldValue.serverTimestamp(),
        email:           userRecord.email,
        stripeSessionId: pending.stripeSessionId || null,
        ...(gclidAw ? { gclid_aw: gclidAw } : {}),
      },
      { merge: true }
    );
    await pendingRef.delete();

    // Fire GA4 server-side purchase event for claimed pending enrollments.
    fireGA4PurchaseEvent(
      pending.stripeSessionId || ('claim_' + uid),
      ga4ClientId,
      uid,
      gclidAw,
      ga4SessionId,
      ga4SessionNumber
    ).catch(() => {});

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

// ══════════════════════════════════════════════════════════════════════════════
// NURTURE SEQUENCE — 3 emails (D+1, D+3, D+7) for diagnostic leads who haven't
// purchased. Triggered once daily by an external cron (cron-job.org). All sends
// go via the existing sendViaResend() helper above.
// ══════════════════════════════════════════════════════════════════════════════

// Per-domain question counts (must match DOMAIN_Q_COUNT in diagnostic/index.html)
const NURTURE_DOMAIN_Q_COUNT = {
  'Agentic Architecture & Orchestration':  109,
  'Claude Code Configuration':              80,
  'Prompt Engineering & Structured Output': 80,
  'Tool Design & MCP Integration':          72,
  'Context Management & Reliability':       60,
};

// One specific, actionable study tip per domain
const STUDY_TIPS = {
  'Agentic Architecture & Orchestration':
    'Focus on where to place human-in-the-loop checkpoints — the exam tests this precisely. ' +
    'The rule: any action that is hard to reverse (writing data, spending money, scheduling ' +
    'real-world events) needs human approval before execution. Read-only calls are generally ' +
    'safe to run automatically. Practice sketching a ReAct loop (Reason → Act → ' +
    'Observe) and marking every write step with a checkpoint.',

  'Claude Code Configuration':
    'Know CLAUDE.md inside-out: what goes in it (project scope, allowed commands, ' +
    'never-touch files, conventions), how it differs from a system prompt, and how sub-agents ' +
    'inherit or override it. Also know where MCP servers are configured ' +
    '(.claude/settings.json). Exam questions hinge on the configuration hierarchy: global ' +
    'settings vs. project settings vs. per-session overrides.',

  'Prompt Engineering & Structured Output':
    'The most-tested technique is separating reasoning from output. Use a planning step ' +
    'that asks Claude to think through the problem before producing the final answer, and ' +
    'capture that thinking in a scratchpad rather than letting it bleed into the response. ' +
    'For structured output, know when to use JSON schema enforcement (strict contracts with ' +
    'external systems) vs. plain prose, and always add post-processing validation as a ' +
    'second layer on top of prompt instructions.',

  'Tool Design & MCP Integration':
    'Memorize the three-field formula for any tool definition: (1) a verb-phrase name ' +
    '(get_user_profile, search_docs), (2) a natural-language description that tells Claude ' +
    'exactly when and why to call it, and (3) typed parameters with explicit required vs. ' +
    'optional flags and a description for each. Exam questions almost always hinge on ' +
    'whether a schema is complete enough for Claude to call the tool correctly without ' +
    'guessing intent.',

  'Context Management & Reliability':
    'The highest-yield insight: important constraints that must hold throughout a long ' +
    'conversation should be restated near the end of the context (recency effect), not ' +
    'just at the top. Understand how to summarize earlier turns while preserving key ' +
    'decisions, and know the difference between system prompt slots (persistent) and ' +
    'conversation turns (scrolled away). Model version pinning in production is also ' +
    'frequently tested.',
};

// One sample question per domain for Email 2 (index 10 in app.js — well clear of the
// 2-per-domain diagnostic pool)
const SAMPLE_QUESTIONS = {
  'Agentic Architecture & Orchestration': {
    q: 'A healthcare startup is building an agent that can schedule appointments and access patient records. At what point should the agent require human approval?',
    options: [
      'Only when the model confidence score is below 50%',
      'Before any action that modifies patient data or schedules real appointments',
      'Only when the patient explicitly asks to talk to a human',
      'Never, because the agent should be fully autonomous',
    ],
    correct: 1,
    explain: 'Human-in-the-loop checkpoints should be placed before any action with real-world consequences that are difficult or impossible to reverse, especially in sensitive domains like healthcare. Modifying patient data and scheduling real appointments are high-stakes actions that warrant human approval.',
  },
  'Claude Code Configuration': {
    q: 'You need to configure Claude Code to connect to a custom MCP server that provides access to your company\'s internal API documentation. Where do you add this configuration?',
    options: [
      'In the system prompt of each conversation',
      'In .claude/settings.json under the MCP server configuration section',
      'In a separate mcp-config.json at the project root',
      'In the CLAUDE.md file as a tool description',
    ],
    correct: 1,
    explain: 'MCP server configurations in Claude Code are defined in .claude/settings.json. This is where you specify the server\'s transport method, connection details, and any authentication needed. The settings file ensures the MCP server is available across all conversations without needing to reconfigure each time.',
  },
  'Prompt Engineering & Structured Output': {
    q: 'You want to prevent Claude from generating harmful content in a customer-facing chatbot. What is the most effective approach for output guardrails?',
    options: [
      'Trust that Claude\'s built-in safety is sufficient for all cases',
      'Implement layered guardrails: system prompt instructions defining boundaries, plus post-processing validation that checks outputs against content policies before showing them to users',
      'Add a disclaimer to every response',
      'Use temperature 0 to prevent creative outputs',
    ],
    correct: 1,
    explain: 'Layered guardrails provide defense in depth: system prompt instructions set behavioral boundaries, and post-processing validation acts as a safety net to catch anything that slips through. This two-layer approach is more robust than relying solely on either the model\'s built-in safety or prompt instructions alone.',
  },
  'Tool Design & MCP Integration': {
    q: 'What is MCP (Model Context Protocol) and why does it matter for building AI applications?',
    options: [
      'A proprietary Anthropic protocol for internal use only',
      'An open protocol that standardizes how AI applications connect to external data sources and tools, enabling interoperable integrations across different AI systems',
      'A messaging format for multi-model communication',
      'A compression algorithm for context windows',
    ],
    correct: 1,
    explain: 'MCP (Model Context Protocol) is an open protocol that standardizes the connection between AI applications and external tools and data sources. It matters because it creates an interoperable ecosystem where tool integrations can be reused across different AI applications rather than requiring custom integrations for each one.',
  },
  'Context Management & Reliability': {
    q: 'Your team is concerned about a model update changing behavior in production. What deployment strategy minimizes risk?',
    options: [
      'Update all production systems at once and roll back if there are issues',
      'Use model version pinning in production and implement canary deployment: test the new version with a small percentage of traffic before full rollout',
      'Never update the model version',
      'Let Anthropic decide when to update',
    ],
    correct: 1,
    explain: 'Model version pinning locks your production to a specific model version, preventing unexpected behavior changes. Canary deployment tests new versions with a small traffic percentage, allowing you to detect issues before they affect all users. This combination provides stability while enabling controlled upgrades.',
  },
};

// Leads submitted before this date are NEVER pulled into the sequence.
// Override with SEQUENCE_START env var (ISO date string) on Render.
const SEQUENCE_START = new Date(process.env.SEQUENCE_START || '2026-06-19T00:00:00Z');

// Stage order and minimum lead age before each email is eligible
const STAGE_ORDER       = ['d1', 'd3', 'd7'];
const STAGE_MIN_AGE_MS  = { d1: 22 * 3600000, d3: 70 * 3600000, d7: 166 * 3600000 };

const SITE_URL    = 'https://www.claudecertifiedarchitects.com';
const OPT_LETTERS = ['A', 'B', 'C', 'D', 'E'];

function nurtureCtaUrl(stage) {
  return `${SITE_URL}/?checkout=true&utm_source=email&utm_medium=nurture&utm_campaign=diagnostic_sequence&utm_content=${stage}`;
}

// ── Shared HTML email wrapper (table-based for email-client compatibility) ────
function emailWrap(bodyHtml, unsubUrl) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f5f3ea;font-family:Georgia,'Times New Roman',serif">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f3ea;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#ffffff;border:1px solid #d9d5ca;border-radius:8px;overflow:hidden">
  <tr><td style="background:#c4522c;padding:14px 28px">
    <span style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.78rem;font-weight:700;color:#ffffff;letter-spacing:.5px;text-transform:uppercase">Claude Certified Architects</span>
  </td></tr>
  <tr><td style="padding:32px 28px 28px;color:#191918;line-height:1.7">
${bodyHtml}
  </td></tr>
  <tr><td style="border-top:1px solid #d9d5ca;padding:16px 28px;background:#f5f3ea">
    <p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.68rem;color:#6f6f66;margin:0 0 5px;line-height:1.5">
      Claude Certified Architects — independent practice prep, not affiliated with or endorsed by Anthropic.<br>
      Questions? <a href="mailto:support@claudecertifiedarchitects.com" style="color:#6f6f66">support@claudecertifiedarchitects.com</a>
    </p>
    <p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.68rem;color:#6f6f66;margin:0">
      <a href="${unsubUrl}" style="color:#6f6f66;text-decoration:underline">Unsubscribe</a> from CCA study tips.
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function eP(text, extraStyle) {
  const s = extraStyle
    ? `font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.9rem;color:#191918;line-height:1.7;margin:0 0 16px;${extraStyle}`
    : `font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.9rem;color:#191918;line-height:1.7;margin:0 0 16px`;
  return `<p style="${s}">${text}</p>`;
}

function eBtn(label, url) {
  return `<div style="text-align:center;margin:28px 0">` +
    `<a href="${url}" style="display:inline-block;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;` +
    `font-size:.9rem;font-weight:700;color:#ffffff;background:#c4522c;padding:13px 30px;` +
    `border-radius:7px;text-decoration:none;letter-spacing:.1px">${label}</a></div>`;
}

// ── Email 1 (D+1): "What your CCA diagnostic actually told you" ───────────────
function buildEmail1(results, unsubUrl) {
  const score  = results.estimatedScore      || 0;
  const pass   = results.passScore           || 720;
  const gap    = pass - score;
  const above  = gap <= 0;
  const domain = results.weakestDomain       || 'Agentic Architecture & Orchestration';
  const weight = results.weakestDomainWeight || 27;
  const N      = NURTURE_DOMAIN_Q_COUNT[domain] || 80;
  const tip    = STUDY_TIPS[domain] || STUDY_TIPS['Agentic Architecture & Orchestration'];
  const cta    = nurtureCtaUrl('d1');

  const subject = 'What your CCA diagnostic actually told you';

  // ── plain text ──
  const scoreLine = above
    ? `Your result: ${score}/1,000 — above the 720 passing standard on a 10-question sample.\nYour weakest domain: ${domain} (${weight}% of the real exam).`
    : `Your result: ${score}/1,000 — ${gap} points below the 720 passing standard.\nYour weakest domain: ${domain} (${weight}% of the real exam).`;
  const context = above
    ? `\nThe real exam is 60 questions drawn from a much larger pool, covering harder scenarios than a short sample can surface. Your weakest area — ${domain} (${weight}% of the exam) — is where the full exam will probe hardest.\n`
    : `\n${domain} accounts for ${weight}% of your actual exam score. Closing that domain first gives you the biggest return on your study time.\n`;
  const ctaCopy = above
    ? `The full bank has ${N} questions in ${domain} alone — run a timed simulation and confirm your readiness before you book.`
    : `The full bank has ${N} questions in ${domain} alone, every answer fully explained. That’s where the gap closes — not from rereading docs, but from scenario-based practice exactly like the real exam.`;

  const text = [
    'Hi,',
    '',
    'You took the CCA Foundations Diagnostic and asked for your results. Here’s what those numbers mean — plus one study tip worth more than the score alone.',
    '',
    scoreLine,
    context,
    `── Study tip for ${domain} ──`,
    '',
    tip,
    '',
    '── What to do next ──',
    '',
    ctaCopy,
    '',
    `Close the gap — $49:\n${cta}`,
    '',
    'Good luck,',
    '— Claude Certified Architects',
    '',
    '─────────────────────────────────────────',
    'Claude Certified Architects — independent practice prep, not affiliated with or endorsed by Anthropic.',
    'Reply-To: support@claudecertifiedarchitects.com',
    `To stop receiving these emails: ${unsubUrl}`,
  ].join('\n');

  // ── HTML ──
  const scoreHtml = above
    ? eP(`Your result: <strong>${score}/1,000</strong> — above the 720 passing standard on a 10-question sample. Your weakest domain: <strong>${domain}</strong> (${weight}% of the real exam).`)
    : eP(`Your result: <strong>${score}/1,000</strong> — <strong>${gap} points below</strong> the 720 passing standard. Your weakest domain: <strong>${domain}</strong> (${weight}% of the real exam).`);
  const contextHtml = above
    ? eP(`The real exam is 60 questions drawn from a much larger pool. Your weakest area — <strong>${domain}</strong> (${weight}% of the exam) — is where the full exam will probe hardest.`)
    : eP(`${domain} accounts for <strong>${weight}%</strong> of your actual exam score. Closing that domain first gives you the biggest return on your study time.`);
  const tipBlock =
    `<div style="background:#f5f3ea;border-left:3px solid #c4522c;padding:14px 18px;margin:20px 0;border-radius:0 6px 6px 0">` +
    `<p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.68rem;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#b04928;margin:0 0 8px">Study tip — ${domain}</p>` +
    `<p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.88rem;color:#191918;line-height:1.65;margin:0">${tip}</p>` +
    `</div>`;
  const ctaHtml = above
    ? eP(`The full bank has <strong>${N} questions in ${domain}</strong> alone — run a timed simulation before you book.`)
    : eP(`The full bank has <strong>${N} questions in ${domain}</strong> alone, every answer fully explained. That’s where this gap closes.`);

  const bodyHtml =
    eP('Hi,') +
    eP('You took the CCA Foundations Diagnostic and asked for your results. Here’s what those numbers mean — plus one study tip worth more than the score alone.') +
    scoreHtml + contextHtml + tipBlock + ctaHtml +
    eBtn('Close the gap — $49', cta);

  return { subject, text, html: emailWrap(bodyHtml, unsubUrl) };
}

// ── Email 2 (D+3): "Why $49 beats a $99 retake" ─────────────────────────────
function buildEmail2(results, unsubUrl) {
  const score  = results.estimatedScore      || 0;
  const pass   = results.passScore           || 720;
  const gap    = pass - score;
  const above  = gap <= 0;
  const domain = results.weakestDomain       || 'Agentic Architecture & Orchestration';
  const sampleQ = SAMPLE_QUESTIONS[domain] || SAMPLE_QUESTIONS['Agentic Architecture & Orchestration'];
  const correctLetter = OPT_LETTERS[sampleQ.correct];
  const cta = nurtureCtaUrl('d3');

  const subject = 'Why $49 beats a $99 retake';

  // ── plain text ──
  const stakesPara = above
    ? `Your diagnostic showed you at passing level on a 10-question sample. The real exam is 60 questions at a harder difficulty curve — and it costs $99 (USD) to sit. A mandatory waiting period applies between attempts, so an underprepared attempt costs both the registration fee and weeks before you can retry.`
    : `You’re currently ${gap} points below the 720 passing standard. The real CCA Foundations exam costs $99 (USD) — and a mandatory waiting period applies between attempts. Sitting it underprepared means losing both the fee and weeks before you can retry.`;
  const optText = sampleQ.options.map((o, i) => `  ${OPT_LETTERS[i]}. ${o}`).join('\n');

  const text = [
    'Hi,',
    '',
    stakesPara,
    '',
    '$49 for 400 practice questions is the straightforward hedge against that outcome. Here’s a taste of what those questions look like:',
    '',
    `── Sample question (${domain}) ──`,
    '',
    sampleQ.q,
    '',
    optText,
    '',
    `Correct answer: ${correctLetter}. ${sampleQ.options[sampleQ.correct]}`,
    '',
    `Why: ${sampleQ.explain}`,
    '',
    '── The full bank ──',
    '',
    '400 questions exactly like this, across all five exam domains. Every answer includes a full explanation — not just what’s right, but why each wrong option is wrong.',
    '',
    '$49. 10-day money-back guarantee. No risk.',
    '',
    `Unlock access:\n${cta}`,
    '',
    '— Claude Certified Architects',
    '',
    '─────────────────────────────────────────',
    'Independent practice prep, not affiliated with or endorsed by Anthropic.',
    'Reply-To: support@claudecertifiedarchitects.com',
    `To stop receiving these emails: ${unsubUrl}`,
  ].join('\n');

  // ── HTML ──
  const stakesHtml = above
    ? eP(`Your diagnostic showed you at passing level on a short sample. The real exam is 60 questions at a harder curve — and it costs <strong>$99 (USD)</strong>. A mandatory waiting period applies between attempts, so one underprepared attempt costs both the fee and weeks of time.`)
    : eP(`You’re currently <strong>${gap} points below the 720 passing standard</strong>. The real CCA Foundations exam costs <strong>$99 (USD)</strong> — and a mandatory waiting period applies between attempts. Sitting it underprepared means losing both the fee and weeks before you can retry.`);

  const optRows = sampleQ.options.map((o, i) => {
    const isCorrect = i === sampleQ.correct;
    const bg  = isCorrect ? 'background:#f0fdf4;' : '';
    const col = isCorrect ? 'color:#1a4d3a;font-weight:600;' : 'color:#5a5a52;';
    const lCol = isCorrect ? '#1a4d3a' : '#6f6f66';
    const tick = isCorrect ? ' <span style="color:#2d7a5f;font-size:.72rem;margin-left:6px">✓ Correct</span>' : '';
    return `<tr><td style="padding:7px 12px;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.85rem;${bg}${col}border-radius:4px"><strong style="color:${lCol}">${OPT_LETTERS[i]}.</strong> ${o}${tick}</td></tr>`;
  }).join('');

  const questionBlock =
    `<div style="background:#f5f3ea;border:1px solid #d9d5ca;border-radius:8px;padding:20px;margin:24px 0">` +
    `<p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.68rem;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#b04928;margin:0 0 10px">Sample question — ${domain}</p>` +
    `<p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.88rem;font-weight:600;color:#191918;line-height:1.6;margin:0 0 14px">${sampleQ.q}</p>` +
    `<table width="100%" cellpadding="0" cellspacing="4" border="0">${optRows}</table>` +
    `<p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.8rem;color:#5a5a52;line-height:1.55;margin:14px 0 0;border-top:1px solid #d9d5ca;padding-top:12px"><strong>Why:</strong> ${sampleQ.explain}</p>` +
    `</div>`;

  const bodyHtml =
    eP('Hi,') + stakesHtml +
    eP('$49 for 400 practice questions is the straightforward hedge. Here’s a taste:') +
    questionBlock +
    eP('400 questions like this, across all five domains. Every answer fully explained — not just what’s right, but why each wrong option is wrong.') +
    eP('$49. 10-day money-back guarantee. No risk.', 'font-weight:700') +
    eBtn('Unlock access — $49', cta);

  return { subject, text, html: emailWrap(bodyHtml, unsubUrl) };
}

// ── Email 3 (D+7): "Your CCA gap is still open" ──────────────────────────────
function buildEmail3(results, unsubUrl) {
  const score  = results.estimatedScore      || 0;
  const pass   = results.passScore           || 720;
  const gap    = pass - score;
  const above  = gap <= 0;
  const domain = results.weakestDomain       || 'Agentic Architecture & Orchestration';
  const cta    = nurtureCtaUrl('d7');

  const subject = above ? 'One week on — is your CCA prep locked in?' : 'Your CCA gap is still open';

  // ── plain text ──
  const opening = above
    ? `A week ago you scored above the 720 passing standard on a short diagnostic sample.\n\nThe real exam is 60 questions — broader, harder, drawn from a much larger pool. A passing sample is a good sign, not a guarantee.`
    : `A week ago you were ${gap} points below the 720 passing standard, with ${domain} as your weakest area.\n\nThat gap doesn’t close on its own.`;

  const text = [
    'Hi,',
    '',
    opening,
    '',
    'If you’ve been studying, great — the full practice bank is the best thing you can add at this point: 400 scenario-based questions, domain-weighted exactly like the real exam, every answer fully explained.',
    '',
    `If now isn’t the right time, that’s fine. Come back when you’re ready:\n${cta}`,
    '',
    `If you want to close the gap: $49, 10-day money-back guarantee. Try it for a week — if you don’t feel more confident in ${domain}, get a full refund. No risk.`,
    '',
    'Good luck with the exam.',
    '— Claude Certified Architects',
    '',
    '─────────────────────────────────────────',
    'Independent practice prep, not affiliated with or endorsed by Anthropic.',
    'Reply-To: support@claudecertifiedarchitects.com',
    `To stop receiving these emails: ${unsubUrl}`,
  ].join('\n');

  // ── HTML ──
  const openingHtml = above
    ? eP('A week ago you scored above the 720 passing standard on a short sample. The real exam is 60 questions — broader, harder, drawn from a much larger pool. A passing sample is a good sign, not a guarantee.')
    : eP(`A week ago you were <strong>${gap} points below the 720 passing standard</strong>, with <strong>${domain}</strong> as your weakest area.`) +
      eP('That gap doesn’t close on its own.');

  const riskBlock =
    `<div style="background:#f0fdf4;border:1.5px solid #a7f3d0;border-radius:8px;padding:18px 20px;margin:20px 0">` +
    `<p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.88rem;color:#191918;line-height:1.65;margin:0">` +
    `<strong style="color:#1a4d3a">10-day money-back guarantee.</strong> Try the full 400-question bank for a week. ` +
    `If you don’t feel more confident in ${domain}, get a full refund — no questions asked.</p>` +
    `</div>`;

  const bodyHtml =
    eP('Hi,') + openingHtml +
    eP('The full practice bank is the best thing you can add at this stage: 400 scenario-based questions, domain-weighted exactly like the real exam, every answer fully explained.') +
    riskBlock +
    eP('If now isn’t the right time, come back when you’re ready. Good luck with the exam.') +
    eBtn('Close the gap — $49, risk-free', cta);

  return { subject, text, html: emailWrap(bodyHtml, unsubUrl) };
}

// ── GET /unsubscribe ──────────────────────────────────────────────────────────
// Finds the lead by unsubToken, sets unsubscribed:true, returns a confirmation page.
app.get('/unsubscribe', async (req, res) => {
  const token = (req.query.token || '').trim();
  if (!token) {
    return res.status(400).send(unsubPage('Missing or invalid unsubscribe link.', false));
  }
  try {
    const snap = await db.collection('diagnostic_leads')
      .where('unsubToken', '==', token)
      .limit(1)
      .get();
    if (snap.empty) {
      // Already unsubscribed or invalid token — treat as success to avoid leaking info
      return res.send(unsubPage('You are unsubscribed. You will not receive further emails from us.', true));
    }
    await snap.docs[0].ref.set(
      { unsubscribed: true, unsubscribedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    console.log('[unsub] Unsubscribed token:', token);
    return res.send(unsubPage('Done — you\'ve been unsubscribed. You won\'t receive any further CCA study emails from us.', true));
  } catch (err) {
    console.error('[unsub] Error:', err.message);
    return res.status(500).send(unsubPage('Something went wrong. Email support@claudecertifiedarchitects.com to unsubscribe manually.', false));
  }
});

function unsubPage(message, success) {
  const icon = success ? '✓' : '⚠';
  const title = success ? 'Unsubscribed' : 'Problem';
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} — Claude Certified Architects</title>
<style>
body{margin:0;padding:40px 20px;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;background:#f5f3ea;color:#191918;text-align:center}
.card{max-width:440px;margin:0 auto;background:#fff;border:1px solid #d9d5ca;border-radius:10px;padding:36px 32px}
h1{font-size:1.2rem;font-weight:700;margin:0 0 12px}
p{font-size:.9rem;color:#5a5a52;line-height:1.65;margin:0 0 16px}
a{color:#b04928}
.icon{font-size:2rem;margin-bottom:14px}
</style></head><body>
<div class="card">
  <div class="icon">${icon}</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <p><a href="${SITE_URL}/">← Back to Claude Certified Architects</a></p>
  <p style="font-size:.72rem;color:#8a8a7f">Independent practice prep — not affiliated with or endorsed by Anthropic.</p>
</div>
</body></html>`;
}

// ── POST /nurture-send ────────────────────────────────────────────────────────
// Called once daily by cron-job.org. Auth: ?secret= or x-nurture-secret header.
// Dry-run: add ?dryRun=true to log decisions without sending or writing state.
//
// Required env vars: NURTURE_CRON_SECRET
// Optional env var:  SEQUENCE_START (ISO date — defaults to 2026-06-19)
app.post('/nurture-send', express.json(), async (req, res) => {
  // 1. Authenticate
  const provided = (req.query.secret || req.headers['x-nurture-secret'] || '').trim();
  if (!process.env.NURTURE_CRON_SECRET || provided !== process.env.NURTURE_CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query.dryRun === 'true' || req.query.dryRun === '1';
  console.log(`[nurture] Run started — dryRun=${dryRun} sequenceStart=${SEQUENCE_START.toISOString()}`);

  const result = { ok: true, dryRun, sent: 0, skipped: 0, errors: 0, details: [] };

  let snap;
  try {
    snap = await db.collection('diagnostic_leads').get();
  } catch (err) {
    console.error('[nurture] Failed to load diagnostic_leads:', err.message);
    return res.status(500).json({ error: 'DB read failed', message: err.message });
  }

  const now = Date.now();

  for (const doc of snap.docs) {
    const lead  = doc.data();
    const email = (lead.email || '').toLowerCase().trim();
    const tag   = `[nurture][${email || doc.id}]`;

    try {
      // 2. SEQUENCE_START cutoff — never touch old leads
      const submittedAt = lead.submittedAt ? lead.submittedAt.toDate() : null;
      if (!submittedAt || submittedAt < SEQUENCE_START) {
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: null, reason: 'before_cutoff' });
        continue;
      }

      // Validate email
      if (!email || !email.includes('@')) {
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: null, reason: 'invalid_email' });
        continue;
      }

      // 3. Unsubscribed?
      if (lead.unsubscribed) {
        console.log(`${tag} skip: unsubscribed`);
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: null, reason: 'unsubscribed' });
        continue;
      }

      // 4. Buyer suppression — check pending_enrollments then enrolled users
      const pendingDoc = await db.collection('pending_enrollments').doc(email).get();
      if (pendingDoc.exists) {
        console.log(`${tag} skip: buyer_pending`);
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: null, reason: 'buyer_pending' });
        continue;
      }
      const usersSnap = await db.collection('users').where('email', '==', email).limit(1).get();
      if (!usersSnap.empty && usersSnap.docs[0].data().enrolled === true) {
        console.log(`${tag} skip: buyer_enrolled`);
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: null, reason: 'buyer_enrolled' });
        continue;
      }

      // 5. Find the earliest unsent stage that is now due
      const ageMs      = now - submittedAt.getTime();
      const sentStages = lead.sequenceSent || [];
      let stageToSend  = null;

      for (const stage of STAGE_ORDER) {
        if (ageMs >= STAGE_MIN_AGE_MS[stage] && !sentStages.includes(stage)) {
          stageToSend = stage;
          break;
        }
      }

      if (!stageToSend) {
        const ageH = Math.round(ageMs / 3600000);
        console.log(`${tag} skip: no_due_stage (age=${ageH}h sent=[${sentStages.join(',')}])`);
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: null, reason: 'no_due_stage' });
        continue;
      }

      // 6. Dry-run: log intent without sending or writing state
      if (dryRun) {
        console.log(`${tag} would_send: ${stageToSend}`);
        result.sent++;
        result.details.push({ email, action: 'would_send', stage: stageToSend, reason: null });
        continue;
      }

      // 7. Ensure unsubscribe token exists
      let unsubToken = lead.unsubToken;
      if (!unsubToken) {
        unsubToken = crypto.randomBytes(20).toString('hex');
      }
      const unsubUrl = `https://claude-certified-architect.onrender.com/unsubscribe?token=${unsubToken}`;

      // 8. Build email content
      const emailContent =
        stageToSend === 'd1' ? buildEmail1(lead.results || {}, unsubUrl) :
        stageToSend === 'd3' ? buildEmail2(lead.results || {}, unsubUrl) :
                               buildEmail3(lead.results || {}, unsubUrl);

      // 9. Send via Resend
      const ok = await sendViaResend({
        to:                 lead.email,
        subject:            emailContent.subject,
        text:               emailContent.text,
        html:               emailContent.html,
        replyTo:            'support@claudecertifiedarchitects.com',
        listUnsubscribeUrl: unsubUrl,
      });

      if (ok) {
        // 10. Write state ONLY after confirmed send
        await doc.ref.set({
          sequenceSent:  admin.firestore.FieldValue.arrayUnion(stageToSend),
          unsubToken,
          lastNurtureAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        console.log(`${tag} sent: ${stageToSend}`);
        result.sent++;
        result.details.push({ email, action: 'sent', stage: stageToSend, reason: null });
      } else {
        console.error(`${tag} resend_rejected: ${stageToSend}`);
        result.errors++;
        result.details.push({ email, action: 'error', stage: stageToSend, reason: 'resend_rejected' });
      }

    } catch (err) {
      // Per-lead isolation: one failure must never abort the run
      console.error(`${tag} error:`, err.message);
      result.errors++;
      result.details.push({ email, action: 'error', stage: null, reason: err.message });
    }
  }

  console.log(`[nurture] Run complete — sent=${result.sent} skipped=${result.skipped} errors=${result.errors} dryRun=${dryRun}`);
  return res.json(result);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Stripe webhook server listening on port ${PORT}`));
