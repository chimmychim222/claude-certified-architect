/**
 * Backfills users/{uid}.firstBuyClickAt from checkout_intents for the
 * checkout-abandoner email sequence (freeze exception 10, Build Schedule row 576).
 *
 * Why. /pre-checkout stamps firstBuyClickAt on every logged-in Buy click from
 * the day the sequence shipped. The owner's rule 1 (9 Oct 2026) also includes
 * account holders whose FIRST click was on or after 8 Oct 2026 and before
 * go-live. checkout_intents/{uid}.initiatedAt is the only record of those
 * clicks, and it is a LOWER BOUND: the client deletes it when the checkout
 * modal is dismissed, and /pre-checkout overwrites it on the next click.
 *
 * What it writes: firstBuyClickAt = the intent's initiatedAt (the click time,
 * never "now"), ONLY where the users doc has no firstBuyClickAt. Idempotent
 * against the live stamp. It never touches enrolment, claims, the abandoner
 * map or anything else; buyers and manual-campaign addresses are excluded at
 * run time by the runner, not here.
 *
 * Usage:
 *   node scripts/backfill-first-buy-click.js <service-account.json>            dry run, counts only
 *   node scripts/backfill-first-buy-click.js <service-account.json> --apply    write
 *   --since=2026-10-08T00:00:00Z   (default; the sequence's ABANDONER_START)
 *
 * Prints counts, never an address.
 */

const admin = require('firebase-admin');
const path  = require('path');
const { getFirestore } = require('firebase-admin/firestore');

const args  = process.argv.slice(2);
const apply = args.includes('--apply');
const since = new Date((args.find(a => a.startsWith('--since=')) || '--since=2026-10-08T00:00:00Z').split('=')[1]);
const positional = args.filter(a => !a.startsWith('--'));
if (positional.length < 1 || isNaN(since.getTime())) {
  console.error('\nUsage: node scripts/backfill-first-buy-click.js <service-account.json> [--apply] [--since=ISO]\n');
  process.exit(1);
}

const sa = require(path.resolve(positional[0]));
admin.initializeApp({ credential: admin.credential.cert(sa) });
// This project's data lives in the NAMED database "default" (see stripe-webhook.js).
const db = getFirestore(admin.app(), 'default');
const ms = v => (v && typeof v.toMillis === 'function') ? v.toMillis() : 0;

(async () => {
  const t0 = new Date();
  const intents = await db.collection('checkout_intents').where('initiatedAt', '>=', since).get();
  const counts = { intents: intents.size, noUsersDoc: 0, alreadyStamped: 0, toStamp: 0, written: 0, beforeSince: 0 };
  const plan = [];
  for (const d of intents.docs) {
    const at = ms(d.data().initiatedAt);
    if (!at || at < since.getTime()) { counts.beforeSince++; continue; }
    const uid = d.id;
    const u = await db.collection('users').doc(uid).get();
    if (!u.exists) { counts.noUsersDoc++; plan.push({ uid, at, create: true }); counts.toStamp++; continue; }
    if (u.data().firstBuyClickAt) { counts.alreadyStamped++; continue; }
    plan.push({ uid, at, create: false }); counts.toStamp++;
  }
  const days = {};
  for (const p of plan) { const k = new Date(p.at).toISOString().slice(0, 10); days[k] = (days[k] || 0) + 1; }
  console.log(`read at ${t0.toISOString()} since ${since.toISOString()}`);
  console.log('counts:', JSON.stringify(counts));
  console.log('to stamp by click day (UTC):', JSON.stringify(days));
  if (!apply) { console.log('DRY RUN: nothing written. Re-run with --apply to write.'); process.exit(0); }
  for (const p of plan) {
    await db.collection('users').doc(p.uid).set(
      { firstBuyClickAt: admin.firestore.Timestamp.fromMillis(p.at) },
      { merge: true }
    );
    counts.written++;
  }
  // Read back: every planned uid now carries a stamp equal to its intent time.
  let verified = 0;
  for (const p of plan) {
    const u = await db.collection('users').doc(p.uid).get();
    if (u.exists && ms(u.data().firstBuyClickAt) === p.at) verified++;
  }
  console.log(`written ${counts.written}, read back ${verified} of ${plan.length} with the stamp equal to the intent time`);
  process.exit(verified === plan.length ? 0 : 1);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
