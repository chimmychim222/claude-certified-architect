/**
 * Injects the Sample Questions section into index.html.
 * Run: node scripts/_inject-samples.js
 */
const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'index.html');
let h = fs.readFileSync(INDEX, 'utf8');
const CRLF = h.includes('\r\n');
const NL = CRLF ? '\r\n' : '\n';

// ── Guard: skip if already injected ──────────────────────────────────────
if (h.includes('sample-q-section')) {
  console.log('Already injected — nothing to do.');
  process.exit(0);
}

// ── CSS ───────────────────────────────────────────────────────────────────
const CSS = [
  '/* ── SAMPLE QUESTIONS ── */',
  '.sample-q-section{padding:90px 0;position:relative;z-index:1}',
  '.sample-q-section::before{content:\'\';position:absolute;top:0;left:0;right:0;height:1px;background:var(--border)}',
  '.sample-q-header{text-align:center;margin-bottom:52px}',
  '.sample-q-header h2{font-size:clamp(1.6rem,4vw,2.4rem);font-weight:700;color:var(--text);margin-bottom:12px}',
  '.sample-q-header p{color:var(--text2);font-size:1.05rem;max-width:540px;margin:0 auto;line-height:1.65}',
  '.sample-q-grid{display:grid;grid-template-columns:1fr;gap:20px;max-width:780px;margin:0 auto}',
  '.sq-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;transition:border-color .25s}',
  '.sq-card:hover{border-color:var(--border2)}',
  '.sq-domain{display:inline-block;font-family:-apple-system,system-ui,\'Segoe UI\',sans-serif;font-size:.7rem;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--accent);background:rgba(217,119,87,.08);border:1px solid rgba(217,119,87,.18);border-radius:20px;padding:4px 12px;margin-bottom:16px}',
  '.sq-question{font-size:1rem;line-height:1.72;color:var(--text);margin-bottom:22px}',
  '.sq-options{list-style:none;display:flex;flex-direction:column;gap:8px;margin-bottom:22px}',
  '.sq-options li{display:flex;gap:10px;align-items:flex-start;padding:10px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);font-size:.88rem;color:var(--text2);font-family:-apple-system,system-ui,\'Segoe UI\',sans-serif;line-height:1.55;transition:border-color .2s,background .2s}',
  '.sq-options li .opt-label{font-weight:700;color:var(--text3);flex-shrink:0;min-width:18px}',
  '.sq-options li.sq-correct{border-color:rgba(45,122,95,.4);background:rgba(45,122,95,.06);color:var(--text)}',
  '.sq-options li.sq-correct .opt-label{color:var(--green)}',
  '.sq-toggle{font-family:-apple-system,system-ui,\'Segoe UI\',sans-serif;font-size:.83rem;font-weight:600;color:var(--accent);background:rgba(217,119,87,.08);border:1px solid rgba(217,119,87,.2);border-radius:var(--radius-sm);padding:9px 16px;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;gap:6px}',
  '.sq-toggle:hover{background:rgba(217,119,87,.15);border-color:var(--accent2)}',
  '.sq-toggle-arrow{display:inline-block;transition:transform .25s;font-style:normal}',
  '.sq-toggle.open .sq-toggle-arrow{transform:rotate(180deg)}',
  '.sq-answer{display:none;margin-top:20px;padding-top:20px;border-top:1px solid var(--border)}',
  '.sq-answer.sq-visible{display:block}',
  '.sq-answer-label{font-family:-apple-system,system-ui,\'Segoe UI\',sans-serif;font-size:.72rem;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--green);margin-bottom:10px}',
  '.sq-explanation{font-size:.88rem;line-height:1.8;color:var(--text2);font-family:-apple-system,system-ui,\'Segoe UI\',sans-serif}',
  '@media(max-width:640px){.sq-card{padding:20px 16px}.sample-q-section{padding:60px 0}.sq-question{font-size:.95rem}.sq-options li{font-size:.84rem}}',
].join('\n');

