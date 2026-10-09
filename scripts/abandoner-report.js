/**
 * READ-ONLY report for the automated checkout-abandoner emails (freeze
 * exception 10, Build Schedule row 576). Zero writes anywhere.
 *
 * For a date range it lists:
 *   - sends per step (abandoner_sends, by sentAt) and per day;
 *   - unsubscribes through the abandoner link (email_suppressions with
 *     source abandoner_link, by unsubscribedAt);
 *   - purchases by recipients within 7 days of their send, from Stripe
 *     Checkout Sessions (paid, test accounts excluded), joined on the session
 *     email and on the Auth email behind client_reference_id, exact and
 *     lower-cased, as the 9 Oct 2026 ROI check did;
 *   - the webhook's per-day send counter (email_send_counts) as the volume record.
 *
 * Usage:
 *   node scripts/abandoner-report.js <service-account.json> <stripe-key-file> --from 2026-10-09 --to 2026-10-16
 *
 * Addresses are masked in the output. The Stripe key is read from the file
 * named on the command line (the read-only key under testing keys/).
 */

const admin = require('firebase-admin');
const fs    = require('fs');
const path  = require('path');
const { getFirestore } = require('firebase-admin/firestore');

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const positional = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
const from = opt('--from'), to = opt('--to');
if (positional.length < 2 || !from || !to) {
  console.error('\nUsage: node scripts/abandoner-report.js <service-account.json> <stripe-key-file> --from YYYY-MM-DD --to YYYY-MM-DD\n');
  process.exit(1);
}
const FROM = new Date(from + 'T00:00:00Z'), TO = new Date(to + 'T23:59:59.999Z');
const SEVEN_D = 7 * 24 * 3600000;
const TEST = /joshtest|\+ccatest|@claudecertifiedarchitects\.com/i;   // the generic markers; add the personal ones via CCA_TEST_ACCOUNT_MARKERS
const extra = (process.env.CCA_TEST_ACCOUNT_MARKERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const isTest = e => !!e && (TEST.test(e) || extra.some(m => e.toLowerCase().includes(m)));
const mask = e => e ? e.replace(/^(.{2}).*(@.*)$/, '$1***$2') : e;
const norm = e => String(e || '').trim().toLowerCase();
const ms = v => (v && typeof v.toMillis === 'function') ? v.toMillis() : 0;

const sa = require(path.resolve(positional[0]));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = getFirestore(admin.app(), 'default');
const auth = admin.auth();
const stripe = require('stripe')(fs.readFileSync(path.resolve(positional[1]), 'utf8').trim(), { apiVersion: '2024-06-20' });

(async () => {
  console.log(`range ${FROM.toISOString()} to ${TO.toISOString()} (read ${new Date().toISOString()})`);

  // Sends
  const sendsSnap = await db.collection('abandoner_sends').where('sentAt', '>=', FROM).where('sentAt', '<=', TO).get();
  const sends = sendsSnap.docs.map(d => ({ id: d.id, ...d.data(), sentMs: ms(d.data().sentAt) }));
  const perStep = {}, perDay = {};
  for (const s of sends) { perStep[s.step] = (perStep[s.step] || 0) + 1; const k = new Date(s.sentMs).toISOString().slice(0, 10) + ':' + s.step; perDay[k] = (perDay[k] || 0) + 1; }
  console.log('sends per step:', JSON.stringify(perStep), 'total', sends.length);
  console.log('sends per day and step:', JSON.stringify(perDay));

  // Unsubscribes through the abandoner link
  const unsubSnap = await db.collection('email_suppressions').where('unsubscribedAt', '>=', FROM).where('unsubscribedAt', '<=', TO).get();
  const unsubs = unsubSnap.docs.map(d => d.data()).filter(x => x.source === 'abandoner_link');
  console.log('unsubscribes via the abandoner link:', unsubs.length, 'of', unsubSnap.size, 'unsubscribes in the range (all sources)');

  // Volume record
  const countsSnap = await db.collection('email_send_counts').get();
  const counts = {};
  countsSnap.forEach(d => { if (d.id >= from && d.id <= to) counts[d.id] = d.data(); });
  console.log('email_send_counts (UTC day):', JSON.stringify(counts));

  // Purchases within 7 days of a send
  const recipients = new Map(); // email -> earliest send in range
  for (const s of sends) { const e = norm(s.email); if (!recipients.has(e) || recipients.get(e).sentMs > s.sentMs) recipients.set(e, s); }
  const sessions = [];
  for await (const sess of stripe.checkout.sessions.list({ created: { gte: Math.floor(FROM.getTime() / 1000), lte: Math.floor((TO.getTime() + SEVEN_D) / 1000) }, limit: 100 })) {
    if (sess.payment_status !== 'paid') continue;
    const email = (sess.customer_details && sess.customer_details.email) || sess.customer_email || null;
    let authEmail = null;
    if (sess.client_reference_id) { try { authEmail = (await auth.getUser(sess.client_reference_id)).email || null; } catch (_) { authEmail = null; } }
    sessions.push({ id: sess.id, created: sess.created * 1000, email, authEmail, amount: sess.amount_total, currency: sess.currency, uid: sess.client_reference_id || null });
  }
  // Control: a synthetic session with a recipient's address must match; a stranger must not.
  const probe = [...recipients.keys()][0];
  const matchOf = s => {
    const hits = [];
    for (const [field, raw] of [['email', s.email], ['authEmail', s.authEmail]]) {
      const e = norm(raw); if (!e) continue;
      const r = recipients.get(e); if (!r) continue;
      const days = (s.created - r.sentMs) / 86400000;
      if (days >= 0 && days <= 7) hits.push({ field, step: r.step, days: +days.toFixed(2) });
    }
    return hits;
  };
  if (probe) {
    const r = recipients.get(probe);
    const pos = matchOf({ email: probe.toUpperCase(), authEmail: null, created: r.sentMs + 86400000 });
    const neg = matchOf({ email: 'nobody-' + Date.now() + '@example.invalid', authEmail: null, created: r.sentMs + 86400000 });
    console.log(`control: synthetic positive ${pos.length === 1 ? 'hit' : 'MISSED'} (upper-cased address, +1 day), synthetic negative ${neg.length === 0 ? 'clean' : 'FALSE HIT'}`);
    if (pos.length !== 1 || neg.length !== 0) { console.error('control failed; nothing below is trustworthy'); process.exit(2); }
  } else {
    console.log('no sends in the range; purchase matching skipped');
  }
  let matched = 0, revenue = 0, testPaid = 0;
  for (const s of sessions.sort((a, b) => a.created - b.created)) {
    if (isTest(s.email) || isTest(s.authEmail)) { testPaid++; continue; }
    const hits = matchOf(s);
    if (!hits.length) continue;
    matched++; revenue += s.amount || 0;
    console.log(`match ${new Date(s.created).toISOString()} ${(s.amount / 100).toFixed(2)} ${s.currency} ${mask(s.email)} auth=${mask(s.authEmail)} ${JSON.stringify(hits)}`);
  }
  console.log(`paid sessions read ${sessions.length} (test ${testPaid}); purchases by recipients within 7 days of a send: ${matched}; amount_total sum ${(revenue / 100).toFixed(2)} (mixed currencies possible)`);
  process.exit(0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
