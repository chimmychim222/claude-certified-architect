/**
 * Patches index.html to make the first 5 questions of "Focused Session"
 * playable without login, with inline answer/explanation reveal, and a
 * paywall after question 5.
 *
 * Run: node scripts/_free-focused.js
 */
const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'index.html');
let h = fs.readFileSync(INDEX, 'utf8');
const NL = h.includes('\r\n') ? '\r\n' : '\n';

// ── Helper: replace an entire named function ────────────────────────────────
function replaceFn(src, name, newBody) {
  const start = src.indexOf('function ' + name);
  if (start === -1) throw new Error('Function not found: ' + name);
  let depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return src.slice(0, start) + newBody + src.slice(i + 1);
}

// ── 1. CSS additions ────────────────────────────────────────────────────────
const NEW_CSS = [
  '/* ── Free focused preview ── */',
  '.option:disabled{pointer-events:none;cursor:default}',
  '.q-explanation{margin-top:20px;padding:18px 20px;border-radius:var(--radius-sm);background:var(--surface2);border:1px solid var(--border);animation:fadeInUp .3s ease}',
  '.q-explanation-label{font-family:-apple-system,system-ui,\'Segoe UI\',sans-serif;font-size:.72rem;font-weight:700;letter-spacing:.5px;text-transform:uppercase;margin-bottom:8px}',
  '.q-explanation-label.correct{color:var(--green)}.q-explanation-label.incorrect{color:var(--red)}',
  '.q-explanation-text{font-size:.9rem;line-height:1.78;color:var(--text2);font-family:-apple-system,system-ui,\'Segoe UI\',sans-serif;margin:0}',
  '.q-paywall{text-align:center;padding:56px 28px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);max-width:520px;margin:0 auto}',
  '.q-paywall-icon{font-size:2.4rem;margin-bottom:16px}',
  '.q-paywall h2{font-size:clamp(1.25rem,3vw,1.7rem);color:var(--text);margin-bottom:14px;font-weight:700}',
  '.q-paywall p{color:var(--text2);font-size:.95rem;line-height:1.65;margin:0 auto 28px;max-width:400px}',
  '.q-paywall .btn-primary{display:inline-block;text-decoration:none}',
  '.q-paywall-sub{margin-top:14px;font-size:.82rem;color:var(--text3);font-family:-apple-system,system-ui,\'Segoe UI\',sans-serif}',
].join('\n');

if (!h.includes('q-paywall')) {
  h = h.replace('</style>', NEW_CSS.replace(/\n/g, NL) + NL + '</style>');
  console.log('✓ CSS added');
} else {
  console.log('! CSS already present');
}

// ── 2. startTest — allow focused without login, cap at 5 for free ───────────
const NEW_START_TEST = `function startTest(type) {
  // quick: always free. focused: first 5 free. deep/full: need enrollment.
  if (type !== 'quick' && type !== 'focused' && !enrolled) {
    openAuthModal();
    return;
  }

  const config = getTestConfig(type);
  const isFreePreview = (type === 'focused' && !enrolled);
  const questionCount = isFreePreview ? 5 : config.questions;

  const shuffled = shuffleArray(QUESTIONS);
  const selected = shuffled.slice(0, questionCount).map(q => {
    const indices = q.o.map((_, i) => i);
    const shuffledIdx = shuffleArray(indices);
    return { d:q.d, q:q.q, o:shuffledIdx.map(i => q.o[i]), a:shuffledIdx.indexOf(q.a), e:q.e };
  });

  currentTest = {
    type,
    config: Object.assign({}, config, { questions: questionCount }),
    questions: selected,
    answers: new Array(questionCount).fill(-1),
    current: 0,
    timeLeft: config.minutes * 60,
    finished: false,
    freePreview: isFreePreview,
  };

  showSection('test');
  renderQuestion();
  renderDots();

  if (isFreePreview) {
    document.getElementById('test-timer').style.visibility = 'hidden';
  } else {
    document.getElementById('test-timer').style.visibility = 'visible';
    startTimer();
  }
}`;

h = replaceFn(h, 'startTest', NEW_START_TEST);
console.log('✓ startTest replaced');

// ── 3. renderQuestion — inline answer reveal for freePreview ─────────────────
const NEW_RENDER_Q = `function renderQuestion() {
  const t = currentTest;
  const q = t.questions[t.current];
  const total = t.config.questions;
  const answered = t.answers[t.current] !== -1;

  document.getElementById('test-progress').textContent = \`Question \${t.current+1} of \${total}\`;
  document.getElementById('test-progress-bar').style.width = \`\${((t.current+1)/total)*100}%\`;

  let html = \`<div class="question-card">
    <div class="q-num">\${q.d} — Question \${t.current+1}</div>
    <div class="q-text">\${q.q}</div>\`;

  if (t.freePreview && answered) {
    // Show correct/incorrect state — options locked
    q.o.forEach((opt, i) => {
      let cls = '';
      if (i === q.a) cls = ' correct';
      else if (i === t.answers[t.current]) cls = ' incorrect';
      html += \`<button class="option\${cls}" disabled>\${String.fromCharCode(65+i)}. \${opt}</button>\`;
    });
    const isCorrect = t.answers[t.current] === q.a;
    html += \`<div class="q-explanation">
      <div class="q-explanation-label \${isCorrect ? 'correct' : 'incorrect'}">\${isCorrect ? '✓ Correct!' : '✗ Incorrect'}</div>
      <p class="q-explanation-text">\${q.e}</p>
    </div>\`;
  } else {
    q.o.forEach((opt, i) => {
      const sel = t.answers[t.current] === i ? ' selected' : '';
      html += \`<button class="option\${sel}" onclick="selectAnswer(\${i})">\${String.fromCharCode(65+i)}. \${opt}</button>\`;
    });
  }

  html += \`</div>\`;
  document.getElementById('question-area').innerHTML = html;

  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');

  if (t.freePreview) {
    prevBtn.style.visibility = 'hidden';
    if (answered) {
      nextBtn.style.visibility = 'visible';
      const isLast = t.current === total - 1;
      nextBtn.textContent = isLast ? 'See full access →' : 'Next question →';
    } else {
      nextBtn.style.visibility = 'hidden';
    }
  } else {
    prevBtn.style.visibility = t.current === 0 ? 'hidden' : 'visible';
    nextBtn.style.visibility = 'visible';
    nextBtn.textContent = t.current === total - 1 ? 'Finish Test' : 'Next →';
  }
}`;

