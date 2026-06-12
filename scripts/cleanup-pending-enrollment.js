/**
 * Deletes an orphaned pending_enrollments/{email} doc — for cases where the
 * Stripe checkout email will never match any Firebase Auth account (e.g. a
 * typo'd email at checkout, and the customer has already been enrolled under
 * their correct account via a separate payment).
 *
 * Without this cleanup the doc sits forever and eventually trips the
 * stale-pending-enrollment alert in stripe-webhook.js (>48h old).
 *
 * Usage:
 *   node scripts/cleanup-pending-enrollment.js <service-account.json> <email> [--apply]
 *
 * Default is a DRY RUN (prints the doc, makes no changes). Pass --apply to delete.
 */

const admin = require('firebase-admin');
const path  = require('path');
const { getFirestore } = require('firebase-admin/firestore');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const positional = args.filter(a => a !== '--apply');

if (positional.length < 2) {
  console.error('\nUsage: node scripts/cleanup-pending-enrollment.js <service-account.json> <email> [--apply]\n');
  process.exit(1);
}

const serviceAccountPath = path.resolve(positional[0]);
const email = positional[1].toLowerCase();

const sa = require(serviceAccountPath);
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = getFirestore(admin.app(), 'default');

(async () => {
  console.log('Project:', sa.project_id);
  console.log('Mode:', apply ? 'LIVE (will delete)' : 'DRY RUN (no writes)');
  console.log('Target: pending_enrollments/' + email);
  console.log('');

  const ref = db.collection('pending_enrollments').doc(email);
  const snap = await ref.get();

  if (!snap.exists) {
    console.log('No such doc — nothing to do.');
    process.exit(0);
  }

  console.log('Found doc:', JSON.stringify({
    ...snap.data(),
    createdAt: snap.data().createdAt?.toDate?.()?.toISOString() || snap.data().createdAt,
  }, null, 2));

  // Sanity check: only delete if a real Firebase Auth account is already
  // enrolled with the "sibling" account this typo'd payment was meant for.
  // (We don't hardcode that email here — this is a generic check the
  // operator should eyeball before passing --apply.)

  if (!apply) {
    console.log('\nDRY RUN — nothing deleted. Re-run with --apply to delete this doc.');
    process.exit(0);
  }

  await ref.delete();
  console.log('\nDeleted pending_enrollments/' + email);
  process.exit(0);
})().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
