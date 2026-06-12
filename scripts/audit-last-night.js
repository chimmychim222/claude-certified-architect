/**
 * One-off audit script (read-only):
 *  - Pulls every checkout.session.completed Stripe event in a recent window
 *  - Cross-references each paying email against Firebase Auth custom claims
 *    and Firestore users/{uid} (enrolled, examPurchaseEventSent, enrolledAt,
 *    stripeSessionId)
 *  - Re-checks the Phase-4 examPurchaseEventSent backfill state for all
 *    currently-enrolled users
 *  - Surfaces any email appearing on more than one completed session
 *
 * Usage:
 *   node scripts/audit-last-night.js <service-account.json> <stripe-key-file> [--hours=36]
 *
 * Read-only: makes no writes to Stripe, Firestore, or Auth.
 */

const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');
const { getFirestore } = require('firebase-admin/firestore');

const args = process.argv.slice(2);
const hoursArg = args.find(a => a.startsWith('--hours='));
const HOURS = hoursArg ? Number(hoursArg.slice('--hours='.length)) : 36;
const positional = args.filter(a => !a.startsWith('--hours='));

if (positional.length < 2) {
  console.error('\nUsage: node scripts/audit-last-night.js <service-account.json> <stripe-key-file> [--hours=36]\n');
  process.exit(1);
}

const serviceAccountPath = path.resolve(positional[0]);
const stripeKeyPath      = path.resolve(positional[1]);

const sa = require(serviceAccountPath);
const stripeKey = fs.readFileSync(stripeKeyPath, 'utf8').trim();
const Stripe = require('stripe');
const stripe = Stripe(stripeKey);

admin.initializeApp({ credential: admin.credential.cert(sa) });
const auth = admin.auth();
// Same custom-named "default" database as stripe-webhook.js / set-enrolled.js
const db = getFirestore(admin.app(), 'default');