// ── Question data ─────────────────────────────────────────────────────────
const QS = [
  {
    domain: 'Agentic Architecture &amp; Orchestration (27%)',
    q: 'A coding agent calls tools inside a loop. A developer needs to decide when to terminate the loop. Which is the correct, robust termination signal?',
    opts: [
      'Scan each assistant message for a completion phrase such as “done” or “task complete” and stop the first time one appears.',
      'Treat a ceiling of ten iterations as the loop’s primary stopping condition, whatever state the run is in when it is reached.',
      'Keep executing tools and looping while the response’s <code>stop_reason</code> is <code>tool_use</code>; stop when <code>stop_reason</code> is <code>end_turn</code>.',
      'End the loop as soon as any tool returns an error, since a failed call leaves nothing worth appending.',
    ],
    correct: 2,
    explanation: 'The API reports why generation stopped via <code>stop_reason</code>. <code>tool_use</code> means run the tools, append results, and loop back; <code>end_turn</code> means Claude is finished, so the loop ends. Parsing text for completion words is a brittle anti-pattern. A fixed iteration cap is a safety backstop, not the main control. Stopping on the first tool error prevents the agent from recovering.',
  },
  {
    domain: 'Claude Code Configuration &amp; Workflows (20%)',
    q: 'A team’s codebase-analysis skill returns a long structural report every time it runs. By the third invocation the main session can no longer answer questions about the modules it mapped on the first run, and falls back on generic description of how a service of that kind is usually laid out instead of what this codebase actually contains. Which change addresses the cause?',
    opts: [
      'Add <code>context: fork</code> to the skill’s <code>SKILL.md</code> frontmatter so it runs in an isolated subagent context and returns only its summary to the main session.',
      'Add an instruction to the skill’s <code>SKILL.md</code> body telling it to summarise its findings and keep every report short, so less of it lands in the conversation.',
      'Run <code>/compact</code> after each invocation so the accumulated reports are summarised and the session’s token budget is reclaimed before the next run.',
      'Move the skill to <code>~/.claude/skills/</code> so it becomes a personal variant and its output is scoped to your own session rather than to the project.',
    ],
    correct: 0,
    explanation: 'The skill’s verbose output is accumulating in the main conversation and crowding out what the earlier runs actually found. <code>context: fork</code> runs the skill in an isolated subagent context, so the exploration happens elsewhere and only the result comes back. Telling the skill to be brief relies on the model complying with a length instruction, which does nothing about output that is legitimately long. <code>/compact</code> is a real command and it does reduce context usage, but it acts after the pollution has happened and compresses the specifics along with everything else. Moving the skill to <code>~/.claude/skills/</code> changes who can invoke it, not where its output lands.',
  },
  {
    domain: 'Tool Design &amp; MCP Integration (18%)',
    q: 'You’re designing a tool that queries an external inventory API for an agent. The API sometimes returns “item not found” or rate-limit errors. How should the tool handle these to maximise the agent’s ability to recover?',
    opts: [
      'Write the failure to the server’s own error log with a category and a request ID, so operators can see it while the tool returns nothing to the agent.',
      'Return a structured result describing the error (clear message and error type) as the tool result, so Claude can read it and decide how to proceed.',
      'Set the MCP <code>isError</code> flag and pass the provider’s raw exception text through as the message, since the flag already marks the call as failed.',
      'Retry the call inside the tool on a fixed interval until it succeeds, so the agent only ever sees a completed lookup.',
    ],
    correct: 1,
    explanation: 'Tool results are fed back to Claude, so an error the model can actually read is what keeps the loop recoverable. A rate limit is worth waiting out; an item that does not exist never will be, and the agent can only tell those apart if the tool says which it is. A server-side log records the failure for operators and returns nothing the agent can act on. A raw exception dump beside the <code>isError</code> flag says something failed without saying what kind of failure it was or whether a retry has any chance. Retrying on a fixed interval until it succeeds never terminates on a missing item and hammers a rate-limited API.',
  },
];

