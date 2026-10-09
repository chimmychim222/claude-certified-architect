/**
 * Marks an address as having REPLIED to the automated checkout-abandoner
 * Email A, so the sequence skips Email B (freeze exception 10, Build Schedule
 * row 576). Replies land in support@ and cannot be detected automatically;
 * this is how a human records one.
 *
 * Writes email_suppressions/{normalized address} with replied: true,
 * repliedAt, source: 'owner' (merge). Nothing else reads `replied`: the
 * nurture sequence and the diagnostic results email are unaffected, and the
 * address is NOT unsubscribed by this (use the email's own link for that).
 *
 * Usage:
 *   node scripts/mark-replied.js <service-account.json> <email> [<email> ...]
 *
 * Prints each doc back after the write.
 */

const admin = require('firebase-admin');
const path  = require('path');
const { getFirestore } = require('firebase-admin/firestore');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('\nUsage: node scripts/mark-replied.js <service-account.json> <email> [<email> ...]\n');
  process.exit(1);
}
const norm = e => String(e || '').trim().toLowerCase();
const emails = args.slice(1).map(norm).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
if (emails.length !== args.length - 1) { console.error('One of the addresses is not a valid email.'); process.exit(1); }

const sa = require(path.resolve(args[0]));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = getFirestore(admin.app(), 'default');

(async () => {
  for (const email of emails) {
    const ref = db.collection('email_suppressions').doc(email);
    await ref.set({ email, replied: true, repliedAt: admin.firestore.FieldValue.serverTimestamp(), source: 'owner', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    const back = await ref.get();
    const d = back.data();
    console.log(`${email}: replied=${d.replied} repliedAt=${d.repliedAt && d.repliedAt.toDate().toISOString()} unsubscribed=${!!d.unsubscribed} manualCampaignA=${!!d.manualCampaignA}`);
  }
  process.exit(0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
