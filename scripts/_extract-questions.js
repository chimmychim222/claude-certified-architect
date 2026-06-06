/**
 * Extracts the QUESTIONS array from index.html using a string-aware parser.
 * Writes questions grouped by domain to stdout as JSON.
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const marker = 'const QUESTIONS = [';
const qStart = html.indexOf(marker) + marker.length - 1; // points to '['

// String-aware bracket counter — skips [ and ] inside strings
let depth = 0, inStr = false, strCh = '', esc = false, i = qStart;
while (i < html.length) {
  const c = html[i];
  if (esc) { esc = false; i++; continue; }
  if (c === '\\') { esc = true; i++; continue; }
  if (inStr) {
    if (c === strCh) inStr = false;
  } else {
    if (c === '"' || c === "'") { inStr = true; strCh = c; }
    else if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) break; }
  }
  i++;
}

const arrStr = html.slice(qStart, i + 1);

// Write to a temp file so Node can require() it (avoids eval)
const tmp = path.join(__dirname, '_qtmp_questions.js');
fs.writeFileSync(tmp, 'module.exports = ' + arrStr + ';');

let Q;
try {
  Q = require(tmp);
} finally {
  fs.unlinkSync(tmp);
}

// Group by domain
const byDomain = {};
Q.forEach(q => {
  if (!byDomain[q.d]) byDomain[q.d] = [];
  byDomain[q.d].push(q);
});

console.log(JSON.stringify({ total: Q.length, byDomain }));
