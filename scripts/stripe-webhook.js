/**
 * Stripe webhook handler — sets enrolled:true custom claim when a payment completes.
 *
 * Deploy options:
 *   A) Firebase Cloud Functions (requires Blaze plan):
 *      firebase deploy --only functions
 *
 *   B) Standalone Node.js server (Railway, Render, Fly.io, etc.):
 *      node scripts/stripe-webhook.js
 *      Then set the public URL as your Stripe webhook endpoint.
 *
 * Environment variables required:
 *   STRIPE_SECRET_KEY       — from Stripe Dashboard → Developers → API keys
 *   STRIPE_WEBHOOK_SECRET   — from Stripe Dashboard → Developers → Webhooks
 *   GOOGLE_APPLICATION_CREDENTIALS — path to service-account.json (option B only)
 *
 * Stripe webhook event to listen for: checkout.session.completed
 * Stripe Dashboard → Developers → Webhooks → Add endpoint
 *   URL: https://your-function-url/stripeWebhook
 *   Events: checkout.session.completed
 */

const admin  = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Initialize Firebase Admin (works in Cloud Functions automatically;
// for standalone, set GOOGLE_APPLICATION_CREDENTIALS env var)
if (!admin.apps.length) {
  admin.initializeApp();
}

const db   = admin.firestore();
const auth = admin.auth();

/**
 * Core handler — call this from whichever deployment you choose.
 * rawBody must be the raw Buffer (not parsed JSON) for signature verification.
 */
async function handleStripeWebhook(rawBody, signature) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    throw new Error(`Webhook signature verification failed: ${err.message}`);
  }

  if (event.type !== 'checkout.session.completed') {
    return { skipped: true, type: event.type };
  }

  const session      = event.data.object;
  const customerEmail = session.customer_details?.email || session.customer_email;
  if (!customerEmail) throw new Error('No customer email in Stripe event');

  // Find the Firebase user by email
  const userRecord = await auth.getUserByEmail(customerEmail);
  const uid        = userRecord.uid;

  // Set custom claim (survives ad blockers; included in JWT)
  const existing = userRecord.customClaims || {};
  await auth.setCustomUserClaims(uid, { ...existing, enrolled: true });

  // Also write to Firestore (fallback for users without claim yet)
  await db.collection('users').doc(uid).set(
    {
      enrolled:   true,
      enrolledAt: admin.firestore.FieldValue.serverTimestamp(),
      email:      customerEmail,
      stripeSessionId: session.id,
    },
    { merge: true }
  );

  console.log(`Enrolled: ${customerEmail} (${uid})`);
  return { enrolled: uid };
}

// ── Option A: Firebase Cloud Functions export ─────────────────────────────
try {
  const functions = require('firebase-functions');
  exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }
    try {
      const result = await handleStripeWebhook(req.rawBody, req.headers['stripe-signature']);
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error(e.message);
      res.status(400).send(e.message);
    }
  });
} catch (_) {
  // firebase-functions not available — running as standalone server (Option B)
}

// ── Option B: Standalone Express server ───────────────────────────────────
if (require.main === module) {
  const express    = require('express');
  const bodyParser = require('body-parser');
  const app = express();

  app.post(
    '/stripeWebhook',
    bodyParser.raw({ type: 'application/json' }),
    async (req, res) => {
      try {
        const result = await handleStripeWebhook(req.body, req.headers['stripe-signature']);
        res.json({ ok: true, ...result });
      } catch (e) {
        console.error(e.message);
        res.status(400).send(e.message);
      }
    }
  );

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Stripe webhook server listening on port ${PORT}`));
}