(async () => {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - HOURS * 3600;

  console.log('Project:', sa.project_id);
  console.log('Now (UTC):', new Date(now * 1000).toISOString());
  console.log(`Window: last ${HOURS}h, since`, new Date(cutoff * 1000).toISOString());
  console.log('='.repeat(80));

  // ── A1 re-check: examPurchaseEventSent backfill state ─────────────────────
  console.log('\n--- A1: examPurchaseEventSent backfill state (all enrolled users) ---');
  const enrolledSnap = await db.collection('users').where('enrolled', '==', true).get();
  let flaggedCount = 0, unflaggedCount = 0;
  const unflagged = [];
  enrolledSnap.forEach(doc => {
    const d = doc.data();
    if (d.examPurchaseEventSent === true) {
      flaggedCount++;
    } else {
      unflaggedCount++;
      unflagged.push({ uid: doc.id, email: d.email, enrolledAt: d.enrolledAt?.toDate?.()?.toISOString() || null });
    }
  });
  console.log(`Total enrolled users: ${enrolledSnap.size}`);
  console.log(`  examPurchaseEventSent=true : ${flaggedCount}`);
  console.log(`  NOT flagged                : ${unflaggedCount}`);
  unflagged.forEach(u => console.log(`    - ${u.email}  uid=${u.uid}  enrolledAt=${u.enrolledAt}`));

  // ── B/C: Stripe Checkout Sessions completed in window ──────────────────────
  // (events.list requires "Events Read" which this restricted key lacks;
  // checkout.sessions.list with payment_status=paid is the read-only
  // equivalent of "successful checkout.session.completed".)
  console.log('\n--- B/C: Checkout Sessions completed in window ---');
  const sessions = [];
  let startingAfter;
  for (;;) {
    const page = await stripe.checkout.sessions.list({
      created: { gte: cutoff },
      limit: 100,
      expand: ['data.payment_intent'],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    sessions.push(...page.data);
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id;
  }

  const completed = sessions.filter(s => s.payment_status === 'paid' && s.status === 'complete');
  console.log(`Found ${sessions.length} session(s) total, ${completed.length} with payment_status=paid & status=complete.\n`);

  const rows = [];
  for (const session of completed) {
    const email = session.customer_details?.email || session.customer_email || '(none)';
    const pi = session.payment_intent;
    rows.push({
      eventId: session.id,
      sessionId: session.id,
      paymentIntent: typeof pi === 'string' ? pi : pi?.id,
      paymentIntentStatus: typeof pi === 'string' ? undefined : pi?.status,
      email,
      amountTotal: session.amount_total,
      currency: session.currency,
      paymentStatus: session.payment_status,
      created: new Date(session.created * 1000).toISOString(),
      livemode: session.livemode,
    });
  }

  rows.sort((a, b) => a.created.localeCompare(b.created));
  rows.forEach(r => {
    console.log(`[${r.created}] ${r.email}`);
    console.log(`    session=${r.sessionId}  pi=${r.paymentIntent} (pi.status=${r.paymentIntentStatus})`);
    console.log(`    amount=${r.amountTotal} ${r.currency}  payment_status=${r.paymentStatus}  livemode=${r.livemode}`);
  });

  // ── Detect duplicates by email ─────────────────────────────────────────────
  const byEmail = {};
  rows.forEach(r => {
    (byEmail[r.email.toLowerCase()] ||= []).push(r);
  });
  const duplicates = Object.entries(byEmail).filter(([, v]) => v.length > 1);

  console.log('\n--- Duplicate-email check ---');
  if (duplicates.length === 0) {
    console.log('No email appears more than once in this window.');
  } else {
    duplicates.forEach(([email, list]) => {
      console.log(`\n*** ${email} — ${list.length} completed sessions ***`);
      list.forEach(r => {
        console.log(`    ${r.created}  session=${r.sessionId}  pi=${r.paymentIntent}  amount=${r.amountTotal} ${r.currency}  status=${r.paymentStatus}`);
      });
    });
  }

  // ── Reconcile each paying email against Auth + Firestore ──────────────────
  console.log('\n--- Reconciliation: paid -> enrolled? ---');
  const uniqueEmails = Object.keys(byEmail);
  const flaggedNoAccess = [];

  for (const emailLower of uniqueEmails) {
    const events_ = byEmail[emailLower];
    const email = events_[0].email;
    let userRecord = null;
    try {
      userRecord = await auth.getUserByEmail(email);
    } catch (e) {
      // not found
    }

    let firestoreDoc = null;
    if (userRecord) {
      const snap = await db.collection('users').doc(userRecord.uid).get();
      if (snap.exists) firestoreDoc = snap.data();
    }

    let pendingDoc = null;
    const pendingSnap = await db.collection('pending_enrollments').doc(emailLower).get();
    if (pendingSnap.exists) pendingDoc = pendingSnap.data();

    const authEnrolled = userRecord?.customClaims?.enrolled === true;
    const fsEnrolled = firestoreDoc?.enrolled === true;

    console.log(`\n${email}  (${events_.length} payment${events_.length > 1 ? 's' : ''})`);
    console.log(`    Auth user found: ${!!userRecord}${userRecord ? '  uid=' + userRecord.uid : ''}`);
    console.log(`    Auth customClaims.enrolled: ${authEnrolled}`);
    console.log(`    Firestore users/{uid}.enrolled: ${fsEnrolled}`);
    if (firestoreDoc) {
      console.log(`    Firestore enrolledAt: ${firestoreDoc.enrolledAt?.toDate?.()?.toISOString() || '(none)'}`);
      console.log(`    Firestore stripeSessionId: ${firestoreDoc.stripeSessionId || '(none)'}`);
      console.log(`    Firestore examPurchaseEventSent: ${firestoreDoc.examPurchaseEventSent === true}`);
    }
    console.log(`    pending_enrollments doc exists: ${!!pendingDoc}`);
    if (pendingDoc) {
      console.log(`    pending_enrollments.stripeSessionId: ${pendingDoc.stripeSessionId}`);
      console.log(`    pending_enrollments.createdAt: ${pendingDoc.createdAt?.toDate?.()?.toISOString() || '(none)'}`);
    }

    const paidButNoAccess = !(authEnrolled && fsEnrolled);
    if (paidButNoAccess) {
      flaggedNoAccess.push({ email, authEnrolled, fsEnrolled, hasAuthUser: !!userRecord, pending: !!pendingDoc });
      console.log(`    !!! FLAG: paid but enrolled !== (true,true) — possible locked-out customer`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total checkout.session.completed events: ${rows.length}`);
  console.log(`Unique paying emails: ${uniqueEmails.length}`);
  console.log(`Emails with >1 completed session: ${duplicates.length}`);
  console.log(`Paid-but-not-fully-enrolled flags: ${flaggedNoAccess.length}`);
  flaggedNoAccess.forEach(f => console.log(`  - ${f.email}  authEnrolled=${f.authEnrolled} fsEnrolled=${f.fsEnrolled} hasAuthUser=${f.hasAuthUser} pending=${f.pending}`));

  process.exit(0);
})().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
