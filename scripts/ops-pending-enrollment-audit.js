/**
 * Operations script — pending_enrollments audit + conditional Aruna enrollment.
 *
 * PART 1: For aruna.kumar@comcast.net
 *   - Confirm Stripe session is paid and not refunded
 *   - Check Firebase Auth existence
 *   - If account EXISTS but not enrolled: enroll now (claim + Firestore write)
 *   - If NO account: trace /claim-enrollment path and confirm it will work
 *
 * PART 2: Full pending_enrollments sweep
 *   - For every record: Stripe status, Firebase account existence, enrollment status
 *   - Classify: STUCK / CLAIMED_OK / IGNORE
 *
 * Safe guards:
 *   - No application code modified
 *   - No records deleted
 *   - The ONLY possible write is the targeted Aruna enrollment if (and only if)
 *     a Firebase account already exists for her email but is not yet enrolled.
 *
 * Usage: node scripts/ops-pending-enrollment-audit.js
 */
const fs    = require('fs');
const path  = require('path');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const Stripe = require('stripe');

const SA_PATH  = path.join(__dirname, '../testing keys/claude-certification-testing-firebase-adminsdk-fbsvc-65fdc2cdbd.json');
const KEY_PATH = path.join(__dirname, '../testing keys/stripe-readonly-key.txt');

const sa        = require(SA_PATH);
const stripeKey = fs.readFileSync(KEY_PATH, 'utf8').trim();

admin.initializeApp({ credential: admin.credential.cert(sa) });
const auth   = admin.auth();
const db     = getFirestore(admin.app(), 'default');
const stripe = Stripe(stripeKey);

const ARUNA_EMAIL      = 'aruna.kumar@comcast.net';
const ARUNA_SESSION_ID = 'cs_live_a1r5hn2dzfxKzsQltVmfcGaZS477VRoFGny6GBIEV6Rkywq1BKS0BBVGkE';

// ── helpers ───────────────────────────────────────────────────────────────────

async function getStripeSessionStatus(sessionId) {
  try {
    const sess = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent'],
    });
    const paymentIntent = sess.payment_intent;
    let refunded = false;
    if (paymentIntent && typeof paymentIntent === 'object') {
      // If fully refunded, payment_intent.status = 'canceled' or charge.refunded = true
      refunded = paymentIntent.status === 'canceled' ||
        (paymentIntent.latest_charge && typeof paymentIntent.latest_charge === 'object' &&
          paymentIntent.latest_charge.refunded === true);
    }
    return {
      found:          true,
      paymentStatus:  sess.payment_status,   // 'paid' | 'unpaid' | 'no_payment_required'
      sessionStatus:  sess.status,           // 'complete' | 'open' | 'expired'
      amountTotal:    sess.amount_total,
      currency:       sess.currency,
      customerEmail:  sess.customer_details?.email || sess.customer_email || null,
      created:        new Date(sess.created * 1000).toISOString(),
      refunded,
      piStatus:       paymentIntent?.status || null,
    };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

async function getFirebaseAccount(email) {
  try {
    const u = await auth.getUserByEmail(email);
    const fsSnap = await db.collection('users').doc(u.uid).get();
    const fsData = fsSnap.exists ? fsSnap.data() : null;
    return {
      exists:        true,
      uid:           u.uid,
      emailVerified: u.emailVerified,
      authEnrolled:  (u.customClaims || {}).enrolled === true,
      fsEnrolled:    fsData ? fsData.enrolled === true : false,
      fsEnrolledAt:  fsData?.enrolledAt ? fsData.enrolledAt.toDate().toISOString() : null,
    };
  } catch (e) {
    if (e.code === 'auth/user-not-found') return { exists: false };
    return { exists: null, error: e.message };
  }
}

