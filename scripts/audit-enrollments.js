/**
 * One-off read-only audit: cross-references Firestore enrollment records
 * against real Stripe payments to catch customers who paid but have no
 * access (or other drift between the two systems).
 *
 * Makes NO writes to Firestore, Auth, or Stripe — list/get calls only.
 *
 * Usage:
 *   node scripts/audit-enrollments.js <service-account.json> <stripe-key-file.txt>
 *
 * <stripe-key-file.txt> should contain just the Stripe restricted/secret key
 * (rk_live_... or sk_live_...), nothing else.
 */

const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('\nUsage: node scripts/audit-enrollments.js <service-account.json> <stripe-key-file.txt>\n');
  process.exit(1);
}

const sa        = require(path.resolve(args[0]));
const stripeKey = fs.readFileSync(path.resolve(args[1]), 'utf8').trim();

admin.initializeApp({ credential: admin.credential.cert(sa) });
const { getFirestore } = require('firebase-admin/firestore');
// Same "default"-named database as scripts/set-enrolled.js / stripe-webhook.js
const db    = getFirestore(admin.app(), 'default');
const Stripe = require('stripe');
const stripe = Stripe(stripeKey);

const LAZY_FIRESTORE_COMMIT_DATE = new Date('2026-06-10T15:35:17+02:00');

