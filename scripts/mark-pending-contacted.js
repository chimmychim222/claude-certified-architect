/**
 * Moves pending_enrollments/{email} docs into a terminal state so the stale
 * alert stops reporting them.
 *
 * Why this exists. pending_enrollments had no terminal state: a record that
 * will never be claimed alerted once a day forever, because the only throttle
 * was a 24h lastAlertedAt cooldown. Three records did exactly that for 130
 * days. An alert that is correct and useless trains the owner to ignore the
 * channel, which is the state the next genuinely stranded buyer arrives in.
 *
 * stripe-webhook.js now skips any doc whose status is 'contacted' or
 * 'abandoned' (PENDING_TERMINAL_STATUSES) before any other guard. This script
 * is how a human sets that field.
 *
 * IT NEVER DELETES ANYTHING. A buyer who turns up in six months still claims
 * successfully: /claim-enrollment only tests whether the doc exists, and this
 * writes two fields onto it. It also never touches auth claims, the users
 * collection, or Stripe.
 *
 * Usage:
 *   node scripts/mark-pending-contacted.js <service-account.json>
 *   node scripts/mark-pending-contacted.js <service-account.json> --apply <email> [<email> ...]
 *
 * Default is a DRY RUN: it lists every doc in the collection with its age,
 * status and alert history, and proposes a set. --apply writes ONLY to the
 * addresses named explicitly on the command line -- there is deliberately no
 * "apply to everything you just listed", because the whole point of the dry run
 * is that a human reads it first.
 *
 *   --status=abandoned   write 'abandoned' instead of the default 'contacted'
 */

const admin = require('firebase-admin');
const path  = require('path');
const { getFirestore } = require('firebase-admin/firestore');

// Kept in step with stripe-webhook.js. Duplicated rather than imported because
// that file starts an Express server and a 6-hourly interval on require.
const PENDING_TERMINAL_STATUSES = ['contacted', 'abandoned'];

