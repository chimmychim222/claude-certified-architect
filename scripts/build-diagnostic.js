/**
 * Updates the embedded question POOL in diagnostic/index.html.
 *
 * What this script does:
 *   1. Reads all 401 questions from app.js and groups them by domain.
 *   2. Reads the EXISTING diagnostic/index.html (does NOT regenerate it from
 *      a template).
 *   3. Finds the `const POOL = {...};` block and replaces it with a freshly
 *      serialised pool — leaving every other line of the file untouched.
 *   4. Verifies that all required custom elements (banner, CTA, analytics,
 *      DOMAIN_Q_COUNT, app.js include, etc.) are still present before writing.
 *   5. Writes the updated file back.
 *
 * Run whenever questions are added to app.js so the diagnostic pool stays
 * current. Safe to run repeatedly — only the POOL changes.
 *
 * Usage: node scripts/build-diagnostic.js
 */
const fs   = require('fs');
const path = require('path');

// ── 1. Extract QUESTIONS from app.js ──────────────────────────────────────────
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const marker = 'const QUESTIONS = [';
const qStart = appSrc.indexOf(marker) + marker.length - 1;

if (qStart < marker.length - 1) {
  console.error('ERROR: Could not find "const QUESTIONS = [" in app.js');
  process.exit(1);
}

let depth = 0, inStr = false, strCh = '', esc = false, i = qStart;
while (i < appSrc.length) {
  const c = appSrc[i];
  if (esc) { esc = false; i++; continue; }
  if (c === '\\') { esc = true; i++; continue; }
  if (inStr) { if (c === strCh) inStr = false; }
  else {
    if (c === '"' || c === "'") { inStr = true; strCh = c; }
    else if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) break; }
  }
  i++;
}
const arrStr = appSrc.slice(qStart, i + 1);
const tmp    = path.join(__dirname, '_qtmp_diag.js');
fs.writeFileSync(tmp, 'module.exports = ' + arrStr + ';');
let ALL_Q;
try { ALL_Q = require(tmp); } finally { fs.unlinkSync(tmp); }

// ── 2. Domain metadata ────────────────────────────────────────────────────────
const DOMAINS = [
  { key: 'Agentic Architecture & Orchestration'   },
  { key: 'Claude Code Configuration'              },
  { key: 'Prompt Engineering & Structured Output' },
  { key: 'Tool Design & MCP Integration'          },
  { key: 'Context Management & Reliability'       },
];

const byDomain = {};
ALL_Q.forEach(q => { (byDomain[q.d] = byDomain[q.d] || []).push(q); });

console.log(`Loaded ${ALL_Q.length} questions across ${Object.keys(byDomain).length} domains.`);
Object.entries(byDomain).forEach(([d, qs]) =>
  console.log(` ${qs.length.toString().padStart(3)}  ${d}`)
);

DOMAINS.forEach(d => {
  if (!byDomain[d.key]) {
    console.error(`ERROR: Domain not found in app.js: "${d.key}"`);
    process.exit(1);
  }
});

// ── 3. Build POOL ─────────────────────────────────────────────────────────────
const POOL = {};
DOMAINS.forEach(d => { POOL[d.key] = byDomain[d.key]; });

// ── 4. Read existing diagnostic/index.html ────────────────────────────────────
const diagPath = path.join(__dirname, '..', 'diagnostic', 'index.html');
if (!fs.existsSync(diagPath)) {
  console.error('ERROR: diagnostic/index.html not found. Cannot update pool.');
  process.exit(1);
}
let page = fs.readFileSync(diagPath, 'utf8');

// ── 5. Find and replace only the POOL constant ────────────────────────────────
// Locate `const POOL = ` then walk forward with brace counting to find the
// closing `}` of the object, then skip the trailing `;`.
const POOL_MARKER = 'const POOL = ';
const poolStartIdx = page.indexOf(POOL_MARKER);
if (poolStartIdx === -1) {
  console.error('ERROR: Could not find "const POOL = " in diagnostic/index.html.');
  console.error('Has the page been restructured? Run git log -- diagnostic/index.html to investigate.');
  process.exit(1);
}

const objStartIdx = poolStartIdx + POOL_MARKER.length; // points at the opening '{'
let d2 = 0, inS = false, sCh = '', esc2 = false, j = objStartIdx;
while (j < page.length) {
  const c = page[j];
  if (esc2) { esc2 = false; j++; continue; }
  if (c === '\\') { esc2 = true; j++; continue; }
  if (inS) { if (c === sCh) inS = false; }
  else {
    if (c === '"' || c === "'") { inS = true; sCh = c; }
    else if (c === '{') d2++;
    else if (c === '}') { d2--; if (d2 === 0) { j++; break; } }
  }
  j++;
}
// Skip the trailing ';'
const afterPool = (page[j] === ';') ? j + 1 : j;

const poolJson   = JSON.stringify(POOL).replace(/<\/script>/gi, '<\\/script>');
const newPoolStr = POOL_MARKER + poolJson + ';';
page = page.slice(0, poolStartIdx) + newPoolStr + page.slice(afterPool);

// ── 6. Verify all required custom elements are still present ──────────────────
// Belt-and-suspenders: if somehow the replacement damaged the page, refuse to
// write and explain what's missing so the developer can investigate.
const REQUIRED = [
  { marker: 'id="site-banner"',     label: 'independence disclaimer banner' },
  { marker: 'DOMAIN_Q_COUNT',       label: 'DOMAIN_Q_COUNT constant'        },
  { marker: 'id="cta-headline"',    label: 'personalised CTA headline'       },
  { marker: 'id="cta-anchor-line"', label: 'price anchor line'               },
  { marker: 'id="cta-personal-line"', label: 'personalised CTA body'         },
  { marker: 'gtag(',                label: 'analytics / gtag'                },
  { marker: 'src="/app.js"',        label: 'app.js script tag'               },
  { marker: 'openPaymentModal',     label: 'buyNow / openPaymentModal'        },
  { marker: 'const POOL = ',        label: 'newly-written POOL constant'      },
];
const missing = REQUIRED.filter(r => !page.includes(r.marker));
if (missing.length) {
  console.error('\nABORT — page is missing required elements after pool replacement:');
  missing.forEach(r => console.error(`  ✗  ${r.label}  (looking for: "${r.marker}")`));
  console.error('\nNo file was written. Check the page structure and re-run.');
  process.exit(1);
}

console.log('\nAll required custom elements verified:');
REQUIRED.forEach(r => console.log(`  ✓  ${r.label}`));

// ── 7. Write back ─────────────────────────────────────────────────────────────
fs.writeFileSync(diagPath, page, 'utf8');

const poolChars = poolJson.length;
console.log(`\n✓  diagnostic/index.html POOL refreshed (${poolChars.toLocaleString()} chars of question data)`);
console.log('   All other content preserved — banner, CTA, analytics, modal, app.js include.');