(async () => {
  // ── PART 1: Firestore users with enrolled=true ─────────────────────────────
  console.log('='.repeat(70));
  console.log('PART 1: Firestore users with enrolled=true');
  console.log('='.repeat(70));

  const enrolledSnap = await db.collection('users').where('enrolled', '==', true).get();
  const enrolledUsers = [];
  enrolledSnap.forEach(doc => {
    const d = doc.data();
    enrolledUsers.push({
      uid:             doc.id,
      email:           (d.email || '').toLowerCase(),
      stripeSessionId: d.stripeSessionId || null,
      enrolledAt:      (d.enrolledAt && d.enrolledAt.toDate) ? d.enrolledAt.toDate().toISOString() : null,
    });
  });
  console.log(`\nFound ${enrolledUsers.length} Firestore user(s) with enrolled=true:\n`);
  enrolledUsers
    .sort((a, b) => (a.enrolledAt || '').localeCompare(b.enrolledAt || ''))
    .forEach(u => {
      console.log(`  ${(u.email || '(no email)').padEnd(35)} uid=${u.uid}  session=${u.stripeSessionId || '(none)'}  enrolledAt=${u.enrolledAt || '(unknown)'}`);
    });

  // ── Stripe: all-time paid checkout sessions ────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('Stripe: all-time completed/paid checkout sessions');
  console.log('='.repeat(70));

  let allSessions = [];
  let startingAfter;
  while (true) {
    const page = await stripe.checkout.sessions.list({
      limit: 100,
      starting_after: startingAfter,
      status: 'complete',
    });
    allSessions = allSessions.concat(page.data);
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  const paidSessions = allSessions.filter(s => s.payment_status === 'paid');
  const sessionEmail = s => (s.customer_details?.email || s.customer_email || '').toLowerCase();
  const uniqueEmails = new Set(paidSessions.map(sessionEmail).filter(Boolean));

  console.log(`\nFound ${allSessions.length} total checkout session(s) with status=complete.`);
  console.log(`Of those, ${paidSessions.length} have payment_status=paid, across ${uniqueEmails.size} unique customer email(s):\n`);
  [...uniqueEmails].sort().forEach(e => console.log(`  ${e}`));

  console.log(`\n--- Comparison ---`);
  console.log(`  Firestore enrolled=true users: ${enrolledUsers.length}`);
  console.log(`  Stripe unique paying customers: ${uniqueEmails.size}`);
  if (enrolledUsers.length === uniqueEmails.size) {
    console.log(`  MATCH ✓`);
  } else {
    console.log(`  MISMATCH — difference of ${Math.abs(enrolledUsers.length - uniqueEmails.size)}`);
    const enrolledEmails = new Set(enrolledUsers.map(u => u.email).filter(Boolean));
    const paidNotEnrolled = [...uniqueEmails].filter(e => !enrolledEmails.has(e));
    const enrolledNotPaid = [...enrolledEmails].filter(e => !uniqueEmails.has(e));
    if (paidNotEnrolled.length) {
      console.log(`  Paid in Stripe but NOT enrolled=true in Firestore (${paidNotEnrolled.length}):`);
      paidNotEnrolled.forEach(e => console.log(`    ⚠️ ${e}`));
    }
    if (enrolledNotPaid.length) {
      console.log(`  Enrolled=true in Firestore but no matching paid Stripe email (${enrolledNotPaid.length}):`);
      enrolledNotPaid.forEach(e => console.log(`    ⚠️ ${e}`));
    }
  }

  // ── PART 2: pending_enrollments ────────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('PART 2: pending_enrollments collection');
  console.log('='.repeat(70));

  const pendingSnap = await db.collection('pending_enrollments').get();
  const pendingRecords = [];
  pendingSnap.forEach(doc => {
    const d = doc.data();
    const createdAtMs = (d.createdAt && typeof d.createdAt.toMillis === 'function') ? d.createdAt.toMillis() : null;
    const ageHours = createdAtMs === null ? null : (Date.now() - createdAtMs) / 3600000;
    pendingRecords.push({
      docId:           doc.id,
      email:           (d.email || doc.id || '').toLowerCase(),
      stripeSessionId: d.stripeSessionId || null,
      createdAt:       createdAtMs === null ? null : new Date(createdAtMs).toISOString(),
      ageHours,
    });
  });

  console.log(`\nFound ${pendingRecords.length} pending_enrollments record(s) (every record here is, by definition, unclaimed):\n`);
  if (pendingRecords.length === 0) {
    console.log('  (none)');
  } else {
    pendingRecords
      .sort((a, b) => (b.ageHours ?? Infinity) - (a.ageHours ?? Infinity))
      .forEach(p => {
        const ageStr = p.ageHours === null ? 'age unknown (no createdAt)' : `${p.ageHours.toFixed(1)}h old`;
        const flag = (p.ageHours === null || p.ageHours > 4) ? '  ⚠️ UNCLAIMED > a few hours' : '';
        console.log(`  ${p.email.padEnd(35)} session=${p.stripeSessionId || '(none)'}  created=${p.createdAt || '(unknown)'}  ${ageStr}${flag}`);
      });
  }

  // ── PART 3: last 3 months cross-reference ──────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('PART 3: last 3 months — checkout.session.completed vs enrollment records');
  console.log('='.repeat(70));

  const threeMonthsAgoSec = Math.floor(Date.now() / 1000) - 90 * 24 * 3600;
  const recentPaid = paidSessions.filter(s => s.created >= threeMonthsAgoSec);
  console.log(`\n${recentPaid.length} paid checkout session(s) in the last 3 months:\n`);

  const enrolledByEmail   = new Map(enrolledUsers.map(u => [u.email, u]));
  const enrolledBySession = new Map(enrolledUsers.filter(u => u.stripeSessionId).map(u => [u.stripeSessionId, u]));
  const pendingByEmail    = new Map(pendingRecords.map(p => [p.email, p]));
  const pendingBySession  = new Map(pendingRecords.filter(p => p.stripeSessionId).map(p => [p.stripeSessionId, p]));

  const flagged = [];
  recentPaid
    .sort((a, b) => b.created - a.created)
    .forEach(s => {
      const email = sessionEmail(s);
      const created = new Date(s.created * 1000).toISOString();
      let status;
      if (enrolledByEmail.has(email) || enrolledBySession.has(s.id)) {
        status = 'enrolled';
      } else if (pendingByEmail.has(email) || pendingBySession.has(s.id)) {
        status = 'pending (unclaimed)';
      } else {
        status = '⚠️ NEITHER — paid, no enrollment, no pending record';
        flagged.push({ email, sessionId: s.id, created });
      }
      console.log(`  ${created}  ${(email || '(no email)').padEnd(35)} session=${s.id}  → ${status}`);
    });

  console.log(`\n${flagged.length} flagged session(s) with NO enrollment and NO pending record:`);
  if (flagged.length === 0) {
    console.log('  (none)');
  } else {
    flagged.forEach(f => console.log(`  ⚠️ ${f.email}  session=${f.sessionId}  paid=${f.created}`));
  }

  // ── PART 4: lazy-Firestore commit vs 5 most recent sales ───────────────────
  console.log('\n' + '='.repeat(70));
  console.log('PART 4: lazy-Firestore commit timing vs 5 most recent sales');
  console.log('='.repeat(70));

  console.log(`\nLazy-Firestore commit 6034588: ${LAZY_FIRESTORE_COMMIT_DATE.toISOString()} (${LAZY_FIRESTORE_COMMIT_DATE.toString()})\n`);

  const last5 = [...paidSessions].sort((a, b) => b.created - a.created).slice(0, 5);
  if (last5.length === 0) {
    console.log('  (no paid sessions found)');
  } else {
    last5.forEach((s, i) => {
      const created = new Date(s.created * 1000);
      const rel = created < LAZY_FIRESTORE_COMMIT_DATE ? 'BEFORE' : 'AFTER';
      console.log(`  #${i + 1}  ${created.toISOString()}  ${sessionEmail(s).padEnd(35)} session=${s.id}  — ${rel} the lazy-Firestore commit`);
    });
  }

  process.exit(0);
})().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
