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
 *   node scripts/set-enrolled.js <path-to-service-account.json> [--product ccar|ccdv|bundle] <uid> [uid2] ...
 *
 *   --product (B2, Oct 2026) defaults to ccar. ccar and bundle write enrolled:true
 *   exactly as before plus the products claim and entitlements map; ccdv alone
 *   writes only products.ccdv and entitlements.ccdv. Existing claims are merged,
 *   never replaced, and enrolled is never removed.
 *
 * Example:
 *   node scripts/set-enrolled.js "<path-to>/claude-certification-testing-firebase-adminsdk-xxxx.json" <enrolled-uid>
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
let product = 'ccar';
const uids = [];
args.slice(1).forEach((a, i, arr) => { if (a === '--product') return; if (i > 0 && arr[i - 1] === '--product') { product = a; return; } uids.push(a); });
if (!['ccar', 'ccdv', 'bundle'].includes(product)) { console.error('--product must be ccar, ccdv or bundle'); process.exit(1); }
const products = product === 'bundle' ? ['ccar', 'ccdv'] : [product];

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
      const prevProducts = (existingClaims.products && typeof existingClaims.products === 'object') ? existingClaims.products : {};
      const nextProducts = Object.assign({}, prevProducts);
      products.forEach(p => { nextProducts[p] = true; });
      const newClaims = Object.assign({}, existingClaims, { products: nextProducts });
      if (products.includes('ccar')) newClaims.enrolled = true;
      await admin.auth().setCustomUserClaims(uid, newClaims);
      // Also write to Firestore for the fallback path
      // (using firestoreDb — the explicitly-targeted "default" database;
      // see the comment near admin.initializeApp above for why this matters)
      const db = firestoreDb;
      const entitlements = {};
      products.forEach(p => { entitlements[p] = { grantedAt: admin.firestore.FieldValue.serverTimestamp(), stripeSessionId: null, via: 'manual' }; });
      await db.collection('users').doc(uid).set(
        Object.assign(products.includes('ccar') ? { enrolled: true, enrolledAt: admin.firestore.FieldValue.serverTimestamp() } : {}, { entitlements }),
        { merge: true }
      );
      console.log(`✓ ${uid}: granted ${products.join('+')}, claims ${JSON.stringify(newClaims)}, Firestore updated`);
    } catch (e) {
      console.error(`✗ ${uid} — ${e.message}`);
    }
  }
  console.log('\nDone. User must log out and back in for new token to take effect.');
  process.exit(0);
})();
