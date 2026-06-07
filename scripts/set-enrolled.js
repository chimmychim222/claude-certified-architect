/**
 * Sets enrolled:true as a Firebase Auth custom claim for one or more users.
 * This makes the enrollment flag available in the JWT token — no Firestore
 * read needed, works even when ad blockers block googleapis.com.
 *
 * Setup (one-time):
 *   1. Firebase Console → Project Settings → Service Accounts
 *      → Generate new private key → save the downloaded .json file anywhere
 *   2. npm install firebase-admin
 *
 * Usage:
 *   node scripts/set-enrolled.js <path-to-service-account.json> <uid> [uid2] ...
 *
 * Example (Windows — file saved to Downloads):
 *   node scripts/set-enrolled.js "C:\Users\joshu\Downloads\claude-certification-testing-firebase-adminsdk-xxxx.json" uXdKJsc34DNBIVQdT4Jwk21qBfg1
 *
 * After running, the user must log out and back in (or wait up to 1 hour)
 * for the new token claim to be reflected in their session.
 */

const admin = require('firebase-admin');
const path  = require('path');

// First arg is the path to the service account JSON file,
// remaining args are UIDs to enroll.
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('\nUsage: node scripts/set-enrolled.js <service-account.json> <uid> [uid2] ...');
  console.error('\nGet the service account JSON from:');
  console.error('  Firebase Console → Project Settings → Service Accounts → Generate new private key\n');
  process.exit(1);
}

const serviceAccountPath = path.resolve(args[0]);
const uids = args.slice(1);

let firestoreDb;
try {
  const sa = require(serviceAccountPath);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  // IMPORTANT — this project's Firestore database has the custom database ID
  // "default" (a literal, named database), NOT the SDK's special reserved
  // "(default)" database that admin.firestore() connects to with no args.
  // The "(default)" database is empty for this project — admin.firestore()
  // would silently return "5 NOT_FOUND" for every read/write. Confirmed via
  // scripts/diagnose-firestore.js. Must explicitly target "default":
  const { getFirestore } = require('firebase-admin/firestore');
  firestoreDb = getFirestore(admin.app(), 'default');
} catch (e) {
  console.error('\nERROR: Could not load service account file:', serviceAccountPath);
  console.error('Make sure the path is correct and the file is valid JSON.\n');
  process.exit(1);
}
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
      // (using firestoreDb — the explicitly-targeted "default" database;
      // see the comment near admin.initializeApp above for why this matters)
      const db = firestoreDb;
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