// The twelve addresses excluded from every Stripe analysis on this project.
// Matched as substrings so the +ccatestN variants are caught whatever the
// mailbox part looks like. A match does NOT block anything -- it only flags the
// row in the dry run and refuses an --apply that names it without
// --include-test, so an owner test record is never quietly rewritten.
//
// Two of the twelve are personal addresses and this file is served publicly by
// GitHub Pages, so they are SUPPLIED, not hardcoded. Set
// CCA_TEST_ACCOUNT_MARKERS to a comma-separated list of the remaining markers.
// The two below are generic and safe to publish; without the env var they still
// catch the +ccatestN and joshtest variants, but NOT the two personal ones --
// which is why the run prints a warning when it is unset.
const BUILTIN_MARKERS = ['joshtest', '+ccatest'];
const EXTRA_MARKERS   = (process.env.CCA_TEST_ACCOUNT_MARKERS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const TEST_ACCOUNT_MARKERS = [...BUILTIN_MARKERS, ...EXTRA_MARKERS];

const isTestAccount = e => TEST_ACCOUNT_MARKERS.some(m => (e || '').toLowerCase().includes(m));

const args        = process.argv.slice(2);
const apply       = args.includes('--apply');
const includeTest = args.includes('--include-test');
const statusArg   = (args.find(a => a.startsWith('--status=')) || '--status=contacted').split('=')[1];
const positional  = args.filter(a => !a.startsWith('--'));

if (positional.length < 1) {
  console.error('\nUsage: node scripts/mark-pending-contacted.js <service-account.json> [--apply <email> ...] [--status=contacted|abandoned] [--include-test]\n');
  process.exit(1);
}
if (!PENDING_TERMINAL_STATUSES.includes(statusArg)) {
  console.error(`\n--status must be one of: ${PENDING_TERMINAL_STATUSES.join(', ')}\n`);
  process.exit(1);
}

const serviceAccountPath = path.resolve(positional[0]);
const targets = positional.slice(1).map(e => e.toLowerCase());

if (apply && !targets.length) {
  console.error('\n--apply requires at least one email address. Run the dry run first and name the records you want written.\n');
  process.exit(1);
}

const sa = require(serviceAccountPath);
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = getFirestore(admin.app(), 'default');

const iso = ts => ts?.toDate?.()?.toISOString?.() || (ts ? String(ts) : null);
const hours = ts => {
  const ms = ts?.toMillis?.();
  return ms ? Math.round((Date.now() - ms) / 3600000) : null;
};

(async () => {
  console.log('Project:', sa.project_id);
  console.log('Mode:   ', apply ? `LIVE (will write status='${statusArg}')` : 'DRY RUN (no writes)');
  if (apply) console.log('Targets:', targets.join(', '));
  if (!EXTRA_MARKERS.length) {
    console.warn('WARNING: CCA_TEST_ACCOUNT_MARKERS is unset. Only the generic test-account');
    console.warn('         markers are active, so two of the twelve excluded addresses will');
    console.warn('         NOT be flagged as owner records in the listing below.');
  }
  console.log('');

  const snap = await db.collection('pending_enrollments').get();
  console.log(`pending_enrollments holds ${snap.size} document(s).\n`);

  const rows = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    const email = (d.email || doc.id).toLowerCase();
    rows.push({
      id:            doc.id,
      email,
      status:        d.status || '(absent -> read as unclaimed)',
      terminal:      PENDING_TERMINAL_STATUSES.includes(d.status),
      ageHours:      hours(d.createdAt),
      createdAt:     iso(d.createdAt),
      lastAlertedAt: iso(d.lastAlertedAt),
      stripeSession: d.stripeSessionId || null,
      isTest:        isTestAccount(email) || isTestAccount(doc.id),
    });
  }
  rows.sort((a, b) => (b.ageHours || 0) - (a.ageHours || 0));

  for (const r of rows) {
    console.log(`  ${r.isTest ? '[TEST/OWNER]' : '[   BUYER  ]'} ${r.id}`);
    console.log(`      status         : ${r.status}${r.terminal ? '  <- already terminal, alert already skips it' : ''}`);
    console.log(`      age            : ${r.ageHours === null ? '(no createdAt)' : r.ageHours + 'h'}   created ${r.createdAt || '(none)'}`);
    console.log(`      lastAlertedAt  : ${r.lastAlertedAt || '(never alerted)'}`);
    console.log(`      stripeSession  : ${r.stripeSession || '(none)'}`);
    console.log('');
  }

  const proposal = rows.filter(r => !r.terminal && !r.isTest);
  const excluded = rows.filter(r => r.isTest);

  console.log('--- PROPOSED ---');
  console.log(`  would set status='${statusArg}':  ${proposal.length ? proposal.map(r => r.id).join(', ') : '(none)'}`);
  console.log(`  excluded as test/owner records: ${excluded.length ? excluded.map(r => r.id).join(', ') : '(none)'}`);
  console.log(`  already terminal, left alone:   ${rows.filter(r => r.terminal).map(r => r.id).join(', ') || '(none)'}`);
  console.log('');

  if (!apply) {
    console.log('DRY RUN — nothing written. To apply, name the records explicitly:');
    console.log(`  node scripts/mark-pending-contacted.js <service-account.json> --apply ${proposal.map(r => r.id).join(' ') || '<email>'}`);
    process.exit(0);
  }

  let written = 0;
  for (const id of targets) {
    const row = rows.find(r => r.id === id);
    if (!row) {
      console.warn(`  SKIP ${id} — no such document in pending_enrollments.`);
      continue;
    }
    if (row.isTest && !includeTest) {
      console.warn(`  SKIP ${id} — flagged as a test/owner record. Pass --include-test if you really mean it.`);
      continue;
    }
    await db.collection('pending_enrollments').doc(id).set(
      {
        status:      statusArg,
        contactedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    console.log(`  WROTE ${id} -> status='${statusArg}'`);
    written++;
  }

  console.log(`\nDone. ${written} document(s) written, 0 deleted.`);
  console.log('Re-run without --apply to confirm the new state.');
  process.exit(0);
})().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
