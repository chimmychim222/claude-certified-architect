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

// ── Firebase init ─────────────────────────────────────────────────────────────
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const auth = admin.auth();
const db   = admin.firestore();
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

    const session       = event.data.object;
    const customerEmail = session.customer_details?.email || session.customer_email;

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

    console.log(`Claimed pending enrollment: ${email} (${uid})`);
    return res.json({ ok: true, enrolled: true });

  } catch (err) {
    console.error('Claim-enrollment error:', err.message);
    return res.status(500).json({ error: err.message });
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

async function logStalePendingEnrollments() {
  try {
    const stale = await findStalePendingEnrollments();
    if (stale.length) {
      console.warn(
        `[pending_enrollments] ${stale.length} unclaimed record(s) older than 48h — needs manual review:`,
        JSON.stringify(stale)
      );
    }
  } catch (err) {
    console.error('[pending_enrollments] stale check failed:', err.message);
  }
}

// Once shortly after boot (catches anything that piled up while this
// instance was asleep), then every 6 hours for as long as the process stays up.
setTimeout(logStalePendingEnrollments, 60 * 1000);
setInterval(logStalePendingEnrollments, 6 * 60 * 60 * 1000);

// GET /admin/stale-pending-enrollments
// Header: x-admin-key: <ADMIN_API_KEY>
//
// On-demand, authoritative listing of unclaimed pending_enrollments older
// than 48h — email, Stripe session ID, and age in hours for each — so
// support can find and manually resolve them regardless of whether the
// in-process interval above has run recently. Returns 401 (and the route is
// effectively disabled) if ADMIN_API_KEY isn't set, so this can't be hit
// with an empty/guessable key by accident.
app.get('/admin/stale-pending-enrollments', async (req, res) => {
  if (!process.env.ADMIN_API_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const stale = await findStalePendingEnrollments();
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
