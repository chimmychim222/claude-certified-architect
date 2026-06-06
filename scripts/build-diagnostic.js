/**
 * Generates diagnostic/index.html — a no-login, 10-question readiness quiz.
 * Picks 2 questions randomly from each of the 5 CCA exam domains.
 * Run: node scripts/build-diagnostic.js
 */
const fs   = require('fs');
const path = require('path');

// ── 1. Extract QUESTIONS from index.html ─────────────────────────────────────
const html   = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const marker = 'const QUESTIONS = [';
const qStart = html.indexOf(marker) + marker.length - 1;

let depth = 0, inStr = false, strCh = '', esc = false, i = qStart;
while (i < html.length) {
  const c = html[i];
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
const arrStr = html.slice(qStart, i + 1);
const tmp    = path.join(__dirname, '_qtmp_diag.js');
fs.writeFileSync(tmp, 'module.exports = ' + arrStr + ';');
let ALL_Q;
try { ALL_Q = require(tmp); } finally { fs.unlinkSync(tmp); }

// Group by domain
const byDomain = {};
ALL_Q.forEach(q => { (byDomain[q.d] = byDomain[q.d] || []).push(q); });
console.log(`Loaded ${ALL_Q.length} questions across ${Object.keys(byDomain).length} domains.`);
Object.entries(byDomain).forEach(([d, qs]) => console.log(` ${qs.length.toString().padStart(3)}  ${d}`));

// ── 2. Domain metadata ────────────────────────────────────────────────────────
const DOMAINS = [
  { key: 'Agentic Architecture & Orchestration', label: 'Agentic Architecture & Orchestration', pct: 27 },
  { key: 'Claude Code Configuration',            label: 'Claude Code Configuration & Workflows', pct: 20 },
  { key: 'Prompt Engineering & Structured Output', label: 'Prompt Engineering & Structured Output', pct: 20 },
  { key: 'Tool Design & MCP Integration',        label: 'Tool Design & MCP Integration',         pct: 18 },
  { key: 'Context Management & Reliability',     label: 'Context Management & Reliability',      pct: 15 },
];

// Verify all domains found
DOMAINS.forEach(d => {
  if (!byDomain[d.key]) throw new Error(`Domain not found: "${d.key}". Check exact name.`);
});

// ── 3. Embed full question pool per domain (all questions, pick 2 at runtime) ─
const POOL = {};
DOMAINS.forEach(d => { POOL[d.key] = byDomain[d.key]; });

// ── 4. Read nav/CSS base from register sub-page ───────────────────────────────
const regHtml = fs.readFileSync(path.join(__dirname, '..', 'register', 'index.html'), 'utf8');

// Extract the GTM snippet from register page
const gtmStart = regHtml.indexOf('<!-- Google Tag Manager -->');
const gtmEnd   = regHtml.indexOf('<!-- End Google Tag Manager -->') + '<!-- End Google Tag Manager -->'.length;
const GTM      = regHtml.slice(gtmStart, gtmEnd);

// Extract nav HTML from register page
const navStart = regHtml.indexOf('<nav ');
const navEnd   = regHtml.indexOf('</nav>') + 6;
const NAV_HTML = regHtml.slice(navStart, navEnd)
  // Update active breadcrumb
  .replace(/aria-current="page"[^>]*>[^<]*<\/a>/g, m => m)
  // Make sure "diagnostic" link is active
  ;

// Extract footer HTML
const footStart = regHtml.indexOf('<footer');
const footEnd   = regHtml.indexOf('</footer>') + 9;
const FOOTER    = regHtml.slice(footStart, footEnd);

// ── 5. Build the page ─────────────────────────────────────────────────────────
const STRIPE_LINK = 'https://buy.stripe.com/cNi28k2GE7LngeRcc03ks00';

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${GTM}
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>CCA Readiness Diagnostic | Claude Certified Architect</title>
<meta name="description" content="Take a free 10-question CCA Foundations diagnostic quiz. Get a per-domain score, a readiness estimate against the 720/1,000 passing standard, and a personalised study tip — no account needed.">
<meta name="keywords" content="CCA diagnostic quiz, Claude Certified Architect readiness, CCA practice quiz free, CCA Foundations self-assessment">
<meta name="author" content="Claude Certified Architects">
<link rel="canonical" href="https://www.claudecertifiedarchitects.com/diagnostic/">
<meta property="og:type" content="website">
<meta property="og:title" content="CCA Readiness Diagnostic | Claude Certified Architect">
<meta property="og:description" content="Free 10-question diagnostic — see how ready you are for the CCA Foundations exam before you buy.">
<meta property="og:url" content="https://www.claudecertifiedarchitects.com/diagnostic/">
<meta property="og:image" content="https://www.claudecertifiedarchitects.com/og-image-v2.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="CCA Readiness Diagnostic | Claude Certified Architect">
<meta name="twitter:description" content="Free 10-question diagnostic — see how ready you are for the CCA Foundations exam.">
<meta name="twitter:image" content="https://www.claudecertifiedarchitects.com/og-image-v2.png">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"CCA Readiness Diagnostic","description":"Free 10-question CCA Foundations diagnostic quiz with per-domain scoring.","url":"https://www.claudecertifiedarchitects.com/diagnostic/","isPartOf":{"@type":"WebSite","url":"https://www.claudecertifiedarchitects.com"}}</script>
<style>
:root{
  --bg:#f5f3ea;--surface:#fff;--surface2:#f0ede4;--surface3:#e8e5dc;
  --border:#d9d5ca;--border2:#c5c0b5;
  --text:#191918;--text2:#5a5a52;--text3:#8a8a7f;
  --accent:#d97757;--accent2:#c4623f;--accent3:#a8502f;
  --green:#2d7a5f;--green2:#1a4d3a;--red:#c44b3f;
  --radius:8px;--radius-sm:6px;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:Georgia,'Times New Roman',serif;background:var(--bg);color:var(--text);line-height:1.7;overflow-x:hidden;min-height:100vh}
