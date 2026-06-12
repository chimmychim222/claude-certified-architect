/**
 * One-time backfill: marks examPurchaseEventSent = true for users who were
 * ALREADY enrolled before the GA4 "purchase"/"exam_purchase" event guard in
 * app.js's maybeFireExamPurchaseEvent() went live (commit 11593ae, deployed
 * 2026-06-11T15:01:16+02:00).
 *
 * WHY THIS EXISTS:
 *   maybeFireExamPurchaseEvent() fires "purchase"/"exam_purchase" the first
 *   time it sees enrolled:true with examPurchaseEventSent not yet set — that
 *   "first time" is meant to be the moment of a genuine new sale. But for
 *   customers who were enrolled BEFORE this guard existed, examPurchaseEventSent
 *   was never set, so the very next time they load the site the guard treats
 *   their long-standing enrollment as a brand-new purchase and fires
 *   "purchase" retroactively — inflating GA4 purchase counts with events that
 *   don't correspond to any real Stripe charge.
 *
 *   This script sets examPurchaseEventSent = true for those pre-existing
 *   customers (identified by enrolledAt being before the cutoff, or missing
 *   entirely for very old records), so the guard treats them as already
 *   reported and stays silent. Users enrolled AFTER the cutoff are left
 *   untouched — their first page load under the new code is a genuine
 *   new-sale event and SHOULD fire "purchase" normally.
 *
 * Usage:
 *   node scripts/backfill-exam-purchase-event-sent.js <service-account.json> [--apply] [--cutoff=<ISO date>]
 *
 * Default is a DRY RUN (prints what would change). Pass --apply to write.
 * --cutoff defaults to the deploy time above; override only if you know the
 * real deploy completed at a different time.
 */

const admin = require('firebase-admin');
const path  = require('path');
const { getFirestore } = require('firebase-admin/firestore');

const args   = process.argv.slice(2);
const apply  = args.includes('--apply');
const cutoffArg = args.find(a => a.startsWith('--cutoff='));
const CUTOFF = new Date(cutoffArg ? cutoffArg.slice('--cutoff='.length) : '2026-06-11T15:01:16+02:00');

const positional = args.filter(a => a !== '--apply' && !a.startsWith('--cutoff='));
if (positional.length < 1) {
  console.error('\nUsage: node scripts/backfill-exam-purchase-event-sent.js <service-account.json> [--apply] [--cutoff=<ISO date>]\n');
  process.exit(1);
}

const serviceAccountPath = path.resolve(positional[0]);
let sa;
try {
  sa = require(serviceAccountPath);
} catch (e) {
  console.error('\nERROR: Could not load service account file:', serviceAccountPath);
  console.error(e.message, '\n');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(sa) });
// Same custom-named "default" database as stripe-webhook.js / set-enrolled.js
const db = getFirestore(admin.app(), 'default');

console.log('Project:', sa.project_id);
console.log('Mode:', apply ? 'LIVE (will set examPurchaseEventSent: true)' : 'DRY RUN (no writes)');
console.log('Cutoff (enrolledAt before this = pre-existing customer, gets backfilled):', CUTOFF.toISOString());
console.log('');

(async () => {
  const snap = await db.collection('users').where('enrolled', '==', true).get();
  console.log(`Found ${snap.size} user(s) with enrolled=true.\n`);

  const toBackfill = [];
  const alreadySet = [];
  const skippedNew = [];

  snap.forEach(doc => {
    const d = doc.data();
    const email = d.email || '(no email)';
    const enrolledAt = (d.enrolledAt && typeof d.enrolledAt.toDate === 'function') ? d.enrolledAt.toDate() : null;

    if (d.examPurchaseEventSent === true) {
      alreadySet.push({ uid: doc.id, email });
      return;
    }
    if (enrolledAt && enrolledAt >= CUTOFF) {
      skippedNew.push({ uid: doc.id, email, enrolledAt: enrolledAt.toISOString() });
      return;
    }
    toBackfill.push({ uid: doc.id, email, enrolledAt: enrolledAt ? enrolledAt.toISOString() : '(unknown — predates enrolledAt field)' });
  });

  console.log(`Already flagged (examPurchaseEventSent=true) — left alone: ${alreadySet.length}`);
  alreadySet.forEach(u => console.log(`  - ${u.email}  uid=${u.uid}`));

  console.log(`\nEnrolled AFTER the cutoff — left alone, "purchase" SHOULD fire normally for these: ${skippedNew.length}`);
  skippedNew.forEach(u => console.log(`  - ${u.email}  uid=${u.uid}  enrolledAt=${u.enrolledAt}`));

  console.log(`\nPre-existing customers to backfill (examPurchaseEventSent -> true): ${toBackfill.length}`);
  toBackfill.forEach(u => console.log(`  - ${u.email}  uid=${u.uid}  enrolledAt=${u.enrolledAt}`));

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to perform the backfill.');
    process.exit(0);
  }

  console.log('\nWriting...');
  for (const u of toBackfill) {
    await db.collection('users').doc(u.uid).set({ examPurchaseEventSent: true }, { merge: true });
    console.log(`  ✓ ${u.email}  uid=${u.uid}`);
  }
  console.log(`\nDone. Backfilled ${toBackfill.length} user(s).`);
  process.exit(0);
})().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
