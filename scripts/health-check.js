/**
 * Full health check: Stripe payments vs Firestore/Auth enrollment records,
 * pending_enrollments staleness, enrollment-flag/claim integrity, signup/
 * login path sanity, and webhook reachability.
 *
 * Read-only — no writes to Firestore, Auth, or Stripe.
 *
 * Usage:
 *   node scripts/health-check.js <service-account.json> <stripe-key-file.txt>
 */

const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('\nUsage: node scripts/health-check.js <service-account.json> <stripe-key-file.txt>\n');
  process.exit(1);
}

const sa        = require(path.resolve(args[0]));
const stripeKey = fs.readFileSync(path.resolve(args[1]), 'utf8').trim();

admin.initializeApp({ credential: admin.credential.cert(sa) });
const { getFirestore } = require('firebase-admin/firestore');
const db    = getFirestore(admin.app(), 'default');
const auth  = admin.auth();
const Stripe = require('stripe');
const stripe = Stripe(stripeKey);

const WEBHOOK_BASE = 'https://claude-certified-architect.onrender.com';
const STALE_HOURS  = 4;

(async () => {
  const summary = {};

  // ═══════════════════════════════════════════════════════════════════════
  // Load Firestore: all users, enrolled users, pending enrollments
  // ═══════════════════════════════════════════════════════════════════════
  console.log('='.repeat(78));
  console.log('Loading Firestore data...');
  console.log('='.repeat(78));

  const allUsersSnap = await db.collection('users').get();
  const allUsers = [];
  allUsersSnap.forEach(doc => {
    const d = doc.data();
    allUsers.push({
      uid:             doc.id,
      email:           (d.email || '').toLowerCase(),
      enrolled:        d.enrolled === true,
      stripeSessionId: d.stripeSessionId || null,
      enrolledAt:      (d.enrolledAt && d.enrolledAt.toDate) ? d.enrolledAt.toDate().toISOString() : null,
      createdAt:       (d.createdAt && d.createdAt.toDate) ? d.createdAt.toDate().toISOString() : null,
    });
  });
  const enrolledUsers = allUsers.filter(u => u.enrolled);

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

  console.log(`  ${allUsers.length} total user doc(s) in 'users' collection, ${enrolledUsers.length} with enrolled=true`);
  console.log(`  ${pendingRecords.length} record(s) in 'pending_enrollments' collection`);

  // ═══════════════════════════════════════════════════════════════════════
  // Load Stripe: all paid checkout sessions
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(78));
  console.log('Loading Stripe checkout sessions...');
  console.log('='.repeat(78));

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
  const fmtAmount = s => `${((s.amount_total ?? 0) / 100).toFixed(2)} ${(s.currency || 'usd').toUpperCase()}`;

  console.log(`  ${allSessions.length} total checkout session(s) with status=complete`);
  console.log(`  ${paidSessions.length} with payment_status=paid`);

  // ═══════════════════════════════════════════════════════════════════════
  // PART 1: Stripe vs access reconciliation — last 3 months
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(78));
  console.log('PART 1: Stripe vs access reconciliation — last 3 months');
  console.log('='.repeat(78));

  const threeMonthsAgoSec = Math.floor(Date.now() / 1000) - 90 * 24 * 3600;
  const recentPaid = paidSessions.filter(s => s.created >= threeMonthsAgoSec);

  const enrolledByEmail   = new Map(enrolledUsers.map(u => [u.email, u]));
  const enrolledBySession = new Map(enrolledUsers.filter(u => u.stripeSessionId).map(u => [u.stripeSessionId, u]));
  const pendingByEmail    = new Map(pendingRecords.map(p => [p.email, p]));
  const pendingBySession  = new Map(pendingRecords.filter(p => p.stripeSessionId).map(p => [p.stripeSessionId, p]));

  console.log(`\n${recentPaid.length} paid checkout.session.completed event(s) in the last 3 months:\n`);

  const orphaned = [];
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
        status = '⚠️ ORPHANED — paid, no enrollment, no pending record';
        orphaned.push({ email, sessionId: s.id, created, amount: fmtAmount(s) });
      }
      console.log(`  ${created}  ${(email || '(no email)').padEnd(35)} session=${s.id}  ${fmtAmount(s).padStart(10)}  → ${status}`);
    });

  const uniqueRecentEmails = new Set(recentPaid.map(sessionEmail).filter(Boolean));
  console.log(`\n  Unique paying customer emails (last 3mo): ${uniqueRecentEmails.size}`);
  console.log(`  Orphaned (paid, no access record at all):  ${orphaned.length}`);
  if (orphaned.length) {
    console.log('\n  ⚠️ ORPHANED PAYMENTS (last 3mo):');
    orphaned.forEach(o => console.log(`    ${o.email}  session=${o.sessionId}  paid=${o.created}  ${o.amount}`));
  }

  // All-time totals for the headline numbers
  const allTimeUniqueEmails = new Set(paidSessions.map(sessionEmail).filter(Boolean));
  console.log(`\n  --- All-time totals ---`);
  console.log(`  Unique paying customer emails (all-time): ${allTimeUniqueEmails.size}`);
  console.log(`  Firestore users with enrolled=true:       ${enrolledUsers.length}`);

  const allTimeEnrolledEmails    = new Set(enrolledUsers.map(u => u.email).filter(Boolean));
  const allTimePaidNotEnrolled   = [...allTimeUniqueEmails].filter(e => !allTimeEnrolledEmails.has(e));
  const allTimeEnrolledNotPaid   = [...allTimeEnrolledEmails].filter(e => !allTimeUniqueEmails.has(e));

  if (allTimeUniqueEmails.size === enrolledUsers.length) {
    console.log(`  MATCH ✓`);
  } else {
    console.log(`  MISMATCH (diff ${Math.abs(allTimeUniqueEmails.size - enrolledUsers.length)})`);
  }
  if (allTimePaidNotEnrolled.length) {
    console.log(`\n  Paid (all-time) but enrolled!=true (${allTimePaidNotEnrolled.length}):`);
    allTimePaidNotEnrolled.forEach(e => {
      const inPending = pendingByEmail.has(e);
      console.log(`    ${e}${inPending ? '  (in pending_enrollments — see Part 2)' : '  ⚠️ NOT in pending_enrollments either — ORPHANED'}`);
      if (!inPending && !orphaned.find(o => o.email === e)) {
        // Catch all-time orphans outside the 3-month window too
        const s = paidSessions.find(p => sessionEmail(p) === e);
        orphaned.push({ email: e, sessionId: s.id, created: new Date(s.created * 1000).toISOString(), amount: fmtAmount(s) });
      }
    });
  }
  if (allTimeEnrolledNotPaid.length) {
    console.log(`\n  Enrolled=true but no matching paid Stripe email (${allTimeEnrolledNotPaid.length}):`);
    allTimeEnrolledNotPaid.forEach(e => console.log(`    ${e}  (likely admin-granted via set-enrolled.js — verify manually)`));
  }

  summary.totalPaidAllTime = allTimeUniqueEmails.size;
  summary.totalEnrolled    = enrolledUsers.length;
  summary.orphanedPayments = orphaned;

  // ═══════════════════════════════════════════════════════════════════════
  // PART 2: Stuck pending enrollments — ALL records
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(78));
  console.log(`PART 2: pending_enrollments — ALL records (flag >${STALE_HOURS}h)`);
  console.log('='.repeat(78));

  console.log(`\n${pendingRecords.length} record(s):\n`);
  const stalePending = [];
  if (pendingRecords.length === 0) {
    console.log('  (none)');
  } else {
    pendingRecords
      .sort((a, b) => (b.ageHours ?? Infinity) - (a.ageHours ?? Infinity))
      .forEach(p => {
        const ageStr = p.ageHours === null ? 'age unknown (no createdAt)' : `${p.ageHours.toFixed(1)}h old`;
        const stale = (p.ageHours === null || p.ageHours > STALE_HOURS);
        if (stale) stalePending.push(p);
        console.log(`  ${p.email.padEnd(35)} session=${(p.stripeSessionId || '(none)').padEnd(28)} created=${p.createdAt || '(unknown)'}  ${ageStr}${stale ? `  ⚠️ STALE (>${STALE_HOURS}h)` : ''}`);
      });
  }
  console.log(`\n  Stale (>${STALE_HOURS}h or unknown age): ${stalePending.length}`);
  summary.stalePending = stalePending;

  // ═══════════════════════════════════════════════════════════════════════
  // PART 3: Enrollment integrity — Firestore flag vs Auth custom claim
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(78));
  console.log('PART 3: Enrollment integrity — Firestore enrolled flag vs Auth custom claim');
  console.log('='.repeat(78));

  console.log(`\nChecking ${enrolledUsers.length} Firestore enrolled=true user(s) against Auth custom claims:\n`);
  const mismatches = [];
  for (const u of enrolledUsers) {
    let authUser;
    try {
      authUser = await auth.getUser(u.uid);
    } catch (e) {
      console.log(`  ⚠️ ${u.email.padEnd(35)} uid=${u.uid}  Auth user NOT FOUND (${e.message})`);
      mismatches.push({ uid: u.uid, email: u.email, issue: 'auth-user-missing' });
      continue;
    }
    const claimEnrolled = authUser.customClaims?.enrolled === true;
    console.log(`  ${u.email.padEnd(35)} uid=${u.uid}  Firestore=true  AuthClaim=${claimEnrolled}  ${claimEnrolled ? '✓' : '⚠️ MISMATCH'}`);
    if (!claimEnrolled) mismatches.push({ uid: u.uid, email: u.email, issue: 'firestore-true-claim-missing' });
  }

  console.log(`\nScanning all Auth users for custom claim enrolled=true...`);
  let authEnrolledUsers = [];
  let nextPageToken;
  do {
    const result = await auth.listUsers(1000, nextPageToken);
    result.users.forEach(u => {
      if (u.customClaims?.enrolled === true) authEnrolledUsers.push(u);
    });
    nextPageToken = result.pageToken;
  } while (nextPageToken);

  console.log(`  ${authEnrolledUsers.length} Auth user(s) with custom claim enrolled=true`);
  const firestoreEnrolledUids = new Set(enrolledUsers.map(u => u.uid));
  authEnrolledUsers.forEach(u => {
    if (!firestoreEnrolledUids.has(u.uid)) {
      console.log(`  ⚠️ ${(u.email || '(no email)').padEnd(35)} uid=${u.uid}  AuthClaim=true  Firestore enrolled!=true  ⚠️ MISMATCH`);
      mismatches.push({ uid: u.uid, email: (u.email || '').toLowerCase(), issue: 'claim-true-firestore-false' });
    }
  });

  console.log(`\nTotal enrollment integrity mismatches: ${mismatches.length}`);
  summary.enrollmentMismatches = mismatches;

  // ═══════════════════════════════════════════════════════════════════════
  // PART 4: Webhook reachability
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(78));
  console.log('PART 4: Webhook reachability');
  console.log('='.repeat(78));

  let webhookUp = false;
  try {
    const resp = await fetch(WEBHOOK_BASE + '/', { signal: AbortSignal.timeout(60000) });
    const text = await resp.text();
    webhookUp = resp.ok;
    console.log(`\n  GET ${WEBHOOK_BASE}/  → ${resp.status} "${text}" ${webhookUp ? '✓' : '⚠️'}`);
  } catch (e) {
    console.log(`\n  GET ${WEBHOOK_BASE}/  → ERROR: ${e.message} ⚠️`);
  }

  let webhookConfigured = false;
  try {
    const endpoints = await stripe.webhookEndpoints.list({ limit: 20 });
    const ep = endpoints.data.find(e => e.url.includes('claude-certified-architect.onrender.com'));
    if (ep) {
      webhookConfigured = ep.status === 'enabled' && ep.enabled_events.includes('checkout.session.completed');
      console.log(`\n  Stripe webhook endpoint: ${ep.url}`);
      console.log(`    status: ${ep.status}`);
      console.log(`    enabled_events: ${ep.enabled_events.join(', ')}`);
      console.log(`    signature secret configured: ${ep.secret ? 'yes' : '(not exposed by API — assume yes if set in Render env)'}`);
    } else {
      console.log(`\n  ⚠️ No Stripe webhook endpoint found pointing at ${WEBHOOK_BASE}`);
    }
  } catch (e) {
    console.log(`\n  ⚠️ Could not list Stripe webhook endpoints: ${e.message} (key may be restricted — not fatal)`);
    webhookConfigured = null; // unknown
  }

  // Most recent paid session -> was it processed? (proxy for "last successfully hit")
  if (paidSessions.length) {
    const mostRecent = [...paidSessions].sort((a, b) => b.created - a.created)[0];
    const email = sessionEmail(mostRecent);
    const created = new Date(mostRecent.created * 1000).toISOString();
    const wasProcessed = enrolledByEmail.has(email) || enrolledBySession.has(mostRecent.id) || pendingByEmail.has(email) || pendingBySession.has(mostRecent.id);
    console.log(`\n  Most recent paid checkout: ${email}  session=${mostRecent.id}  paid=${created}`);
    console.log(`  Reconciled (enrolled or pending)?  ${wasProcessed ? 'YES — webhook successfully processed this ✓' : 'NO — possible webhook miss ⚠️'}`);
    summary.webhookLastSuccess = wasProcessed ? created : null;
  } else {
    console.log('\n  No paid sessions found at all — cannot infer last successful webhook delivery.');
    summary.webhookLastSuccess = null;
  }

  summary.webhookUp = webhookUp;
  summary.webhookConfigured = webhookConfigured;

  // ═══════════════════════════════════════════════════════════════════════
  // FINAL PASS/FAIL SUMMARY
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(78));
  console.log('FINAL PASS/FAIL SUMMARY');
  console.log('='.repeat(78));
  console.log(`\n  Total paid customers (all-time, unique emails): ${summary.totalPaidAllTime}`);
  console.log(`  Total enrolled (Firestore enrolled=true):       ${summary.totalEnrolled}`);
  console.log(`  Orphaned payments (paid, no access at all):     ${summary.orphanedPayments.length}`);
  console.log(`  Stale pending_enrollments (>${STALE_HOURS}h or unknown age): ${summary.stalePending.length}`);
  console.log(`  Enrollment flag/claim mismatches:               ${summary.enrollmentMismatches.length}`);
  console.log(`  Webhook server reachable:                       ${summary.webhookUp ? 'YES' : 'NO'}`);
  console.log(`  Webhook configured in Stripe:                   ${summary.webhookConfigured === null ? 'UNKNOWN (key restricted)' : (summary.webhookConfigured ? 'YES' : 'NO')}`);
  console.log(`  Last paid checkout reconciled:                  ${summary.webhookLastSuccess || 'N/A / NO'}`);

  const allClean = summary.orphanedPayments.length === 0
    && summary.stalePending.length === 0
    && summary.enrollmentMismatches.length === 0
    && summary.webhookUp
    && summary.webhookConfigured !== false;

  console.log(`\n  OVERALL: ${allClean ? '✅ PASS — everything clean' : '❌ FAIL — see flagged items above'}`);

  process.exit(0);
})().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
