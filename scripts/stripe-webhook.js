/**
 * Stripe webhook server — runs on Railway (free tier).
 * When a customer pays via Stripe, this sets enrolled:true in Firebase.
 *
 * Environment variables to set in Railway dashboard:
 *   STRIPE_SECRET_KEY           — Stripe → Developers → API keys → Secret key
 *   STRIPE_WEBHOOK_SECRET       — Stripe → Developers → Webhooks → signing secret
 *   FIREBASE_SERVICE_ACCOUNT_JSON — full contents of your firebase service account .json file
 *
 * Stripe webhook URL to register:
 *   https://<your-railway-app>.railway.app/stripe-webhook
 * Event:
 *   checkout.session.completed
 */

const admin      = require('firebase-admin');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const express    = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');

// ── Email transporter (Gmail) ─────────────────────────────────────────────────
// Set these two env vars in Render to enable outbound email:
//   GMAIL_USER — your full Gmail address, e.g. you@gmail.com
//   GMAIL_PASS — a Gmail App Password (not your normal password).
//                Generate one at: myaccount.google.com/apppasswords
//                (requires 2-Step Verification to be enabled on the account)
const mailer = (process.env.GMAIL_USER && process.env.GMAIL_PASS)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
    })
  : null;

// Load Firebase credentials from environment variable
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const auth = admin.auth();
const db   = admin.firestore();
const app  = express();

// ── Global CORS — must come before all routes ─────────────────────────────────
// Allows claudecertifiedarchitects.com (with or without www) to call this
// server from the browser.
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

app.post(
  '/stripe-webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    // Verify the request really came from Stripe
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

    // Only handle completed checkouts
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
      // Find the Firebase user by email
      const userRecord     = await auth.getUserByEmail(customerEmail);
      const uid            = userRecord.uid;
      const existingClaims = userRecord.customClaims || {};

      // Set enrolled:true as a custom JWT claim
      await auth.setCustomUserClaims(uid, { ...existingClaims, enrolled: true });

      // Also write to Firestore as a fallback
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
// Stores the visitor's email + their quiz results in Firestore.
//
// TODO: wire up an email marketing provider here.
//   Popular options:
//     • Mailchimp  — set MAILCHIMP_API_KEY + MAILCHIMP_LIST_ID env vars
//     • ConvertKit — set CONVERTKIT_API_KEY + CONVERTKIT_FORM_ID env vars
//     • Loops.so   — set LOOPS_API_KEY env var
//   Then call their API after the Firestore write below.
//
app.post('/diagnostic-email', express.json(), async (req, res) => {
  const { email, results } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  // 1. Always log to Render console as a guaranteed capture
  console.log('DIAGNOSTIC_LEAD', JSON.stringify({
    email,
    estimatedScore: results?.estimatedScore,
    weakestDomain:  results?.weakestDomain
  }));

  // 2. Persist to Firestore (non-blocking — never fail the request on DB error)
  try {
    await db.collection('diagnostic_leads').add({
      email,
      results: results || null,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'diagnostic'
    });
  } catch (err) {
    console.error('Firestore write failed (lead still logged above):', err.message);
  }

  // 3. Send results email via Gmail if credentials are configured
  if (mailer && results) {
    const domainRows = (results.domains || [])
      .map(d => `  • ${d.label}: ${d.correct}/${d.total} (${d.pct}%) — ${d.examWeight}% of exam`)
      .join('\n');

    const passMark  = results.passScore || 720;
    const score     = results.estimatedScore || 0;
    const verdict   = score >= passMark
      ? '✅ Strong result — you look ready!'
      : score >= passMark * 0.85
        ? '🟡 Close — a bit more practice and you\'ll be there'
        : '🔴 Good start — let\'s fill those gaps';

    const text = `Hi,

Here are your CCA Diagnostic Quiz results:

${verdict}

Estimated score: ${score} / 1,000  (passing mark: ${passMark})

Domain breakdown:
${domainRows}

Weakest area: ${results.weakestDomain} (${results.weakestDomainWeight}% of the real exam)

Want to close the gap? The full 400-question practice bank covers every domain at real exam weightings with detailed explanations for every answer.

👉 https://claudecertifiedarchitects.com

Good luck with your studies!
— Claude Certified Architects`;

    try {
      await mailer.sendMail({
        from:    `"CCA Practice" <${process.env.GMAIL_USER}>`,
        to:      email,
        subject: `Your CCA Diagnostic Results — ${score}/1,000`,
        text
      });
      console.log('Results email sent to:', email);
    } catch (mailErr) {
      console.error('Email send failed:', mailErr.message);
      // Still return ok — the lead is captured
    }
  } else if (!mailer) {
    console.log('Email not sent: GMAIL_USER / GMAIL_PASS not configured in Render env vars.');
  }

  return res.json({ ok: true });
});

// Health check so Railway knows the server is running
app.get('/', (req, res) => res.send('Webhook server running.'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Stripe webhook server listening on port ${PORT}`));
