/**
 * Validates the /pre-checkout endpoint logic directly against Firebase
 * without sending any HTTP requests. Uses the same Firebase Admin SA key
 * as blast-radius-audit.js. Read-only except for two checkout_intents writes.
 *
 * Tests:
 *   1. Already-enrolled UID → expect 'already_enrolled'
 *   2. Non-enrolled / unknown UID → expect 'ok: true'
 *   3. Second call within 10 min (same UID) → expect 'recent_session'
 *   4. Cleanup: delete the checkout_intent written in tests 2+3
 *
 * Nothing identifying is hardcoded here. This file is served publicly by GitHub
 * Pages, so the credential path and the enrolled UID that test 1 needs are both
 * supplied at run time and neither lives in the repo.
 *
 * Usage:
 *   node scripts/test-pre-checkout-logic.js <service-account.json> <enrolled-uid>
 *
 * Both may instead be set once as CCA_SA_PATH and CCA_ENROLLED_TEST_UID. Use one
 * of the owner's own test accounts for the UID, never a real customer's.
 */
const fs   = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));

const SA_PATH      = process.env.CCA_SA_PATH           || positional[0];
// A production UID that is already enrolled — test 1 asserts it is turned away.
const ENROLLED_UID = process.env.CCA_ENROLLED_TEST_UID || positional[1];

if (!SA_PATH || !ENROLLED_UID) {
  console.error('\nUsage: node scripts/test-pre-checkout-logic.js <service-account.json> <enrolled-uid>');
  console.error('   or: set CCA_SA_PATH and CCA_ENROLLED_TEST_UID and pass neither.');
  console.error('\nThe key file lives outside the repo, in the gitignored local key directory.\n');
  process.exit(1);
}

const sa = require(path.resolve(SA_PATH));

admin.initializeApp({ credential: admin.credential.cert(sa) });
const auth = admin.auth();
const db   = getFirestore(admin.app(), 'default');

// Non-existent / unenrolled UID to simulate a brand-new account
const UNENROLLED_UID   = 'test-unenrolled-pre-checkout-zz9';

// Mirrors the /pre-checkout server logic (without HTTP layer)
async function simulatePreCheckout(uid) {
  try {
    let userRecord;
    try {
      userRecord = await auth.getUser(uid);
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        // UID not in Firebase Auth → treat as unenrolled new user
        userRecord = { customClaims: {} };
      } else {
        throw e;
      }
    }

    if ((userRecord.customClaims || {}).enrolled === true) {
      return { ok: false, reason: 'already_enrolled', source: 'claims' };
    }

    let userSnap;
    try {
      userSnap = await db.collection('users').doc(uid).get();
    } catch (e) {
      userSnap = { exists: false };
    }
    if (userSnap.exists && userSnap.data && userSnap.data().enrolled === true) {
      return { ok: false, reason: 'already_enrolled', source: 'firestore' };
    }

    const intentRef  = db.collection('checkout_intents').doc(uid);
    const intentSnap = await intentRef.get();
    if (intentSnap.exists) {
      const ts    = intentSnap.data().initiatedAt;
      const ageMs = ts ? Date.now() - ts.toMillis() : Infinity;
      if (ageMs < 10 * 60 * 1000) {
        return { ok: false, reason: 'recent_session', ageSeconds: Math.round(ageMs / 1000) };
      }
    }

    await intentRef.set({ uid, initiatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { ok: true };

  } catch (err) {
    return { ok: true, _failOpen: true, error: err.message };
  }
}

(async () => {
  let passed = 0; let failed = 0;

  function check(label, result, expectOk, expectReason) {
    const okMatch     = result.ok === expectOk;
    const reasonMatch = expectReason ? result.reason === expectReason : true;
    const pass = okMatch && reasonMatch;
    const mark = pass ? '✅' : '❌';
    console.log(`${mark} ${label}`);
    console.log(`     result: ${JSON.stringify(result)}`);
    if (!pass) {
      console.log(`     expected: ok=${expectOk}${expectReason ? ` reason=${expectReason}` : ''}`);
      failed++;
    } else {
      passed++;
    }
  }

  console.log('\n=== /pre-checkout logic tests ===\n');

  // 1. Already-enrolled account
  console.log('Test 1: already-enrolled UID...');
  const r1 = await simulatePreCheckout(ENROLLED_UID);
  check('Already-enrolled account blocked', r1, false, 'already_enrolled');

  // 2. Brand-new / unenrolled account (first checkout)
  // Clean up any leftover intent from a previous test run first
  await db.collection('checkout_intents').doc(UNENROLLED_UID).delete().catch(() => {});
  console.log('\nTest 2: brand-new unenrolled UID (first checkout)...');
  const r2 = await simulatePreCheckout(UNENROLLED_UID);
  check('Brand-new account passes through', r2, true, null);

  // 3. Same UID within 10 minutes → recent_session
  console.log('\nTest 3: same unenrolled UID again within 10 min (duplicate checkout)...');
  const r3 = await simulatePreCheckout(UNENROLLED_UID);
  check('Duplicate in-flight checkout blocked', r3, false, 'recent_session');

  // Cleanup: remove the test intent doc
  await db.collection('checkout_intents').doc(UNENROLLED_UID).delete().catch(() => {});
  console.log('\n(Test checkout_intent doc cleaned up)');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