const LABELS = ['A', 'B', 'C', 'D'];

function buildCard(q) {
  const optsHtml = q.opts.map((opt, oi) => {
    const cls = oi === q.correct ? ' class="sq-correct"' : '';
    return `        <li${cls}><span class="opt-label">${LABELS[oi]}</span>${opt}</li>`;
  }).join('\n');

  return `      <div class="sq-card reveal">
        <span class="sq-domain">${q.domain}</span>
        <p class="sq-question">${q.q}</p>
        <ul class="sq-options">
${optsHtml}
        </ul>
        <button class="sq-toggle" onclick="toggleSampleQ(this)" aria-expanded="false">
          <span class="sq-toggle-text">Show answer</span>
          <span class="sq-toggle-arrow" aria-hidden="true">&#x25BE;</span>
        </button>
        <div class="sq-answer" aria-hidden="true">
          <div class="sq-answer-label">&#x2713;&nbsp;Correct: ${LABELS[q.correct]}</div>
          <p class="sq-explanation">${q.explanation}</p>
        </div>
      </div>`;
}

const SECTION = `<!-- ═══════ SAMPLE QUESTIONS ═══════ -->
<section class="sample-q-section" id="sample-questions">
  <div class="container">
    <div class="sample-q-header reveal">
      <h2>See the question quality before you buy</h2>
      <p>Real scenario-based questions, every answer fully explained &mdash; just like the 400 in the full bank.</p>
    </div>
    <div class="sample-q-grid">
${QS.map(buildCard).join('\n')}
    </div>
  </div>
</section>

`;

// ── JS helper ─────────────────────────────────────────────────────────────
const JS = `
// Sample question answer reveal
function toggleSampleQ(btn) {
  var card = btn.closest('.sq-card');
  var answer = card.querySelector('.sq-answer');
  var textEl = btn.querySelector('.sq-toggle-text');
  var open = answer.classList.contains('sq-visible');
  answer.classList.toggle('sq-visible', !open);
  btn.classList.toggle('open', !open);
  btn.setAttribute('aria-expanded', String(!open));
  answer.setAttribute('aria-hidden', String(open));
  textEl.textContent = open ? 'Show answer' : 'Hide answer';
}`;

// ── Inject CSS before </style> ────────────────────────────────────────────
h = h.replace('</style>', CSS.replace(/\n/g, NL) + NL + '</style>');
console.log('CSS injected');

// ── Inject section before pricing ────────────────────────────────────────
const PRICING = '<!-- ═══════ PRICING ═══════ -->';
const pi = h.indexOf(PRICING);
if (pi === -1) { console.error('PRICING marker not found'); process.exit(1); }
h = h.slice(0, pi) + SECTION.replace(/\n/g, NL) + h.slice(pi);
console.log('Section HTML inserted');

// ── Inject JS before last </script> ──────────────────────────────────────
const lastScript = h.lastIndexOf('</script>');
h = h.slice(0, lastScript) + JS.replace(/\n/g, NL) + NL + h.slice(lastScript);
console.log('JS injected');

// ── Verify ────────────────────────────────────────────────────────────────
const checks = [
  'See the question quality before you buy',
  'just like the 400 in the full bank',
  'stop_reason',
  'sq-correct',
  'sq-toggle',
  'sq-answer',
  'toggleSampleQ',
  'Agentic Architecture',
  'Claude Code Configuration',
  'Tool Design',
  'context: fork',
  'structured result describing the error',
];
let ok = true;
checks.forEach(str => {
  if (!h.includes(str)) { console.error('MISSING:', str); ok = false; }
  else console.log('  ✓', str.slice(0, 55));
});
if (!ok) process.exit(1);

fs.writeFileSync(INDEX, h, 'utf8');
console.log('\n✓ index.html saved');