a{color:var(--accent);text-decoration:underline;text-underline-offset:3px;transition:color .2s}
a:hover{color:var(--accent2)}
.container{max-width:860px;margin:0 auto;padding:0 20px}

/* ── NAV ── */
nav{position:sticky;top:0;z-index:100;background:var(--surface);border-bottom:1px solid var(--border);padding:0 20px}
nav .nav-inner{max-width:1100px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;height:56px}
nav .logo{font-size:1rem;font-weight:700;color:var(--text);text-decoration:none;letter-spacing:-.3px}
nav .nav-links{display:flex;align-items:center;gap:6px}
nav .nav-links a{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.8rem;color:var(--text2);text-decoration:none;padding:5px 10px;border-radius:var(--radius-sm);transition:all .2s}
nav .nav-links a:hover{color:var(--text);background:var(--surface2)}
nav .nav-links a.active{color:var(--text);font-weight:600}
nav .nav-cta{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.8rem;font-weight:600;color:#fff;background:var(--accent);border:none;padding:7px 16px;border-radius:var(--radius-sm);cursor:pointer;text-decoration:none;transition:background .2s}
nav .nav-cta:hover{background:var(--accent2);color:#fff}
@media(max-width:600px){nav .nav-links{display:none}nav .logo{font-size:.95rem}}

/* ── BREADCRUMB ── */
.breadcrumb{padding:12px 0;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.78rem;color:var(--text3)}
.breadcrumb a{color:var(--text3);text-decoration:none}
.breadcrumb a:hover{color:var(--accent)}
.breadcrumb span{margin:0 6px}

/* ── SHARED SECTION LAYOUT ── */
.diag-section{display:none;padding:48px 0 80px}
.diag-section.active{display:block}

/* ── INTRO ── */
.intro-hero{text-align:center;max-width:600px;margin:0 auto 48px;padding-top:16px}
.intro-hero .eyebrow{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.72rem;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--accent);margin-bottom:14px}
.intro-hero h1{font-size:clamp(1.8rem,5vw,2.6rem);font-weight:700;line-height:1.2;color:var(--text);margin-bottom:16px}
.intro-hero p{font-size:1.05rem;color:var(--text2);line-height:1.7;margin-bottom:32px}
.intro-meta{display:flex;justify-content:center;gap:28px;flex-wrap:wrap;margin-bottom:36px}
.intro-meta-item{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.83rem;color:var(--text3);display:flex;align-items:center;gap:6px}
.intro-meta-item svg{color:var(--accent)}
.btn-primary{display:inline-block;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.95rem;font-weight:700;color:#fff;background:var(--accent);border:none;padding:14px 32px;border-radius:var(--radius);cursor:pointer;text-decoration:none;transition:background .2s,transform .15s;letter-spacing:.1px}
.btn-primary:hover{background:var(--accent2);color:#fff;transform:translateY(-1px)}
.btn-secondary{display:inline-block;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.88rem;font-weight:600;color:var(--accent);background:transparent;border:1.5px solid var(--accent);padding:11px 24px;border-radius:var(--radius);cursor:pointer;text-decoration:none;transition:all .2s}
.btn-secondary:hover{background:rgba(217,119,87,.08);color:var(--accent2)}
.intro-note{margin-top:18px;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.78rem;color:var(--text3)}
.domain-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;max-width:700px;margin:0 auto}
.domain-pill{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;text-align:center}
.domain-pill .dp-name{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.78rem;font-weight:600;color:var(--text2);line-height:1.35;margin-bottom:4px}
.domain-pill .dp-pct{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.72rem;color:var(--text3)}

/* ── QUIZ ── */
.quiz-header{margin-bottom:28px}
.quiz-progress-label{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.8rem;color:var(--text3);margin-bottom:8px;display:flex;justify-content:space-between}
.quiz-bar-track{height:4px;background:var(--surface3);border-radius:2px;overflow:hidden}
.quiz-bar-fill{height:100%;background:var(--accent);border-radius:2px;transition:width .4s ease}
.q-domain-tag{display:inline-block;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.68rem;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--accent);background:rgba(217,119,87,.08);border:1px solid rgba(217,119,87,.18);border-radius:20px;padding:4px 12px;margin-bottom:16px}
.q-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;margin-bottom:20px}
.q-text{font-size:1rem;line-height:1.75;color:var(--text);margin-bottom:24px}
.q-options{display:flex;flex-direction:column;gap:10px}
.q-opt{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.9rem;color:var(--text2);background:var(--bg);border:1.5px solid var(--border);border-radius:var(--radius-sm);padding:12px 16px;cursor:pointer;text-align:left;transition:all .2s;display:flex;gap:12px;align-items:flex-start;line-height:1.5}
.q-opt:hover{border-color:var(--accent);background:rgba(217,119,87,.04);color:var(--text)}
.q-opt.selected{border-color:var(--accent);background:rgba(217,119,87,.08);color:var(--text);font-weight:600}
.q-opt .opt-letter{font-weight:700;color:var(--text3);flex-shrink:0;min-width:20px}
.q-opt.selected .opt-letter{color:var(--accent)}
.q-opt:disabled,.q-opt[disabled]{pointer-events:none}
.quiz-nav{display:flex;justify-content:flex-end;margin-top:8px}
.btn-next{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.9rem;font-weight:700;color:#fff;background:var(--accent);border:none;padding:12px 28px;border-radius:var(--radius-sm);cursor:pointer;transition:background .2s;display:none}
.btn-next.visible{display:block}
.btn-next:hover{background:var(--accent2)}
@media(max-width:600px){.q-card{padding:20px 16px}}

/* ── RESULTS ── */
.results-header{text-align:center;margin-bottom:40px}
.results-header h2{font-size:clamp(1.5rem,4vw,2.2rem);font-weight:700;color:var(--text);margin-bottom:10px}
.results-header p{font-size:.95rem;color:var(--text2);max-width:520px;margin:0 auto}
.results-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px}
@media(max-width:680px){.results-grid{grid-template-columns:1fr}}