h = replaceFn(h, 'renderQuestion', NEW_RENDER_Q);
console.log('✓ renderQuestion replaced');

// ── 4. nextQuestion — paywall after Q5 in freePreview ───────────────────────
const NEW_NEXT_Q = `function nextQuestion() {
  const t = currentTest;
  // In free preview, last question leads to paywall
  if (t.freePreview && t.current === t.config.questions - 1) {
    showFocusedPaywall();
    return;
  }
  if (t.current < t.config.questions - 1) {
    t.current++;
    renderQuestion();
    renderDots();
  } else {
    finishTest();
  }
}`;

h = replaceFn(h, 'nextQuestion', NEW_NEXT_Q);
console.log('✓ nextQuestion replaced');

// ── 5. exitTest — go home (not dashboard) when no session ───────────────────
const OLD_EXIT = `function exitTest() {
  clearInterval(timerInterval);
  if (currentTest && !currentTest.finished) {
    if (!confirm('Are you sure you want to exit? Your progress will be lost.')) return;
  }
  currentTest = null;
  showSection('dashboard');
}`;
const NEW_EXIT = `function exitTest() {
  clearInterval(timerInterval);
  if (currentTest && !currentTest.finished && !currentTest.freePreview) {
    if (!confirm('Are you sure you want to exit? Your progress will be lost.')) return;
  }
  const wasFreePreview = currentTest && currentTest.freePreview;
  currentTest = null;
  document.getElementById('test-timer').style.visibility = 'visible';
  if (wasFreePreview) {
    showSection('home');
  } else {
    showSection('dashboard');
  }
}`;
if (h.includes(OLD_EXIT.slice(0, 60).replace(/\n/g, '\r\n')) || h.includes(OLD_EXIT.slice(0, 60))) {
  h = replaceFn(h, 'exitTest', NEW_EXIT);
  console.log('✓ exitTest updated');
} else {
  console.warn('! exitTest anchor not found — skipping');
}

// ── 6. New showFocusedPaywall function ──────────────────────────────────────
const PAYWALL_FN = `
function showFocusedPaywall() {
  clearInterval(timerInterval);
  document.getElementById('question-area').innerHTML = \`
    <div class="q-paywall">
      <div class="q-paywall-icon">🔓</div>
      <h2>You've seen the first 5 — unlock all 400 questions and timed exams for $49</h2>
      <p>All 400 scenario-based questions across five CCA domains, four timed exam modes, and every answer fully explained.</p>
      <button class="btn-primary" onclick="openPaymentModal()">Unlock full access — $49</button>
      <div class="q-paywall-sub">One-time payment · Lifetime access · 10-day money-back guarantee</div>
    </div>\`;
  document.getElementById('question-dots').innerHTML = '';
  document.getElementById('test-progress').textContent = '';
  document.getElementById('test-progress-bar').style.width = '100%';
  document.getElementById('prev-btn').style.visibility = 'hidden';
  document.getElementById('next-btn').style.visibility = 'hidden';
  document.getElementById('test-timer').style.visibility = 'hidden';
}`;

if (!h.includes('function showFocusedPaywall')) {
  const lastScript = h.lastIndexOf('</script>');
  h = h.slice(0, lastScript) + PAYWALL_FN.replace(/\n/g, NL) + NL + h.slice(lastScript);
  console.log('✓ showFocusedPaywall added');
}

// ── 7. Verify ────────────────────────────────────────────────────────────────
const checks = [
  ['q-paywall', true],
  ['q-explanation', true],
  ['freePreview', true],
  ["type !== 'focused'", true],          // focused allowed without login
  ['showFocusedPaywall', true],
  ['isFreePreview ? 5 : config.questions', true],
  ['q-explanation-label', true],
  ['See full access', true],
];
let ok = true;
checks.forEach(([s, want]) => {
  const found = h.includes(s);
  if (found !== want) { console.error('FAIL: ' + s); ok = false; }
  else console.log('  ✓ ' + (want ? 'present' : 'absent') + ': ' + s);
});
if (!ok) process.exit(1);

fs.writeFileSync(INDEX, h, 'utf8');
console.log('\n✓ index.html saved');
