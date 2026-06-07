/**
 * One-off diagnostic: tests whether basic Firestore COLLECTION QUERIES work
 * against this project, using a locally-provided service account key. This
 * bypasses Render entirely so we can isolate whether the "5 NOT_FOUND" error
 * seen from /admin/stale-pending-enrollments is:
 *   (a) specific to querying the (empty) `pending_enrollments` collection, or
 *   (b) a general problem with running ANY query against this database
 *       (e.g. an API/provisioning issue), even though direct document
 *       reads/writes — like set-enrolled.js does — work fine.
 *
 * Usage:
 *   node scripts/diagnose-firestore.js <path-to-service-account.json>
 *
 * Example:
 *   node scripts/diagnose-firestore.js "C:\Users\joshu\Downloads\claude-certification-testing-firebase-adminsdk-fbsvc-2b928948bb.json"
 */

const admin = require('firebase-admin');
const path  = require('path');

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('\nUsage: node scripts/diagnose-firestore.js <service-account.json>\n');
  process.exit(1);
}

const serviceAccountPath = path.resolve(args[0]);

let sa;
try {
  sa = require(serviceAccountPath);
} catch (e) {
  console.error('\nERROR: Could not load service account file:', serviceAccountPath);
  console.error(e.message, '\n');
  process.exit(1);
}

console.log('Loaded service account for project:', sa.project_id);
console.log('client_email:', sa.client_email);
console.log('private_key_id:', sa.private_key_id);
console.log('');

const { getFirestore } = require('firebase-admin/firestore');

admin.initializeApp({ credential: admin.credential.cert(sa) });
const app = admin.app();

// The Firebase console URL for this project's Firestore data showed the
// database ID segment as literally "default" (no parentheses) — which is
// DIFFERENT from the Admin SDK's special reserved "(default)" database that
// admin.firestore() connects to with no arguments. If the real data lives in
// a custom-named database called "default", that would explain why a totally
// fresh, correct-project credential can't find ANYTHING via the bare client.
// Test against several plausible IDs to find which one actually has the data.
const candidates = ['(default)', 'default', '-default-'];

async function runTests(label, db) {
  console.log(`\n========== Connecting with databaseId = ${label} ==========`);

  console.log(`--- direct document GET on users/uXdKJsc34DNBIVQdT4Jwk21qBfg1 ---`);
  try {
    const docSnap = await db.collection('users').doc('uXdKJsc34DNBIVQdT4Jwk21qBfg1').get();
    console.log('OK — exists:', docSnap.exists, ' data:', JSON.stringify(docSnap.data()));
  } catch (e) {
    console.error('FAILED:', e.message);
  }

  console.log(`--- collection QUERY on \`users\` ---`);
  try {
    const snap = await db.collection('users').get();
    console.log('OK — size:', snap.size);
  } catch (e) {
    console.error('FAILED:', e.message);
  }

  console.log(`--- collection QUERY on \`pending_enrollments\` ---`);
  try {
    const snap = await db.collection('pending_enrollments').get();
    console.log('OK — size:', snap.size);
  } catch (e) {
    console.error('FAILED:', e.message);
  }
}

(async () => {
  for (const id of candidates) {
    let db;
    try {
      db = (id === '(default)') ? admin.firestore() : getFirestore(app, id);
    } catch (e) {
      console.log(`\n========== databaseId = ${id} : could not construct client — ${e.message} ==========`);
      continue;
    }
    await runTests(id, db);
  }
  process.exit(0);
})();
