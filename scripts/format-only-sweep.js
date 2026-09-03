/**
 * COPY CLAIM SWEEP — read-only. Run after ANY copy change:  node scripts/format-only-sweep.js
 *
 * Two detectors over every tracked served page (p, li, headings, title, meta
 * descriptions, JSON-LD strings, llms.txt lines):
 *
 *   A. FORMAT-ONLY: the PAID product described by format alone — a question
 *      count, a duration, a domain weighting, "full-length", "timed" — with
 *      nothing in the same block naming the 400-question bank it draws from.
 *      Four commits on 3 Sep 2026 fixed this class one screenshot at a time;
 *      run against the pre-fix bytes this detector found all four sites.
 *
 *   B. LIVE-EXAM CLAIMS: wording that asserts how the real exam behaves, which
 *      nobody here can verify ("real exam conditions", "replicates the real",
 *      "the real exam's ...", "mirrors the real"). Copy attributes to the
 *      published exam guide, never to the live exam.
 *
 * IT OVER-TRIGGERS BY DESIGN. Exam facts from the guide ("60 questions in 120
 * minutes"), diagnostic paragraphs and generic study advice all match, and the
 * script cannot tell a product claim from an exam fact. Its output is a
 * CANDIDATE LIST FOR READING, not a verdict; the decisions already taken on
 * each residual are recorded in the calendar's Build Schedule rows for 3 Sep.
 *
 * Served publicly: scripts/ is inside the Pages deploy tree and no exclusion
 * exists (decided and declined on ROI, calendar row 459). This file holds no
 * secrets, no customer data and no local paths — it resolves the repo from its
 * own location.
 */
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const REPO = path.join(__dirname, '..');
const files = execSync('git ls-files', { cwd: REPO, encoding: 'utf8' }).split('\n')
  .filter(f => /\.(html|txt)$/.test(f) && !/^(handicappedparking-app|_lighthouse|node_modules|\.claude|scripts|audit-output|draft-output)\//.test(f) && !/^[0-9a-f]{32}\.txt$/.test(f) && f !== 'googledd8ffb443c41ec49.html' && f !== 'claude-certified-architect.html');

const FORMAT = /\b(60|30|20|10)[- ]questions?\b|\b(120|60|40|20)[- ]minutes?\b|domain[- ]weight|full[- ]length|timed (practice|exam|simulation|session|mock)/i;
const BANK = /\b400\b|question bank|the bank|whole bank|full bank/i;
// The paid product, as opposed to the real exam or the free tier.
const PRODUCT = /\b(our|simulation|simulat|practice (test|exam)s?|mock|deep practice|domain drill|focused session|full exam|full certification exam|timed exam modes?|test modes?|platform|session)\b/i;
const FREE_ONLY = /55-question|free sample|diagnostic|quick sprint/i;
const REAL_EXAM = /\b(the|anthropic'?s|official|published|actual|real) (cca|ccar-f|cca-f|exam|foundations)\b|exam guide (says|specifies|states)|published exam guide specifies|exam itself|sit the exam|registration|\$125/i;

function blocks(f, t) {
  const out = [];
  if (f.endsWith('.txt')) { t.split(/\r?\n/).forEach((l, i) => out.push({ where: 'line ' + (i + 1), text: l })); return out; }
  const lines = t.split(/\r?\n/);
  const re = /<(p|li|h1|h2|h3|td|div class="count"|title)(?:\s[^>]*)?>([\s\S]*?)<\/\1?[^>]*>/gi;
  // simpler: per-element scan on the raw text with line numbers
  let m; const elRe = /<(p|li|h1|h2|h3|title)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  while ((m = elRe.exec(t))) { const ln = t.slice(0, m.index).split(/\r?\n/).length; out.push({ where: 'line ' + ln + ' <' + m[1] + '>', text: m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() }); }
  const metaRe = /<meta\s+(?:name|property)="([^"]+)"\s+content="([^"]*)"/gi;
  while ((m = metaRe.exec(t))) { const ln = t.slice(0, m.index).split(/\r?\n/).length; out.push({ where: 'line ' + ln + ' meta ' + m[1], text: m[2] }); }
  const ldRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  while ((m = ldRe.exec(t))) { const ln = t.slice(0, m.index).split(/\r?\n/).length; const strs = [...m[1].matchAll(/"(?:description|text|name|headline)":"((?:[^"\\]|\\.)*)"/g)].map(x => x[1]); strs.forEach(s => out.push({ where: 'line ' + ln + ' json-ld', text: s })); }
  return out;
}
const LIVE_EXAM = /real exam conditions|real testing conditions|under real conditions|replicates? the real|the real exam'?s (length|format|conditions|weighting|domain)|mirrors? the real|matching (the )?real exam|as the real (cca )?exam|exactly (as|like) the real|like the real (exam|thing)|simulat(es|ing) (the )?(actual|real) exam/i;
const live = [];
const hits = [], realExam = [], freeOnly = [];
for (const f of files) {
  const t = fs.readFileSync(path.join(REPO, f), 'utf8');
  for (const b of blocks(f, t)) {
    if (LIVE_EXAM.test(b.text)) live.push(f + ' ' + b.where + ' | ' + b.text.replace(/&amp;/g, '&').slice(0, 230));
    if (!FORMAT.test(b.text) || BANK.test(b.text)) continue;
    const entry = f + ' ' + b.where + ' | ' + b.text.replace(/&amp;/g, '&').slice(0, 230);
    if (FREE_ONLY.test(b.text) && !PRODUCT.test(b.text)) { freeOnly.push(entry); continue; }
    if (PRODUCT.test(b.text)) hits.push(entry);
    else realExam.push(entry);
  }
}
console.log('=== A. PAID PRODUCT DESCRIBED BY FORMAT ALONE, NO BANK NAMED (' + hits.length + ')');
hits.forEach(h => console.log(' - ' + h));
console.log('\n=== FORMAT MENTIONS WITH NO PRODUCT MARKER (likely the real exam or generic; judge by eye) (' + realExam.length + ')');
realExam.forEach(h => console.log(' - ' + h));
console.log('\n=== FREE-TIER-ONLY BLOCKS, skipped (' + freeOnly.length + ')');
console.log('\n=== B. CLAIMS ABOUT HOW THE LIVE EXAM BEHAVES (' + live.length + ') -- study advice may stay; product claims attribute to the published guide');
live.forEach(h => console.log(' - ' + h));
console.log('\nfiles swept:', files.length);
