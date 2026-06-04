/**
 * Generates 100 new CCA practice questions and inserts them into index.html
 * Usage: ANTHROPIC_API_KEY=sk-ant-... node scripts/generate-questions.js
 */
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Domain distribution: target 400 total from 300 current
// Current: Agentic 81, ClaudeCode 59, Prompt 60, Tool 54, Context 46
// Target:  Agentic 108, ClaudeCode 80, Prompt 80, Tool 72, Context 60
const BATCHES = [
  { domain: 'Agentic Architecture & Orchestration',     count: 27 },
  { domain: 'Claude Code Configuration',                count: 21 },
  { domain: 'Prompt Engineering & Structured Output',   count: 20 },
  { domain: 'Tool Design & MCP Integration',            count: 18 },
  { domain: 'Context Management & Reliability',         count: 14 },
];

/** Extract existing questions for a domain so Claude can avoid duplicates */
function getExistingTopics(html, domain) {
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('&', '&amp;|&');
  const regex = new RegExp(`\\{d:"${domain}"[\\s\\S]*?\\},`, 'g');
  const matches = html.match(regex) || [];
  // Extract just the question text to show Claude what's been covered
  return matches.slice(0, 15).map(m => {
    const qMatch = m.match(/,q:"([^"]+)"/);
    return qMatch ? qMatch[1].slice(0, 120) : '';
  }).filter(Boolean);
}

async function generateBatch(domain, count, existingTopics) {
  const topicList = existingTopics.map((t, i) => `${i + 1}. ${t}`).join('\n');

  const system = `You generate scenario-based practice questions for the CCA (Claude Certified Architect) Foundations exam.

RULES:
- Every question is a real-world scenario placing the candidate as the architect making a decision
- 4 answer choices per question (options array, 0-indexed)
- One clearly correct answer
- Plausible but clearly wrong distractors
- Detailed explanation (2-3 sentences) covering why correct answer works AND why distractors fail
- No simple recall questions — test application of knowledge
- Vary difficulty: ~30% straightforward, ~50% medium, ~20% challenging
- Questions must test distinct concepts — no duplicates within this batch

OUTPUT FORMAT — return ONLY a JavaScript array literal, no markdown fences, no variable name, just the array:
[
{d:"DOMAIN",q:"Question text",o:["Option A","Option B","Option C","Option D"],a:INDEX,
e:"Explanation text"},
...
]`;

  const user = `Generate ${count} new scenario-based questions for domain: "${domain}"

These topics are ALREADY covered — do NOT duplicate them:
${topicList}

Cover a diverse range of sub-topics within "${domain}". Return only the JavaScript array.`;

  console.log(`  Calling API for ${domain} (${count} questions)...`);
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const raw = msg.content[0].text.trim();

  // Extract array by finding first [ and last ]
  const firstBracket = raw.indexOf('[');
  const lastBracket = raw.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket === -1) {
    throw new Error(`No array found in response for domain: ${domain}`);
  }
  const arrayStr = raw.slice(firstBracket, lastBracket + 1);

  // Validate it's parseable JS by trying eval in a safe context
  let parsed;
  try {
    // Use Function constructor to parse the JS array literal
    parsed = (new Function('return ' + arrayStr))();
  } catch (e) {
    throw new Error(`Failed to parse questions for ${domain}: ${e.message}\nRaw: ${arrayStr.slice(0, 300)}`);
  }

  if (!Array.isArray(parsed)) throw new Error(`Result is not an array for ${domain}`);
  if (parsed.length < count - 2) throw new Error(`Only got ${parsed.length} questions, expected ~${count} for ${domain}`);

  // Validate structure
  parsed.forEach((q, i) => {
    if (!q.d || !q.q || !q.o || q.a === undefined || !q.e) {
      throw new Error(`Question ${i} missing fields in ${domain}`);
    }
    if (!Array.isArray(q.o) || q.o.length !== 4) {
      throw new Error(`Question ${i} must have exactly 4 options in ${domain}`);
    }
    if (q.a < 0 || q.a > 3) {
      throw new Error(`Question ${i} answer index out of range in ${domain}`);
    }
  });

  console.log(`  ✓ Got ${parsed.length} validated questions for ${domain}`);
  return arrayStr;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  const indexPath = path.join(__dirname, '..', 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');

  // Find insertion point — just before the closing ]; of the questions array
  const insertMarker = '];\n\n// ═══';
  const insertIdx = html.indexOf(insertMarker);
  if (insertIdx === -1) {
    console.error('Could not find insertion point in index.html');
    process.exit(1);
  }

  const allNewQuestions = [];

  for (const { domain, count } of BATCHES) {
    console.log(`\nGenerating ${count} questions for: ${domain}`);
    const existingTopics = getExistingTopics(html, domain);
    try {
      const arrayStr = await generateBatch(domain, count, existingTopics);
      // Strip outer [ ] and just keep the object literals
      const inner = arrayStr.slice(arrayStr.indexOf('{'), arrayStr.lastIndexOf('}') + 1);
      allNewQuestions.push(`\n// ═══ NEW: ${domain} ═══\n${inner},`);
    } catch (err) {
      console.error(`ERROR for ${domain}:`, err.message);
      process.exit(1);
    }
    // Small delay between API calls
    await new Promise(r => setTimeout(r, 1000));
  }

  const totalNewText = allNewQuestions.join('\n');

  // Insert before the closing ];
  const newHtml = html.slice(0, insertIdx) + totalNewText + '\n' + html.slice(insertIdx);

  // Verify question count increased
  const newCount = (newHtml.match(/\{d:/g) || []).length;
  console.log(`\nQuestion count: 300 → ${newCount}`);
  if (newCount < 380) {
    console.error('Too few questions generated, aborting');
    process.exit(1);
  }

  fs.writeFileSync(indexPath, newHtml, 'utf8');
  console.log('✓ index.html updated with new questions');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
