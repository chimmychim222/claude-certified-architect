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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

    try {
      const userRecord     = await auth.getUserByEmail(customerEmail);
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

      console.log(`Enrolled: ${customerEmail} (${uid})`);
      return res.json({ ok: true, enrolled: uid });

    } catch (err) {
      console.error('Enrollment error:', err.message);
      return res.status(500).send(err.message);
    }
  }
);

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