/* Domain bars panel */
.panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:28px}
.panel-title{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.72rem;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--text3);margin-bottom:20px}
.domain-bar-row{margin-bottom:18px}
.domain-bar-row:last-child{margin-bottom:0}
.domain-bar-label{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.8rem;color:var(--text2);margin-bottom:5px;display:flex;justify-content:space-between;align-items:baseline}
.domain-bar-label span{font-weight:700;color:var(--text)}
.domain-bar-label .score-val{font-size:.9rem;font-weight:700}
.bar-track{height:8px;background:var(--surface3);border-radius:4px;overflow:hidden}
.bar-fill{height:100%;border-radius:4px;transition:width .8s cubic-bezier(.4,0,.2,1)}
.bar-fill.high{background:var(--green)}
.bar-fill.mid{background:#d4a843}
.bar-fill.low{background:var(--red)}
.bar-exam-weight{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.68rem;color:var(--text3);margin-top:3px}

/* Overall estimate panel */
.estimate-panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:28px;display:flex;flex-direction:column}
.estimate-score{font-size:3.2rem;font-weight:700;line-height:1;margin:16px 0 4px;font-family:-apple-system,system-ui,'Segoe UI',sans-serif}
.estimate-score.pass{color:var(--green)}
.estimate-score.close{color:#d4a843}
.estimate-score.fail{color:var(--red)}
.estimate-label{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.8rem;color:var(--text2);margin-bottom:4px}
.passing-line{display:flex;align-items:center;gap:8px;margin:16px 0;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.8rem;color:var(--text3)}
.passing-line .marker{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--text3);flex-shrink:0}
.estimate-track{height:10px;background:var(--surface3);border-radius:5px;position:relative;margin:8px 0 16px}
.estimate-fill{height:100%;border-radius:5px;transition:width 1s cubic-bezier(.4,0,.2,1)}
.estimate-fill.pass{background:var(--green)}
.estimate-fill.close{background:#d4a843}
.estimate-fill.fail{background:var(--red)}
.passing-marker{position:absolute;top:-3px;height:16px;width:2px;background:var(--text3);border-radius:1px}
.passing-marker::after{content:'720';position:absolute;top:18px;left:50%;transform:translateX(-50%);font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.62rem;color:var(--text3);white-space:nowrap}
.estimate-disclaimer{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.72rem;color:var(--text3);line-height:1.55;margin-top:auto;padding-top:16px;border-top:1px solid var(--border)}

/* Weakest domain callout */
.weak-callout{background:rgba(217,119,87,.06);border:1.5px solid rgba(217,119,87,.25);border-radius:12px;padding:24px 28px;margin-bottom:24px;display:flex;gap:16px;align-items:flex-start}
.weak-callout-icon{font-size:1.4rem;flex-shrink:0;margin-top:2px}
.weak-callout-body h3{font-size:1rem;font-weight:700;color:var(--text);margin-bottom:6px;font-family:-apple-system,system-ui,'Segoe UI',sans-serif}
.weak-callout-body p{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.88rem;color:var(--text2);line-height:1.6}
.weak-callout-body strong{color:var(--accent);font-weight:700}

/* CTA card */
.cta-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:36px;text-align:center}
.cta-card h3{font-size:clamp(1.15rem,3vw,1.5rem);font-weight:700;color:var(--text);margin-bottom:10px}
.cta-card p{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.92rem;color:var(--text2);max-width:480px;margin:0 auto 24px;line-height:1.65}
.cta-features{display:flex;justify-content:center;gap:20px;flex-wrap:wrap;margin-bottom:28px}
.cta-feat{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.78rem;color:var(--text3);display:flex;align-items:center;gap:5px}
.cta-feat::before{content:'✓';color:var(--green);font-weight:700}
.cta-retake{margin-top:14px;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.82rem}
.cta-retake a{color:var(--text3)}