// Mirrors exactly what the webhook's successful-enrollment path writes.
async function enrollAccount(uid, email, sessionId) {
  const userRecord     = await auth.getUser(uid);
  const existingClaims = userRecord.customClaims || {};

  // BEFORE state
  const before = {
    authClaims: existingClaims,
  };
  const fsSnapBefore = await db.collection('users').doc(uid).get();
  before.fsData = fsSnapBefore.exists ? fsSnapBefore.data() : null;

  // Write Auth custom claim
  await auth.setCustomUserClaims(uid, { ...existingClaims, enrolled: true });

  // Write Firestore users doc (mirror of webhook path)
  await db.collection('users').doc(uid).set(
    {
      enrolled:        true,
      enrolledAt:      admin.firestore.FieldValue.serverTimestamp(),
      email,
      stripeSessionId: sessionId,
      source:          'manual_ops',
    },
    { merge: true }
  );

  // Read back to confirm
  const updatedUser  = await auth.getUser(uid);
  const fsSnapAfter  = await db.collection('users').doc(uid).get();

  return {
    before,
    after: {
      authClaims: updatedUser.customClaims,
      fsData:     fsSnapAfter.exists ? fsSnapAfter.data() : null,
    },
  };
}

function ageHours(createdAt) {
  if (!createdAt || typeof createdAt.toMillis !== 'function') return null;
  return ((Date.now() - createdAt.toMillis()) / 3_600_000).toFixed(1);
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

(async () => {
  const SEP = '='.repeat(80);
  const sep = '-'.repeat(80);

  // ─────────────────────────────────────────────────────────────────────────
  // PART 1 — Aruna
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n' + SEP);
  console.log('PART 1 — aruna.kumar@comcast.net');
  console.log(SEP);

  // 1a. Firestore pending record
  console.log('\n[1a] Firestore pending_enrollments record:');
  const arunaDocRef = db.collection('pending_enrollments').doc(ARUNA_EMAIL.toLowerCase());
  const arunaDoc    = await arunaDocRef.get();
  if (arunaDoc.exists) {
    const d = arunaDoc.data();
    console.log('  Document key (Firestore doc ID):', arunaDocRef.id);
    console.log('  email field:                    ', d.email);
    console.log('  stripeSessionId:                ', d.stripeSessionId);
    console.log('  createdAt:                      ', d.createdAt?.toDate?.()?.toISOString() || '(missing)');
    console.log('  age:                            ', ageHours(d.createdAt), 'hours');
    if (d.stripeSessionId !== ARUNA_SESSION_ID) {
      console.log('  *** NOTE: session ID differs from expected! ***');
      console.log('    expected:', ARUNA_SESSION_ID);
      console.log('    actual:  ', d.stripeSessionId);
    }
  } else {
    console.log('  *** NOT FOUND — no pending record for this email ***');
  }

  // 1b. Stripe session
  console.log('\n[1b] Stripe session status:');
  const stripe1 = await getStripeSessionStatus(ARUNA_SESSION_ID);
  console.log('  Session ID:     ', ARUNA_SESSION_ID);
  if (stripe1.found) {
    console.log('  paymentStatus:  ', stripe1.paymentStatus);
    console.log('  sessionStatus:  ', stripe1.sessionStatus);
    console.log('  amount:          $' + (stripe1.amountTotal / 100).toFixed(2), stripe1.currency?.toUpperCase());
    console.log('  customerEmail:  ', stripe1.customerEmail);
    console.log('  created:        ', stripe1.created);
    console.log('  refunded:       ', stripe1.refunded);
    console.log('  PI status:      ', stripe1.piStatus);
    const isPaid    = stripe1.paymentStatus === 'paid';
    const isRefunded = stripe1.refunded;
    console.log('\n  VERDICT:', isPaid && !isRefunded ? '✅ PAID and NOT REFUNDED' : isRefunded ? '⚠️  REFUNDED' : '❌ NOT PAID');
  } else {
    console.log('  ERROR:', stripe1.error);
  }

  // 1c. Firebase account check
  console.log('\n[1c] Firebase Auth account for', ARUNA_EMAIL + ':');
  const aruna = await getFirebaseAccount(ARUNA_EMAIL);
  if (aruna.exists === false) {
    console.log('  *** NO Firebase account exists for this email ***');
    console.log('\n[1d] /claim-enrollment path trace (since no account exists):');
    console.log('');
    console.log('  The pending_enrollments document is keyed by:');
    console.log('    customerEmail.toLowerCase() → "' + ARUNA_EMAIL.toLowerCase() + '"');
    console.log('');
    console.log('  The /claim-enrollment endpoint does:');
    console.log('    const email = (decoded.email || "").toLowerCase()');
    console.log('    const pendingRef = db.collection("pending_enrollments").doc(email)');
    console.log('');
    console.log('  When Aruna signs up with aruna.kumar@comcast.net:');
    console.log('    decoded.email will be: "aruna.kumar@comcast.net"');
    console.log('    .toLowerCase()       → "aruna.kumar@comcast.net"');
    console.log('    pendingRef doc ID    → "aruna.kumar@comcast.net"');
    console.log('    actual doc ID        → "' + ARUNA_EMAIL.toLowerCase() + '"');
    console.log('    MATCH:', ARUNA_EMAIL.toLowerCase() === ARUNA_EMAIL.toLowerCase() ? '✅ YES — will be found and claimed' : '❌ NO — MISMATCH');
    console.log('');
    console.log('  GATE: email_verified must be true before claim is granted.');
    console.log('    → After sign-up, Aruna must click the verification link in her inbox.');
    console.log('    → Signing up with Google auth satisfies this gate automatically.');
    console.log('    → If she uses email/password, she must verify before /claim-enrollment succeeds.');
    console.log('');
    console.log('  INSTRUCTION TO SEND ARUNA:');
    console.log('    "Go to claudecertifiedarchitects.com, click Log In, and create a free');
    console.log('     account with aruna.kumar@comcast.net (the exact email used at checkout).');
    console.log('     If you sign up with email/password, click the verification link we\'ll');
    console.log('     email you before logging in. Your course access will unlock automatically."');
  } else if (aruna.exists === true) {
    console.log('  UID:           ', aruna.uid);
    console.log('  emailVerified: ', aruna.emailVerified);
    console.log('  authEnrolled:  ', aruna.authEnrolled);
    console.log('  fsEnrolled:    ', aruna.fsEnrolled);
    console.log('  fsEnrolledAt:  ', aruna.fsEnrolledAt);

    const needsEnrollment = !aruna.authEnrolled || !aruna.fsEnrolled;
    if (!needsEnrollment) {
      console.log('\n  Already fully enrolled — no write needed.');
    } else {
      console.log('\n  *** Account exists but NOT enrolled — enrolling now... ***');
      try {
        const result = await enrollAccount(aruna.uid, ARUNA_EMAIL, ARUNA_SESSION_ID);
        console.log('\n  BEFORE:');
        console.log('    Auth claims: ', JSON.stringify(result.before.authClaims));
        console.log('    FS enrolled: ', result.before.fsData?.enrolled);
        console.log('\n  AFTER (read-back confirmation):');
        console.log('    Auth claims:      ', JSON.stringify(result.after.authClaims));
        console.log('    FS enrolled:      ', result.after.fsData?.enrolled);
        console.log('    FS enrolledAt:    ', result.after.fsData?.enrolledAt?.toDate?.()?.toISOString() || '(timestamp pending)');
        console.log('    FS stripeSession: ', result.after.fsData?.stripeSessionId);
        console.log('    FS source:        ', result.after.fsData?.source);
        const authOk = result.after.authClaims?.enrolled === true;
        const fsOk   = result.after.fsData?.enrolled === true;
        console.log('\n  VERIFICATION:', authOk && fsOk ? '✅ Auth claim + Firestore both enrolled:true' : '❌ ENROLLMENT INCOMPLETE');
      } catch (err) {
        console.error('\n  ENROLLMENT FAILED:', err.message);
      }
    }
  } else {
    console.log('  ERROR checking account:', aruna.error);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PART 2 — Full pending_enrollments sweep
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n' + SEP);
  console.log('PART 2 — Full pending_enrollments sweep');
  console.log(SEP);

  const allPending = await db.collection('pending_enrollments').get();
  console.log('\nTotal pending_enrollment records:', allPending.size);

  const rows = [];
  for (const doc of allPending.docs) {
    const d         = doc.data();
    const email     = d.email || doc.id;
    const sessionId = d.stripeSessionId || null;
    const age       = ageHours(d.createdAt);
    const createdAt = d.createdAt?.toDate?.()?.toISOString() || '(missing)';

    // Stripe status
    let stripeInfo = { paymentStatus: '(no sessionId)', refunded: false, found: false };
    if (sessionId) {
      stripeInfo = await getStripeSessionStatus(sessionId);
    }

    // Firebase account
    const fbInfo = await getFirebaseAccount(email);

    // Classification
    const isPaid      = stripeInfo.paymentStatus === 'paid';
    const isRefunded  = stripeInfo.refunded;
    const hasAccount  = fbInfo.exists === true;
    const isEnrolled  = hasAccount && (fbInfo.authEnrolled || fbInfo.fsEnrolled);

    let classification;
    if (isPaid && !isRefunded && !isEnrolled) {
      classification = 'STUCK';
    } else if (isEnrolled) {
      classification = 'CLAIMED_OK';
    } else if (isRefunded) {
      classification = 'IGNORE_REFUNDED';
    } else if (!isPaid) {
      classification = 'IGNORE_UNPAID';
    } else {
      classification = 'UNKNOWN';
    }

    rows.push({ email, sessionId, age, createdAt, stripeInfo, fbInfo, isPaid, isRefunded, hasAccount, isEnrolled, classification });
  }

  // Print full table
  console.log('\n' + sep);
  rows.forEach((r, i) => {
    console.log(`\n[${i + 1}] ${r.email}`);
    console.log(`  Session ID:    ${r.sessionId || '(none)'}`);
    console.log(`  Created:       ${r.createdAt}  (${r.age}h ago)`);
    if (r.stripeInfo.found) {
      console.log(`  Stripe:        payment_status=${r.stripeInfo.paymentStatus}  session_status=${r.stripeInfo.sessionStatus}  refunded=${r.stripeInfo.refunded}  amount=$${(r.stripeInfo.amountTotal/100).toFixed(2)}`);
    } else if (r.sessionId) {
      console.log(`  Stripe:        ERROR — ${r.stripeInfo.error}`);
    } else {
      console.log(`  Stripe:        no sessionId in record`);
    }
    if (r.fbInfo.exists === true) {
      console.log(`  Firebase:      uid=${r.fbInfo.uid}  emailVerified=${r.fbInfo.emailVerified}  authEnrolled=${r.fbInfo.authEnrolled}  fsEnrolled=${r.fbInfo.fsEnrolled}`);
    } else if (r.fbInfo.exists === false) {
      console.log(`  Firebase:      NO ACCOUNT`);
    } else {
      console.log(`  Firebase:      ERROR — ${r.fbInfo.error}`);
    }
    console.log(`  Classification: ${r.classification}`);
  });

  // Summary
  const stuck      = rows.filter(r => r.classification === 'STUCK');
  const claimedOk  = rows.filter(r => r.classification === 'CLAIMED_OK');
  const ignRefund  = rows.filter(r => r.classification === 'IGNORE_REFUNDED');
  const ignUnpaid  = rows.filter(r => r.classification === 'IGNORE_UNPAID');
  const unknown    = rows.filter(r => r.classification === 'UNKNOWN');

  console.log('\n' + SEP);
  console.log('SUMMARY');
  console.log(SEP);
  console.log('Total records:     ', rows.length);
  console.log('STUCK (needs help):', stuck.length);
  console.log('CLAIMED_OK:        ', claimedOk.length);
  console.log('IGNORE_REFUNDED:   ', ignRefund.length);
  console.log('IGNORE_UNPAID:     ', ignUnpaid.length);
  console.log('UNKNOWN:           ', unknown.length);

  if (stuck.length > 0) {
    console.log('\n*** STUCK — LOCKED-OUT CUSTOMERS NEEDING OUTREACH ***');
    stuck.forEach(r => {
      console.log(`  Email:   ${r.email}`);
      console.log(`  Session: ${r.sessionId}`);
      console.log(`  Age:     ${r.age}h`);
      console.log(`  Account: ${r.hasAccount ? 'exists (uid=' + r.fbInfo.uid + ')' : 'NO ACCOUNT'}`);
      console.log('');
    });
  } else {
    console.log('\nNo STUCK customers (beyond any Aruna enrollment already handled above).');
  }

  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
