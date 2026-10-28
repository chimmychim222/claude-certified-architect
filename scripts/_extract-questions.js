/**
 * Prints the CCAR-F bank grouped by domain as JSON on stdout (same shape as before Stage B2).
 *
 * Stage B2 (Oct 2026): the bank is no longer a literal in app.js. The source of truth is the
 * private repository cca-question-banks, read through its lib.js: ../cca-question-banks beside
 * this repository, or the directory named by the BANK_DIR environment variable. The export
 * index i is dropped so the output matches what the app.js literal used to give.
 */
const fs = require('fs');
const path = require('path');

const BANK_SIZE = 500;
function die(msg) { console.error('\nABORT — ' + msg); process.exit(1); }

const BANK_DIR = process.env.BANK_DIR || path.join(__dirname, '..', '..', 'cca-question-banks');
if (!fs.existsSync(path.join(BANK_DIR, 'lib.js'))) die('bank repository not found at ' + BANK_DIR + ' (clone cca-question-banks beside this repo, or set BANK_DIR)');
const { loadBankFiles } = require(path.join(BANK_DIR, 'lib.js'));
const raw = loadBankFiles(BANK_DIR, 'ccar').items;
if (!Array.isArray(raw) || raw.length !== BANK_SIZE) die('the JSON bank holds ' + (Array.isArray(raw) ? raw.length : typeof raw) + ' items, expected exactly ' + BANK_SIZE + '.');
const Q = raw.map(q => { const o = { d: q.d, q: q.q, o: q.o, a: q.a }; if (q.type) o.type = q.type; o.e = q.e; return o; });

// Group by domain
const byDomain = {};
Q.forEach(q => {
  if (!byDomain[q.d]) byDomain[q.d] = [];
  byDomain[q.d].push(q);
});

console.log(JSON.stringify({ total: Q.length, byDomain }));
