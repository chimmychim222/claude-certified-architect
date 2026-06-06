/**
 * Sets enrolled:true as a Firebase Auth custom claim for one or more users.
 * This makes the enrollment flag available in the JWT token — no Firestore
 * read needed, works even when ad blockers block googleapis.com.
 *
 * Setup (one-time):
 *   1. Firebase Console → Project Settings → Service Accounts
 *      → Generate new private key → save as scripts/service-account.json
 *   2. npm install firebase-admin
 *
 * Usage:
 *   node scripts/set-enrolled.js <uid> [uid2] [uid3] ...
 *
 * Example:
 *   node scripts/set-enrolled.js uXdKJsc34DNBIVQdT4Jwk21qBfg1
 *
 * After running, the user must log out and back in (or wait up to 1 hour)
 * for the new token claim to be reflected in their session.
 */

const admin = require('firebase-admin');
const path  = require('path');

const SERVICE_ACCOUNT = path.join(__dirname, 'service-account.json');

try {
  const sa = require(SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
} catch (e) {
  console.error('\nERROR: Could not load service-account.json');
  console.error('Go to Firebase Console → Project Settings → Service Accounts');
  console.error('→ Generate new private key → save as scripts/service-account.json\n');
  process.exit(1);
}

const uids = process.argv.slice(2);
if (uids.length === 0) {
  console.error('Usage: node scripts/set-enrolled.js <uid> [uid2] ...');
  process.exit(1);
}

(async () => {
  for (const uid of uids) {
    try {
      // Read existing claims so we don't overwrite anything else
      const user = await admin.auth().getUser(uid);
      const existingClaims = user.customClaims || {};
      await admin.auth().setCustomUserClaims(uid, {
        ...existingClaims,
        enrolled: true,
      });
      // Also write to Firestore for the fallback path
      const db = admin.firestore();
      await db.collection('users').doc(uid).set(
        { enrolled: true, enrolledAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      console.log(`✓ ${uid} — enrolled:true claim set + Firestore updated`);
    } catch (e) {
      console.error(`✗ ${uid} — ${e.message}`);
    }
  }
  console.log('\nDone. User must log out and back in for new token to take effect.');
  process.exit(0);
})();
