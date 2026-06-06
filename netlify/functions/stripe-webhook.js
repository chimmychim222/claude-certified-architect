/**
 * Netlify serverless function — Stripe webhook handler.
 *
 * When a customer completes checkout, Stripe calls this endpoint.
 * It sets enrolled:true as a Firebase Auth custom claim AND writes
 * it to Firestore so the user sees ENROLLED on their next login.
 *
 * Required environment variables (set in Netlify Dashboard → Site → Environment):
 *   STRIPE_SECRET_KEY          — Stripe Dashboard → Developers → API keys → Secret key
 *   STRIPE_WEBHOOK_SECRET      — Stripe Dashboard → Developers → Webhooks → signing secret
 *   FIREBASE_SERVICE_ACCOUNT_JSON — full contents of your firebase service account .json file
 *
 * Webhook URL to register in Stripe:
 *   https://claudecertifiedarchitects.com/.netlify/functions/stripe-webhook
 * Event to listen for:
 *   checkout.session.completed
 */

const admin  = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Initialize Firebase Admin once (Netlify may reuse the Lambda container)
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const auth = admin.auth();
const db   = admin.firestore();

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Stripe requires the raw body for signature verification
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      event.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // Only handle completed checkouts
  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: JSON.stringify({ skipped: true, type: stripeEvent.type }) };
  }

  const session       = stripeEvent.data.object;
  const customerEmail = session.customer_details?.email || session.customer_email;

  if (!customerEmail) {
    console.error('No customer email in Stripe event');
    return { statusCode: 400, body: 'No customer email found in event' };
  }

  try {
    // Look up the Firebase user by email
    const userRecord = await auth.getUserByEmail(customerEmail);
    const uid        = userRecord.uid;

    // Set enrolled:true as a custom claim (lives in the JWT — immune to cache/ad blockers)
    const existingClaims = userRecord.customClaims || {};
    await auth.setCustomUserClaims(uid, { ...existingClaims, enrolled: true });

    // Also write to Firestore for the fallback path
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
    return { statusCode: 200, body: JSON.stringify({ ok: true, enrolled: uid }) };

  } catch (err) {
    console.error('Enrollment error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
