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

// Load Firebase credentials from environment variable
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const auth = admin.auth();
const db   = admin.firestore();
const app  = express();

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

// Health check so Railway knows the server is running
app.get('/', (req, res) => res.send('Webhook server running.'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Stripe webhook server listening on port ${PORT}`));
