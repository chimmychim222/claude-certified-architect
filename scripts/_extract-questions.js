/**
 * Extracts the QUESTIONS array from app.js using a string-aware parser.
 * Writes questions grouped by domain to stdout as JSON.
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// String-aware AND comment-aware bracket counter. The comment-awareness was
// added 3 Sep 2026: an apostrophe in a // comment between items opened a
// phantom string, the count desynchronised, and the slice ran on to the close
// of LESSONS while still parsing to 400 items by luck. The guards below make
// that failure loud instead of silent. Same function as scripts/build-pools.js.
const BANK_SIZE = 400;
function die(msg) { console.error('\nABORT — ' + msg); process.exit(1); }
function extractArrayLiteral(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const open = start + marker.length - 1;            // index of '['
  let depth = 0, inStr = false, strCh = '', esc = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === strCh) inStr = false;
      continue;
    }
    if (c === '/' && n === '/') { const nl = src.indexOf('\n', i); if (nl === -1) return null; i = nl; continue; }
    if (c === '/' && n === '*') { const ce = src.indexOf('*/', i + 2); if (ce === -1) return null; i = ce + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return { text: src.slice(open, i + 1), end: i }; }
  }
  return null;                                        // never closed
}

const extracted = extractArrayLiteral(html, 'const QUESTIONS = [');
if (!extracted) die('Could not find a CLOSED "const QUESTIONS = [ ... ]" literal in app.js.');
const arrStr = extracted.text;
if (arrStr.includes('const LESSONS')) die('QUESTIONS extraction ran past its own close into LESSONS (the slice contains "const LESSONS").');

// Write to a temp file so Node can require() it (avoids eval)
const tmp = path.join(__dirname, '_qtmp_questions.js');
fs.writeFileSync(tmp, 'module.exports = ' + arrStr + ';');

let Q;
try {
  Q = require(tmp);
} finally {
  fs.unlinkSync(tmp);
}
if (!Array.isArray(Q) || Q.length !== BANK_SIZE) die('QUESTIONS parsed to ' + (Array.isArray(Q) ? Q.length : typeof Q) + ' items, expected exactly ' + BANK_SIZE + '.');

// Group by domain
const byDomain = {};
Q.forEach(q => {
  if (!byDomain[q.d]) byDomain[q.d] = [];
  byDomain[q.d].push(q);
});

console.log(JSON.stringify({ total: Q.length, byDomain }));
