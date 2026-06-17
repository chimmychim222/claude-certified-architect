/**
 * Blast-radius audit: all paid Stripe sessions vs Firebase enrollment.
 * READ-ONLY — no writes to any system.
 * Usage: node scripts/blast-radius-audit.js
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const Stripe = require('stripe');

const SA_PATH = path.join(__dirname, '../testing keys/claude-certification-testing-firebase-adminsdk-fbsvc-65fdc2cdbd.json');
const KEY_PATH = path.join(__dirname, '../testing keys/stripe-readonly-key.txt');

const sa = require(SA_PATH);
const stripeKey = fs.readFileSync(KEY_PATH, 'utf8').trim();

admin.initializeApp({ credential: admin.credential.cert(sa) });
const auth = admin.auth();
const db = getFirestore(admin.app(), 'default');
const stripe = Stripe(stripeKey);

(async () => {
  const WINDOW_DAYS = 30;
  const cutoff = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86400;

  console.log(`Fetching all Stripe sessions since ${new Date(cutoff * 1000).toISOString()} (${WINDOW_DAYS} days)...`);
  let allSessions = [];
  let after;
  for (;;) {
    const page = await stripe.checkout.sessions.list({
      created: { gte: cutoff },
      limit: 100,
      ...(after ? { starting_after: after } : {}),
    });
    allSessions.push(...page.data);
    if (!page.has_more) break;
    after = page.data[page.data.length - 1].id;
  }

  const paid = allSessions.filter(s => s.payment_status === 'paid');
  const unpaid = allSessions.filter(s => s.payment_status !== 'paid');
  console.log(`Total sessions: ${allSessions.length} | Paid: ${paid.length} | Unpaid/incomplete: ${unpaid.length}\n`);

  // For each paid session, cross-reference Firebase
  const results = [];
  for (const sess of paid) {
    const uid = sess.client_reference_id;
    const email = (sess.customer_details && sess.customer_details.email) || sess.customer_email || '(none)';
    const paymentTs = new Date(sess.created * 1000);

    const row = {
      sessionId: sess.id,
      email,
      uid: uid || '(NONE)',
      amount: (sess.amount_total / 100).toFixed(2),
      currency: sess.currency,
      paymentTime: paymentTs.toISOString(),
      authEnrolled: null,
      authEmail: null,
      emailVerified: null,
      fsEnrolled: null,
      enrolledAt: null,
      enrolledAtRaw: null,
      delaySec: null,
      exceeded75s: false,
      orphaned: false,
      noUid: !uid,
      examPurchaseEventSent: false,
    };

    if (!uid) {
      row.orphaned = true;
      results.push(row);
      continue;
    }

    // Check Firebase Auth
    try {
      const u = await auth.getUser(uid);
      row.authEnrolled = u.customClaims && u.customClaims.enrolled === true;
      row.emailVerified = u.emailVerified;
      row.authEmail = u.email;
    } catch (e) {
      row.authEnrolled = 'UID_NOT_FOUND';
    }

    // Check Firestore
    try {
      const snap = await db.collection('users').doc(uid).get();
      if (snap.exists) {
        const d = snap.data();
        row.fsEnrolled = d.enrolled === true;
        row.examPurchaseEventSent = d.examPurchaseEventSent || false;
        if (d.enrolledAt) {
          const ts = d.enrolledAt.toDate();
          row.enrolledAt = ts.toISOString();
          row.enrolledAtRaw = ts;
          row.delaySec = Math.round((ts - paymentTs) / 1000);
          row.exceeded75s = row.delaySec > 75;
        }
      } else {
        row.fsEnrolled = false;
      }
    } catch (e) {
      row.fsEnrolled = 'ERROR: ' + e.message;
    }

    row.orphaned = row.authEnrolled !== true || row.fsEnrolled !== true;
    results.push(row);
  }

  // ─── Full audit table ───
  console.log('='.repeat(130));
  console.log('PAID CUSTOMERS — FULL AUDIT TABLE (last 30 days)');
  console.log('='.repeat(130));
  console.log('# | Email | UID | Amount | Payment Time (UTC) | EnrolledAt (UTC) | Delay(s) | >75s | Auth | FS | GA4 | Status');
  console.log('-'.repeat(130));

  results.forEach((r, i) => {
    const cols = [
      String(i + 1).padStart(2),
      (r.email || '').slice(0, 30).padEnd(30),
      (r.uid || '').slice(0, 28).padEnd(28),
      ('$' + r.amount).padEnd(7),
      r.paymentTime,
      (r.enrolledAt || '(none)').padEnd(27),
      (r.delaySec !== null ? String(r.delaySec) : '?').padStart(7),
      r.exceeded75s ? 'YES' : 'no ',
      r.authEnrolled === true ? 'Y' : r.authEnrolled === false ? 'N' : String(r.authEnrolled).slice(0, 13),
      r.fsEnrolled === true ? 'Y' : r.fsEnrolled === false ? 'N' : String(r.fsEnrolled).slice(0, 5),
      r.examPurchaseEventSent ? 'Y' : 'N',
      r.orphaned ? '*** ORPHANED ***' : 'ok',
    ];
    console.log(cols.join(' | '));
  });

  // ─── Summary ───
  const orphaned = results.filter(r => r.orphaned);
  const exceeded = results.filter(r => r.exceeded75s);
  const enrolled = results.filter(r => r.authEnrolled === true && r.fsEnrolled === true);
  const ga4Sent = results.filter(r => r.examPurchaseEventSent);
  const ga4Missing = results.filter(r => !r.examPurchaseEventSent && r.authEnrolled === true && r.fsEnrolled === true);

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log('Total paid Stripe sessions (30d): ' + results.length);
  console.log('Fully enrolled (Auth + FS both Y): ' + enrolled.length);
  console.log('ORPHANED (paid, missing access):  ' + orphaned.length);
  console.log('  - no client_reference_id:       ' + results.filter(r => r.noUid).length);
  console.log('  - UID not found in Auth:         ' + results.filter(r => r.authEnrolled === 'UID_NOT_FOUND').length);
  console.log('  - Auth not enrolled:             ' + results.filter(r => r.authEnrolled === false).length);
  console.log('  - FS not enrolled (Auth ok):     ' + results.filter(r => r.fsEnrolled === false && r.authEnrolled === true).length);
  console.log('Exceeded 75s deadline:             ' + exceeded.length);
  exceeded.forEach(r => console.log('  ' + r.email + ' — ' + r.delaySec + 's'));
  console.log('GA4 examPurchaseEventSent = Y:     ' + ga4Sent.length);
  console.log('GA4 event NOT sent (enrolled ok):  ' + ga4Missing.length);

  if (orphaned.length > 0) {
    console.log('\n*** ORPHANED — NEED MANUAL ENROLLMENT + OUTREACH ***');
    orphaned.forEach(r => {
      console.log('  Session: ' + r.sessionId);
      console.log('  Email: ' + r.email + ' | UID: ' + r.uid + ' | Amount: $' + r.amount + ' | Paid: ' + r.paymentTime);
      console.log('  Auth enrolled: ' + r.authEnrolled + ' | FS enrolled: ' + r.fsEnrolled);
      console.log('');
    });
  }

  // ─── Retry pattern: multiple paid sessions per email or UID ───
  console.log('='.repeat(80));
  console.log('RETRY PATTERNS (multiple paid sessions per email or UID)');
  console.log('='.repeat(80));
  const byEmail = {};
  const byUid = {};
  results.forEach(r => {
    if (r.email && r.email !== '(none)') {
      byEmail[r.email] = byEmail[r.email] || [];
      byEmail[r.email].push(r);
    }
    if (r.uid && r.uid !== '(NONE)') {
      byUid[r.uid] = byUid[r.uid] || [];
      byUid[r.uid].push(r);
    }
  });
  let retryFound = false;
  Object.entries(byEmail).filter(([, rows]) => rows.length > 1).forEach(([email, rows]) => {
    retryFound = true;
    console.log('EMAIL ' + email + ': ' + rows.length + ' paid sessions');
    rows.forEach(r => console.log('  ' + r.paymentTime + ' | ' + r.sessionId + ' | uid=' + r.uid));
  });
  Object.entries(byUid).filter(([, rows]) => rows.length > 1).forEach(([uid, rows]) => {
    retryFound = true;
    console.log('UID ' + uid + ': ' + rows.length + ' paid sessions');
    rows.forEach(r => console.log('  ' + r.paymentTime + ' | ' + r.sessionId + ' | email=' + r.email));
  });
  if (!retryFound) console.log('None detected.');

  // ─── Unpaid sessions with client_reference_id (retry signals) ───
  console.log('\n' + '='.repeat(80));
  console.log('UNPAID SESSIONS WITH client_reference_id (retry signals, last 30d)');
  console.log('='.repeat(80));
  const paidUids = new Set(paid.map(s => s.client_reference_id).filter(Boolean));
  const unpaidWithUid = unpaid.filter(s => s.client_reference_id);
  unpaidWithUid.forEach(s => {
    const hadPaid = paidUids.has(s.client_reference_id);
    console.log(
      new Date(s.created * 1000).toISOString() +
      ' | ' + s.status + '/' + s.payment_status +
      ' | uid=' + s.client_reference_id +
      ' | email=' + ((s.customer_details && s.customer_details.email) || '(none)') +
      ' | also_paid=' + hadPaid
    );
  });
  if (!unpaidWithUid.length) console.log('None with uid.');

  // ─── Delay distribution ───
  console.log('\n' + '='.repeat(80));
  console.log('ENROLLMENT DELAY DISTRIBUTION (enrolled sessions only)');
  console.log('='.repeat(80));
  const withDelay = results.filter(r => r.delaySec !== null);
  if (withDelay.length) {
    const delays = withDelay.map(r => r.delaySec).sort((a, b) => a - b);
    console.log('Min delay:    ' + delays[0] + 's');
    console.log('Median delay: ' + delays[Math.floor(delays.length / 2)] + 's');
    console.log('Max delay:    ' + delays[delays.length - 1] + 's');
    console.log('Avg delay:    ' + Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) + 's');
    const brackets = { '0-30s': 0, '31-60s': 0, '61-75s': 0, '76-120s': 0, '>120s': 0 };
    delays.forEach(d => {
      if (d <= 30) brackets['0-30s']++;
      else if (d <= 60) brackets['31-60s']++;
      else if (d <= 75) brackets['61-75s']++;
      else if (d <= 120) brackets['76-120s']++;
      else brackets['>120s']++;
    });
    Object.entries(brackets).forEach(([k, v]) => console.log('  ' + k + ': ' + v + ' users'));
  } else {
    console.log('No delay data (no enrolledAt timestamps).');
  }

  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