/* ── FOOTER ── */
footer{border-top:1px solid var(--border);padding:28px 20px;text-align:center;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.78rem;color:var(--text3)}
footer a{color:var(--text3);text-decoration:underline}

/* ── ANIMATION ── */
@keyframes fadeInUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
.animate-in{animation:fadeInUp .4s ease forwards}
</style>
</head>
<body>
<!-- GTM noscript -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GT-K8FC4RXW" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>

<!-- NAV -->
<nav>
  <div class="nav-inner">
    <a href="/" class="logo">Claude Certified Architect</a>
    <div class="nav-links">
      <a href="/">Home</a>
      <a href="/diagnostic/" class="active" aria-current="page">Diagnostic</a>
      <a href="/blog/">Blog</a>
      <a href="/register/">Register</a>
    </div>
    <a href="${STRIPE_LINK}" class="nav-cta">Get Access — $49</a>
  </div>
</nav>

<main class="container">

  <!-- ══ INTRO ══════════════════════════════════════════════════════════ -->
  <section id="intro-screen" class="diag-section active">
    <nav class="breadcrumb" aria-label="Breadcrumb">
      <a href="/">Home</a><span aria-hidden="true">›</span>
      <span aria-current="page">Diagnostic Quiz</span>
    </nav>

    <div class="intro-hero">
      <div class="eyebrow">Free · No account needed</div>
      <h1>CCA Foundations<br>Readiness Diagnostic</h1>
      <p>Answer 10 scenario-based questions — 2 from each exam domain — and see exactly where you stand before the real test.</p>

      <div class="intro-meta">
        <span class="intro-meta-item">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          ~5 minutes
        </span>
        <span class="intro-meta-item">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          10 questions
        </span>
        <span class="intro-meta-item">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
          5 domains covered
        </span>
      </div>

      <button class="btn-primary" onclick="startDiagnostic()">Start Diagnostic →</button>
      <p class="intro-note">Questions are drawn randomly from a bank of 400+ real-format items.</p>
    </div>

    <div class="domain-grid" aria-label="Exam domains covered">
      <div class="domain-pill"><div class="dp-name">Agentic Architecture &amp; Orchestration</div><div class="dp-pct">27% of exam</div></div>
      <div class="domain-pill"><div class="dp-name">Claude Code Configuration &amp; Workflows</div><div class="dp-pct">20% of exam</div></div>
      <div class="domain-pill"><div class="dp-name">Prompt Engineering &amp; Structured Output</div><div class="dp-pct">20% of exam</div></div>
      <div class="domain-pill"><div class="dp-name">Tool Design &amp; MCP Integration</div><div class="dp-pct">18% of exam</div></div>
      <div class="domain-pill"><div class="dp-name">Context Management &amp; Reliability</div><div class="dp-pct">15% of exam</div></div>
    </div>
  </section>

  <!-- ══ QUIZ ══════════════════════════════════════════════════════════ -->
  <section id="quiz-screen" class="diag-section">
    <div class="quiz-header">
      <div class="quiz-progress-label">
        <span id="q-label">Question 1 of 10</span>
        <span id="q-domain-label" style="color:var(--accent)"></span>
      </div>
      <div class="quiz-bar-track"><div class="quiz-bar-fill" id="quiz-bar" style="width:10%"></div></div>
    </div>

    <div id="q-domain-tag-wrap"></div>
    <div id="question-area"></div>

    <div class="quiz-nav">
      <button class="btn-next" id="btn-next" onclick="nextQuestion()">Next →</button>
    </div>
  </section>

  <!-- ══ RESULTS ════════════════════════════════════════════════════════ -->
  <section id="results-screen" class="diag-section">
    <div class="results-header animate-in">
      <h2 id="results-headline">Your Diagnostic Results</h2>
      <p>Based on 10 questions across all 5 CCA Foundations domains. Scores reflect your performance on this sample — not a full exam simulation.</p>
    </div>

    <div id="weak-callout" class="weak-callout animate-in" style="animation-delay:.1s"></div>

    <div class="results-grid animate-in" style="animation-delay:.2s">
      <div class="panel">
        <div class="panel-title">Domain Breakdown</div>
        <div id="domain-bars"></div>
      </div>
      <div class="estimate-panel panel">
        <div class="panel-title">Readiness Estimate</div>
        <div class="estimate-label">Estimated score (informal)</div>
        <div class="estimate-score" id="est-score"></div>
        <div style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.78rem;color:var(--text3);margin-bottom:8px">out of 1,000</div>
        <div class="estimate-track">
          <div class="estimate-fill" id="est-bar" style="width:0%"></div>
          <div class="passing-marker" style="left:72%"></div>
        </div>
        <div class="passing-line"><span class="marker"></span> 720 passing standard</div>
        <div class="estimate-disclaimer">
          <strong>Informal estimate only.</strong> This is not an official score. It applies your domain accuracy to the real exam weightings (Agentic 27%, Claude Code 20%, Prompting 20%, Tools 18%, Context 15%) and scales to 1,000. The actual CCA exam contains 60 questions with a broader range of difficulty.
        </div>
      </div>
    </div>

    <div class="cta-card animate-in" style="animation-delay:.3s">
      <h3>Close the gap with the full 400-question bank — $49</h3>
      <p>All 400 scenario-based questions across every domain, four timed exam modes, domain-weighted scoring, and every answer fully explained.</p>
      <div class="cta-features">
        <span class="cta-feat">400 exam-format questions</span>
        <span class="cta-feat">All 5 domains at real weightings</span>
        <span class="cta-feat">4 timed practice modes</span>
        <span class="cta-feat">Lifetime access</span>
        <span class="cta-feat">10-day money-back guarantee</span>
      </div>
      <a href="${STRIPE_LINK}" class="btn-primary">Unlock full access — $49</a>
      <p class="cta-retake"><a href="#" onclick="retakeDiagnostic();return false;">Retake with new questions</a></p>
    </div>
  </section>

