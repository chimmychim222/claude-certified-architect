/**
 * Merges the 100 questions from new-questions.js into index.html
 * Usage: node scripts/merge-questions.js
 */
const fs = require('fs');
const path = require('path');

const NEW_QUESTIONS = require('./new-questions.js');

const indexPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');

// Find insertion point — just before the closing ]; of the questions array
// The file uses Windows line endings (\r\n)
const insertMarker = '];\r\n\r\n// ═══════════════════════════════════════\r\n// LESSON CONTENT';
const insertIdx = html.indexOf(insertMarker);
if (insertIdx === -1) {
  console.error('Could not find insertion point in index.html');
  process.exit(1);
}

// Convert each question object to the same JS literal format used in index.html
function serializeQuestion(q) {
  const opts = q.o.map(s => JSON.stringify(s)).join(',');
  const question = JSON.stringify(q.q);
  const explanation = JSON.stringify(q.e);
  const domain = JSON.stringify(q.d);
  return `{d:${domain},q:${question},o:[${opts}],a:${q.a},\ne:${explanation}},`;
}

// Group by domain for readable section comments
const domains = [
  'Agentic Architecture & Orchestration',
  'Claude Code Configuration',
  'Prompt Engineering & Structured Output',
  'Tool Design & MCP Integration',
  'Context Management & Reliability',
];

const sections = [];
for (const domain of domains) {
  const qs = NEW_QUESTIONS.filter(q => q.d === domain);
  if (qs.length === 0) continue;
  const lines = qs.map(serializeQuestion).join('\n');
  sections.push(`\r\n// ═══ NEW: ${domain} (${qs.length}) ═══\r\n${lines}`);
}

const insertionText = sections.join('\n');

const newHtml = html.slice(0, insertIdx) + insertionText + '\r\n' + html.slice(insertIdx);

// Verify question count
const newCount = (newHtml.match(/\{d:/g) || []).length;
const oldCount = (html.match(/\{d:/g) || []).length;
console.log(`Question count: ${oldCount} → ${newCount}`);

if (newCount < oldCount + 90) {
  console.error(`Too few questions inserted (got ${newCount - oldCount}, expected ~100), aborting`);
  process.exit(1);
}

fs.writeFileSync(indexPath, newHtml, 'utf8');
console.log(`✓ index.html updated — ${newCount} total questions`);
