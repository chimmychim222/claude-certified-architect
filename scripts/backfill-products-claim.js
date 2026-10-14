/**
 * B2 backfill (Oct 2026): give every CCAR-F owner the additive products claim
 * and entitlements map, so that every consumer can eventually read products
 * only. Idempotent and re-runnable. NEVER removes or changes enrolled.
 *
 *   Auth:      every account with the custom claim enrolled:true gets
 *              products.ccar = true merged into its claims (nothing else changes).
 *   Firestore: every users/{uid} with enrolled == true and no entitlements.ccar
 *              gets entitlements.ccar = {grantedAt: enrolledAt or now,
 *              stripeSessionId: the doc's value or null, via: 'backfill'}.
 *
 * Usage:
 *   node scripts/backfill-products-claim.js <service-account.json>            (dry run, counts only)
 *   node scripts/backfill-products-claim.js <service-account.json> --apply    (writes, logs every uid)
 *
 * Run only after the B2 webhook is live, so the webhook cannot race it.
 */
const admin = require('firebase-admin');
const path  = require('path');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const args  = process.argv.slice(2);
const apply = args.includes('--apply');
const saPath = args.find(a => !a.startsWith('--'));
if (!saPath) { console.error('Usage: node scripts/backfill-products-claim.js <service-account.json> [--apply]'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(saPath))) });
const auth = admin.auth();
const db   = getFirestore(admin.app(), 'default');

(async () => {
  console.log(apply ? 'APPLY mode: writing.' : 'DRY RUN: counting only, nothing written.');

  // ── Auth claims ───────────────────────────────────────────────────────────
  let scanned = 0, enrolledClaim = 0, alreadyHasCcar = 0, needClaim = 0, wroteClaim = 0, claimErrors = 0;
  let token;
  do {
    const page = await auth.listUsers(1000, token);
    for (const u of page.users) {
      scanned++;
      const c = u.customClaims || {};
      if (c.enrolled !== true) continue;
      enrolledClaim++;
      const products = (c.products && typeof c.products === 'object') ? c.products : {};
      if (products.ccar === true) { alreadyHasCcar++; continue; }
      needClaim++;
      if (!apply) continue;
      try {
        // Merge: every existing claim kept, enrolled untouched, products.ccar added.
        await auth.setCustomUserClaims(u.uid, Object.assign({}, c, { products: Object.assign({}, products, { ccar: true }) }));
        wroteClaim++;
        console.log('claim', u.uid, u.email || '(no email)');
      } catch (e) { claimErrors++; console.error('claim FAILED', u.uid, e.message); }
    }
    token = page.pageToken;
  } while (token);
  console.log(`Auth: scanned ${scanned}; enrolled claim ${enrolledClaim}; already products.ccar ${alreadyHasCcar}; needing the claim ${needClaim}; written ${wroteClaim}; errors ${claimErrors}`);

  // ── Firestore users docs ──────────────────────────────────────────────────
  const snap = await db.collection('users').where('enrolled', '==', true).get();
  let docs = 0, alreadyHasEnt = 0, needEnt = 0, wroteEnt = 0, entErrors = 0;
  for (const doc of snap.docs) {
    docs++;
    const d = doc.data();
    if (d.entitlements && d.entitlements.ccar) { alreadyHasEnt++; continue; }
    needEnt++;
    if (!apply) continue;
    try {
      await doc.ref.set({ entitlements: { ccar: {
        grantedAt:       d.enrolledAt || FieldValue.serverTimestamp(),
        stripeSessionId: d.stripeSessionId || null,
        via:             'backfill',
      } } }, { merge: true });
      wroteEnt++;
      console.log('entitlement', doc.id, (d.email || '(no email)'));
    } catch (e) { entErrors++; console.error('entitlement FAILED', doc.id, e.message); }
  }
  console.log(`Firestore: enrolled docs ${docs}; already entitlements.ccar ${alreadyHasEnt}; needing it ${needEnt}; written ${wroteEnt}; errors ${entErrors}`);
  console.log(apply ? 'Done. Re-run without --apply to confirm zero remaining.' : 'Dry run complete. Re-run with --apply to write.');
  process.exit(claimErrors || entErrors ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