</main>

<footer>
  <p>&copy; ${new Date().getFullYear()} Claude Certified Architects &mdash; Independent study resource &mdash; Not affiliated with Anthropic &middot; <a href="/">Home</a></p>
</footer>

<script>
// ── Embedded question pool (generated at build time) ─────────────────────────
const POOL = ${JSON.stringify(POOL)};

const DOMAINS = [
  { key: 'Agentic Architecture & Orchestration',  label: 'Agentic Architecture & Orchestration',  pct: 27 },
  { key: 'Claude Code Configuration',             label: 'Claude Code Configuration & Workflows', pct: 20 },
  { key: 'Prompt Engineering & Structured Output',label: 'Prompt Engineering & Structured Output', pct: 20 },
  { key: 'Tool Design & MCP Integration',         label: 'Tool Design & MCP Integration',          pct: 18 },
  { key: 'Context Management & Reliability',      label: 'Context Management & Reliability',       pct: 15 },
];

const STRIPE_LINK = '${STRIPE_LINK}';

// ── State ─────────────────────────────────────────────────────────────────────
let quiz = [];        // 10 selected questions (shuffled options)
let answers = [];     // user's selected answer index per question
let current = 0;

// ── Shuffle ───────────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Pick 2 per domain and shuffle options ────────────────────────────────────
function buildQuiz() {
  quiz = [];
  DOMAINS.forEach(d => {
    const pool = shuffle(POOL[d.key]);
    pool.slice(0, 2).forEach(q => {
      // Shuffle options while preserving correct answer
      const indices = q.o.map((_, i) => i);
      const si = shuffle(indices);
      quiz.push({
        domain: d.label,
        domainKey: d.key,
        q: q.q,
        o: si.map(i => q.o[i]),
        a: si.indexOf(q.a),
        e: q.e,
      });
    });
  });
  quiz = shuffle(quiz); // mix domains so not all domain-1 then domain-2 etc
  answers = new Array(quiz.length).fill(-1);
  current = 0;
}

