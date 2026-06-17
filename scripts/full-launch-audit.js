/**
 * Full launch-to-today audit: every Stripe paid session vs Firebase.
 * READ-ONLY — no writes to any system.
 *
 * Classification:
 *   ENROLLED  — has an enrolled account (Auth enrolled:true or FS enrolled:true)
 *   PENDING   — paid, not refunded, no enrolled account, but pending_enrollments record exists
 *   MISSING   — paid, not refunded, no enrolled account AND no pending record (invisible locked-out)
 *   REFUNDED  — paid then refunded (skip)
 *   UNPAID    — session open/expired, never paid (skip)
 *
 * Usage: node scripts/full-launch-audit.js
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

// Launch date: March 12, 2026 00:00:00 UTC
const LAUNCH_TS = Math.floor(new Date('2026-03-12T00:00:00Z').getTime() / 1000);

// ── helpers ───────────────────────────────────────────────────────────────────

// Returns true if the session's payment was at least partially refunded.
// Requires the session already has payment_intent expanded with latest_charge.
function isRefunded(sess) {
  const pi = sess.payment_intent;
  if (!pi || typeof pi !== 'object') return false;
  const charge = pi.latest_charge;
  if (!charge || typeof charge !== 'object') return false;
  return charge.refunded === true || (charge.amount_refunded > 0);
}

// Check whether a Firebase UID has enrolled:true in Auth custom claims AND/OR Firestore.
async function checkUidEnrolled(uid) {
  let authEnrolled = false;
  let fsEnrolled   = false;
  let authEmail    = null;
  let emailVerified = false;
  try {
    const u = await auth.getUser(uid);
    authEnrolled = (u.customClaims || {}).enrolled === true;
    authEmail    = u.email || null;
    emailVerified = u.emailVerified;
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    return { exists: false };
  }
  try {
    const snap = await db.collection('users').doc(uid).get();
    if (snap.exists) fsEnrolled = snap.data().enrolled === true;
  } catch (_) {}
  return { exists: true, uid, authEmail, emailVerified, authEnrolled, fsEnrolled, enrolled: authEnrolled || fsEnrolled };
}

// Look up a Firebase account by email.
async function checkEmailEnrolled(email) {
  let uid;
  try {
    const u   = await auth.getUserByEmail(email);
    uid = u.uid;
    const authEnrolled = (u.customClaims || {}).enrolled === true;
    const emailVerified = u.emailVerified;
    let fsEnrolled = false;
    try {
      const snap = await db.collection('users').doc(uid).get();
      if (snap.exists) fsEnrolled = snap.data().enrolled === true;
    } catch (_) {}
    return { exists: true, uid, emailVerified, authEnrolled, fsEnrolled, enrolled: authEnrolled || fsEnrolled };
  } catch (e) {
    if (e.code === 'auth/user-not-found') return { exists: false };
    throw e;
  }
}

// Check pending_enrollments by lowercased email.
async function checkPending(email) {
  const key  = (email || '').toLowerCase();
  const snap = await db.collection('pending_enrollments').doc(key).get();
  if (!snap.exists) return { exists: false };
  const d = snap.data();
  return {
    exists:     true,
    stripeSessionId: d.stripeSessionId || null,
    createdAt:  d.createdAt?.toDate?.()?.toISOString() || null,
    ageHours:   d.createdAt ? ((Date.now() - d.createdAt.toMillis()) / 3_600_000).toFixed(1) : null,
  };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  const SEP = '='.repeat(90);

  console.log(`\nFetching ALL Stripe sessions since launch (${new Date(LAUNCH_TS * 1000).toISOString()})...`);
  console.log('(Paginating — this may take a moment)\n');

  // Paginate all sessions from LAUNCH_TS to now
  let allSessions = [];
  let after;
  for (;;) {
    const page = await stripe.checkout.sessions.list({
      created: { gte: LAUNCH_TS },
      limit:   100,
      expand:  ['data.payment_intent.latest_charge'],
      ...(after ? { starting_after: after } : {}),
    });
    allSessions.push(...page.data);
    if (!page.has_more) break;
    after = page.data[page.data.length - 1].id;
  }

  console.log(`Total Stripe sessions since launch: ${allSessions.length}`);

  // Separate paid vs not-paid
  const paid   = allSessions.filter(s => s.payment_status === 'paid');
  const unpaid = allSessions.filter(s => s.payment_status !== 'paid');
  console.log(`  Paid: ${paid.length}   Unpaid/incomplete: ${unpaid.length}\n`);

  // Load all pending_enrollments keys upfront for fast lookup
  const allPendingSnap = await db.collection('pending_enrollments').get();
  const pendingByEmail = {};
  allPendingSnap.forEach(doc => {
    pendingByEmail[doc.id] = doc.data();
  });
  console.log(`Pending_enrollments records loaded: ${Object.keys(pendingByEmail).length}\n`);

  // Process each paid session
  console.log(`Processing ${paid.length} paid sessions...\n`);

  const results = [];

  for (const sess of paid) {
    const sessionId  = sess.id;
    const uid        = sess.client_reference_id || null;
    const email      = (sess.customer_details?.email || sess.customer_email || '').toLowerCase();
    const amount     = (sess.amount_total / 100).toFixed(2);
    const currency   = (sess.currency || 'usd').toUpperCase();
    const created    = new Date(sess.created * 1000).toISOString();
    const refunded   = isRefunded(sess);

    const row = {
      sessionId,
      uid,
      email,
      amount,
      currency,
      created,
      refunded,
      fbResult:   null,
      pendingRec: null,
      classification: null,
    };

    if (refunded) {
      row.classification = 'REFUNDED';
      results.push(row);
      process.stdout.write('R');
      continue;
    }

    // Check Firebase enrollment — UID path first (authoritative), then email fallback
    let fbResult = null;
    if (uid) {
      fbResult = await checkUidEnrolled(uid);
      // If the UID account exists but isn't enrolled, also check if there's
      // a DIFFERENT account for this email that IS enrolled (rare edge case)
      if (fbResult.exists && !fbResult.enrolled && email) {
        const byEmail = await checkEmailEnrolled(email);
        if (byEmail.exists && byEmail.enrolled) {
          fbResult = byEmail; // prefer the enrolled account
        }
      }
    } else if (email) {
      fbResult = await checkEmailEnrolled(email);
    }

    row.fbResult = fbResult;

    // Check pending_enrollments
    const emailKey = email.toLowerCase();
    if (pendingByEmail[emailKey]) {
      const d = pendingByEmail[emailKey];
      row.pendingRec = {
        stripeSessionId: d.stripeSessionId || null,
        createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
        ageHours:  d.createdAt ? ((Date.now() - d.createdAt.toMillis()) / 3_600_000).toFixed(1) : null,
      };
    }

    const enrolled = fbResult?.enrolled === true;
    const hasPending = !!row.pendingRec;

    if (enrolled) {
      row.classification = 'ENROLLED';
      process.stdout.write('.');
    } else if (hasPending) {
      row.classification = 'PENDING';
      process.stdout.write('P');
    } else {
      row.classification = 'MISSING';
      process.stdout.write('!');
    }

    results.push(row);
  }

  console.log('\n\n(. = ENROLLED, P = PENDING, ! = MISSING, R = REFUNDED)\n');

  // ── Counts ───────────────────────────────────────────────────────────────
  const enrolled  = results.filter(r => r.classification === 'ENROLLED');
  const pending   = results.filter(r => r.classification === 'PENDING');
  const missing   = results.filter(r => r.classification === 'MISSING');
  const refundedL = results.filter(r => r.classification === 'REFUNDED');

  console.log(SEP);
  console.log('COUNTS');
  console.log(SEP);
  console.log(`Total paid sessions since launch:  ${results.length}`);
  console.log(`  ENROLLED  (has access):           ${enrolled.length}`);
  console.log(`  PENDING   (stuck + visible):       ${pending.length}`);
  console.log(`  MISSING   (invisible locked-out):  ${missing.length}`);
  console.log(`  REFUNDED  (skip):                  ${refundedL.length}`);

  // ── MISSING detail ────────────────────────────────────────────────────────
  if (missing.length > 0) {
    console.log('\n' + SEP);
    console.log('MISSING — PAID, NOT REFUNDED, NO ENROLLED ACCOUNT, NO PENDING RECORD');
    console.log(SEP);
    missing.forEach((r, i) => {
      console.log(`\n[${i+1}] ${r.email || '(no email)'}`);
      console.log(`  Session:  ${r.sessionId}`);
      console.log(`  UID:      ${r.uid || '(none)'}`);
      console.log(`  Amount:   $${r.amount} ${r.currency}`);
      console.log(`  Created:  ${r.created}`);
      if (r.fbResult) {
        if (r.fbResult.exists) {
          console.log(`  Firebase: account EXISTS uid=${r.fbResult.uid} authEnrolled=${r.fbResult.authEnrolled} fsEnrolled=${r.fbResult.fsEnrolled}`);
        } else {
          console.log(`  Firebase: NO ACCOUNT`);
        }
      } else {
        console.log(`  Firebase: (no email or UID to look up)`);
      }
    });
  } else {
    console.log('\nNo MISSING customers. ✅');
  }

  // ── PENDING detail ────────────────────────────────────────────────────────
  if (pending.length > 0) {
    console.log('\n' + SEP);
    console.log('PENDING — PAID, NOT REFUNDED, STUCK IN PENDING_ENROLLMENTS');
    console.log(SEP);
    pending.forEach((r, i) => {
      console.log(`\n[${i+1}] ${r.email || '(no email)'}`);
      console.log(`  Session:  ${r.sessionId}`);
      console.log(`  Amount:   $${r.amount} ${r.currency}`);
      console.log(`  Created:  ${r.created}`);
      console.log(`  Pending record created: ${r.pendingRec.createdAt}  (${r.pendingRec.ageHours}h ago)`);
      if (r.fbResult?.exists) {
        console.log(`  Firebase: account EXISTS uid=${r.fbResult.uid} authEnrolled=${r.fbResult.authEnrolled} fsEnrolled=${r.fbResult.fsEnrolled} emailVerified=${r.fbResult.emailVerified}`);
      } else {
        console.log(`  Firebase: NO ACCOUNT (will self-resolve when they sign up with this email)`);
      }
    });
  }

  // ── Full table ────────────────────────────────────────────────────────────
  console.log('\n' + SEP);
  console.log('FULL TABLE (all paid sessions)');
  console.log(SEP);
  console.log('# | Created               | Amount | Email                           | UID (first 20)       | Class    ');
  console.log('-'.repeat(120));
  results.forEach((r, i) => {
    const uid20   = (r.uid || '(none)').slice(0, 20).padEnd(20);
    const email30 = (r.email || '(none)').slice(0, 31).padEnd(31);
    console.log(
      `${String(i+1).padStart(2)} | ${r.created.slice(0,19)} | $${r.amount.padEnd(5)} | ${email30} | ${uid20} | ${r.classification}`
    );
  });

  // ── Refunded list (for completeness) ─────────────────────────────────────
  if (refundedL.length > 0) {
    console.log('\n' + SEP);
    console.log('REFUNDED SESSIONS (for reference)');
    console.log(SEP);
    refundedL.forEach(r => {
      console.log(`  ${r.created.slice(0,10)}  $${r.amount}  ${r.email || '(no email)'}  ${r.sessionId}`);
    });
  }

  console.log('\n' + SEP);
  console.log(`Done. ${results.length} paid sessions audited.`);
  console.log(SEP + '\n');

  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
