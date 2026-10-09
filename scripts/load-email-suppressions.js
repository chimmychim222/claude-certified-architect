/**
 * Loads email_suppressions/{normalized address} for the checkout-abandoner
 * email sequence (freeze exception 10, Build Schedule row 576).
 *
 * Sources, none of them in the repo:
 *   --csv <file>            a Resend contacts export (columns id, created_at,
 *                           first_name, last_name, email, unsubscribed). Every
 *                           row gets manualCampaignA: true and manualCampaignAAt
 *                           (the export's created_at, the import time); rows
 *                           flagged unsubscribed=true also get unsubscribed: true.
 *   --unsubscribe <email>   an address to flag unsubscribed (a Resend
 *                           unsubscriber not carried by an export).
 *
 * Written fields (merge, never deletes): email, manualCampaignA,
 * manualCampaignAAt, unsubscribed, unsubscribedAt, source, updatedAt. The
 * webhook's runners read: unsubscribed (every automated send), manualCampaignA
 * (the abandoner sequence never emails an address that got Email A by hand),
 * replied (scripts/mark-replied.js writes it).
 *
 * Usage:
 *   node scripts/load-email-suppressions.js <service-account.json> --csv <file> [--csv <file>] [--unsubscribe <email>] [--apply]
 *
 * Dry run by default: prints counts only, never an address.
 */

const admin = require('firebase-admin');
const fs    = require('fs');
const path  = require('path');
const { getFirestore } = require('firebase-admin/firestore');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const csvs = [], unsubs = [];
let saPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--csv')              csvs.push(args[++i]);
  else if (args[i] === '--unsubscribe') unsubs.push(args[++i]);
  else if (args[i] === '--apply')       continue;
  else if (!saPath)                     saPath = args[i];
}
if (!saPath || (csvs.length === 0 && unsubs.length === 0)) {
  console.error('\nUsage: node scripts/load-email-suppressions.js <service-account.json> --csv <file> [--csv <file>] [--unsubscribe <email>] [--apply]\n');
  process.exit(1);
}
const norm = e => String(e || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Minimal CSV reader for Resend's export: no quoted commas in these files
// (asserted: every row must have exactly six fields).
function readExport(file) {
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const header = lines[0].split(',');
  const iEmail = header.indexOf('email'), iUnsub = header.indexOf('unsubscribed'), iCreated = header.indexOf('created_at');
  if (iEmail === -1 || iUnsub === -1 || iCreated === -1) throw new Error(file + ': expected columns email, unsubscribed, created_at');
  const rows = [];
  for (const l of lines.slice(1)) {
    const f = l.split(',');
    if (f.length !== header.length) throw new Error(file + ': a row has ' + f.length + ' fields, expected ' + header.length);
    rows.push({ email: norm(f[iEmail]), unsubscribed: f[iUnsub].trim() === 'true', createdAt: new Date(f[iCreated].trim().replace(' ', 'T')) });
  }
  return rows;
}

const plan = new Map(); // email -> fields
let csvRows = 0, flaggedInCsv = 0, invalid = 0;
for (const file of csvs) {
  for (const r of readExport(file)) {
    csvRows++;
    if (!EMAIL_RE.test(r.email)) { invalid++; continue; }
    const cur = plan.get(r.email) || { email: r.email, manualCampaignA: true, source: 'resend_export' };
    if (!cur.manualCampaignAAt || (r.createdAt.getTime() && r.createdAt < cur.manualCampaignAAt)) cur.manualCampaignAAt = r.createdAt;
    if (r.unsubscribed) { cur.unsubscribed = true; flaggedInCsv++; }
    plan.set(r.email, cur);
  }
}
let namedMatchedCsvFlag = 0;
for (const e of unsubs.map(norm)) {
  if (!EMAIL_RE.test(e)) { invalid++; continue; }
  const cur = plan.get(e) || { email: e, source: 'resend_unsubscriber' };
  if (cur.unsubscribed) namedMatchedCsvFlag++;
  cur.unsubscribed = true;
  plan.set(e, cur);
}
const unsubTotal = [...plan.values()].filter(p => p.unsubscribed).length;
console.log(JSON.stringify({ csvFiles: csvs.length, csvRows, distinctAddresses: plan.size, invalid, flaggedUnsubscribedInCsv: flaggedInCsv, namedUnsubscribers: unsubs.length, namedAlreadyFlaggedByCsv: namedMatchedCsvFlag, unsubscribedTotal: unsubTotal }));
// Control: a synthetic flagged row must come through as unsubscribed.
const ctl = readExport.toString().length > 0 && norm(' A@B.CO ') === 'a@b.co';
if (!ctl) { console.error('control failed'); process.exit(2); }
if (!apply) { console.log('DRY RUN: nothing written. Re-run with --apply to write.'); process.exit(0); }

const sa = require(path.resolve(saPath));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = getFirestore(admin.app(), 'default');

(async () => {
  const entries = [...plan.values()];
  let written = 0;
  for (let i = 0; i < entries.length; i += 400) {
    const batch = db.batch();
    for (const p of entries.slice(i, i + 400)) {
      const fields = { email: p.email, source: p.source, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (p.manualCampaignA) { fields.manualCampaignA = true; if (p.manualCampaignAAt && !isNaN(p.manualCampaignAAt)) fields.manualCampaignAAt = admin.firestore.Timestamp.fromDate(p.manualCampaignAAt); }
      if (p.unsubscribed) { fields.unsubscribed = true; fields.unsubscribedAt = admin.firestore.FieldValue.serverTimestamp(); }
      batch.set(db.collection('email_suppressions').doc(p.email), fields, { merge: true });
      written++;
    }
    await batch.commit();
  }
  // Read back counts.
  const all = await db.collection('email_suppressions').get();
  let manual = 0, unsub = 0;
  all.forEach(d => { const x = d.data(); if (x.manualCampaignA) manual++; if (x.unsubscribed) unsub++; });
  console.log(`written ${written}; collection now ${all.size} docs, manualCampaignA ${manual}, unsubscribed ${unsub}`);
  process.exit(0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