// ── Show/hide screens ─────────────────────────────────────────────────────────
function showScreen(id) {
  ['intro-screen','quiz-screen','results-screen'].forEach(s => {
    document.getElementById(s).classList.toggle('active', s === id);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Start ─────────────────────────────────────────────────────────────────────
function startDiagnostic() {
  buildQuiz();
  showScreen('quiz-screen');
  renderQuestion();
}

// ── Render current question ───────────────────────────────────────────────────
function renderQuestion() {
  const q = quiz[current];
  const total = quiz.length;
  const pct   = ((current + 1) / total) * 100;
  const LABELS = ['A','B','C','D','E'];

  document.getElementById('q-label').textContent        = 'Question ' + (current + 1) + ' of ' + total;
  document.getElementById('q-domain-label').textContent = q.domain;
  document.getElementById('quiz-bar').style.width       = pct + '%';

  document.getElementById('q-domain-tag-wrap').innerHTML =
    '<span class="q-domain-tag">' + q.domain + '</span>';

  const optHtml = q.o.map((opt, oi) => {
    const sel = answers[current] === oi ? ' selected' : '';
    return '<button class="q-opt' + sel + '" onclick="selectAnswer(' + oi + ')" aria-pressed="' + (answers[current]===oi) + '">' +
      '<span class="opt-letter">' + LABELS[oi] + '.</span> ' + opt +
    '</button>';
  }).join('');

  document.getElementById('question-area').innerHTML =
    '<div class="q-card"><p class="q-text">' + q.q + '</p><div class="q-options">' + optHtml + '</div></div>';

  const btn = document.getElementById('btn-next');
  btn.classList.toggle('visible', answers[current] !== -1);
  btn.textContent = current === total - 1 ? 'See results →' : 'Next →';
}

// ── Select answer ─────────────────────────────────────────────────────────────
function selectAnswer(idx) {
  answers[current] = idx;
  renderQuestion();
}

// ── Next question ─────────────────────────────────────────────────────────────
function nextQuestion() {
  if (answers[current] === -1) return;
  if (current < quiz.length - 1) {
    current++;
    renderQuestion();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    showResults();
  }
}

// ── Results ───────────────────────────────────────────────────────────────────
function showResults() {
  showScreen('results-screen');

  // Per-domain correct counts (each domain has 2 questions)
  const domScore = {};
  DOMAINS.forEach(d => { domScore[d.key] = { correct: 0, total: 0 }; });

  quiz.forEach((q, i) => {
    domScore[q.domainKey].total++;
    if (answers[i] === q.a) domScore[q.domainKey].correct++;
  });

  // Domain bars
  const barsHtml = DOMAINS.map(d => {
    const s    = domScore[d.key];
    const pct  = s.total > 0 ? Math.round((s.correct / s.total) * 100) : 0;
    const cls  = pct >= 50 ? 'high' : pct > 0 ? 'mid' : 'low';
    return '<div class="domain-bar-row">' +
      '<div class="domain-bar-label"><span>' + d.label + '</span><span class="score-val">' + s.correct + '/' + s.total + '</span></div>' +
      '<div class="bar-track"><div class="bar-fill ' + cls + '" style="width:' + pct + '%"></div></div>' +
      '<div class="bar-exam-weight">Exam weight: ' + d.pct + '%</div>' +
    '</div>';
  }).join('');
  document.getElementById('domain-bars').innerHTML = barsHtml;

  // Weighted overall estimate (scales to 1,000)
  let weightedPct = 0;
  DOMAINS.forEach(d => {
    const s = domScore[d.key];
    const domPct = s.total > 0 ? (s.correct / s.total) : 0;
    weightedPct += domPct * (d.pct / 100);
  });
  const estimatedScore = Math.round(weightedPct * 1000);
  const passScore = 720;
  const scorePct  = Math.min(100, (estimatedScore / 1000) * 100);
  const passCls   = estimatedScore >= passScore ? 'pass' : estimatedScore >= passScore * 0.85 ? 'close' : 'fail';

  document.getElementById('est-score').textContent      = estimatedScore;
  document.getElementById('est-score').className        = 'estimate-score ' + passCls;
  document.getElementById('est-bar').style.width        = scorePct + '%';
  document.getElementById('est-bar').className          = 'estimate-fill ' + passCls;

  // Headline
  let headline;
  if (estimatedScore >= passScore)       headline = 'Strong result — you look ready!';
  else if (estimatedScore >= passScore * 0.85) headline = 'Close — a bit more practice and you\'ll be there';
  else                                   headline = 'Good start — let\'s fill those gaps';
  document.getElementById('results-headline').textContent = headline;

  // Weakest domain
  let weakest = DOMAINS[0];
  DOMAINS.forEach(d => {
    const s = domScore[d.key];
    const p = s.total > 0 ? s.correct / s.total : 0;
    const ws = domScore[weakest.key];
    const wp = ws.total > 0 ? ws.correct / ws.total : 0;
    if (p < wp) weakest = d;
  });
  const ws = domScore[weakest.key];
  const wpct = ws.total > 0 ? Math.round((ws.correct / ws.total) * 100) : 0;

  document.getElementById('weak-callout').innerHTML =
    '<div class="weak-callout-icon">🎯</div>' +
    '<div class="weak-callout-body">' +
    '<h3>Your weakest area: ' + weakest.label + '</h3>' +
    '<p>You scored <strong>' + ws.correct + ' out of ' + ws.total + ' (' + wpct + '%)</strong> here. ' +
    'This domain accounts for <strong>' + weakest.pct + '% of the real exam</strong> — ' +
    'strengthening it will have the biggest impact on your final score.</p>' +
    '</div>';

  // Animate bars in after a short delay
  setTimeout(() => {
    document.querySelectorAll('.bar-fill, .estimate-fill').forEach(el => {
      const w = el.style.width;
      el.style.width = '0%';
      setTimeout(() => { el.style.width = w; }, 50);
    });
  }, 100);
}

// ── Retake ────────────────────────────────────────────────────────────────────
function retakeDiagnostic() {
  buildQuiz();
  showScreen('quiz-screen');
  renderQuestion();
}
</script>
</body>
</html>`;

// ── 6. Write output ───────────────────────────────────────────────────────────
const outDir = path.join(__dirname, '..', 'diagnostic');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
fs.writeFileSync(path.join(outDir, 'index.html'), page, 'utf8');
console.log('\n✓ diagnostic/index.html written');
console.log('  Preview: open diagnostic/index.html in a browser');
