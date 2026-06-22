/**
 * build.js — Pre-render static JSON-LD into all HTML pages + generate blog.
 *
 * 1. Reads schema.json and inlines structured data as static <script> tags so
 *    Googlebot sees them without executing JavaScript.
 * 2. Reads posts/*.json and generates blog/<slug>/index.html + blog/index.html.
 * 3. Writes sitemap.xml with all routes including blog posts.
 *
 * Run:  node build.js
 *
 * Idempotent — safe to run multiple times.
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BASE        = 'https://www.claudecertifiedarchitects.com';
const SCHEMA_FILE = path.join(__dirname, 'schema.json');
const POSTS_DIR   = path.join(__dirname, 'posts');
const BLOG_DIR    = path.join(__dirname, 'blog');

const START_MARKER = '<!-- cca:schema:start -->';
const END_MARKER   = '<!-- cca:schema:end -->';
const FIRST_RUN_RE = /<!-- Structured Data[\s\S]*?<\/script>/;
const REBUILD_RE   = /<!-- cca:schema:start -->[\s\S]*?<!-- cca:schema:end -->/;

// ---------------------------------------------------------------------------
// Read schema.json
// ---------------------------------------------------------------------------
const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));

// ---------------------------------------------------------------------------
// Build JSON-LD objects
// ---------------------------------------------------------------------------

/** Course (for homepage) */
const courseSchema = {
  '@context': 'https://schema.org',
  '@type': 'Course',
  name: schema.course.name,
  description: schema.course.description,
  url: schema.course.url,
  provider: {
    '@type': 'Organization',
    name: schema.course.provider,
    url: BASE
  },
  offers: {
    '@type': 'Offer',
    price: schema.course.price,
    priceCurrency: schema.course.priceCurrency,
    availability: 'https://schema.org/InStock',
    url: BASE
  },
  teaches: schema.course.teaches,
  timeRequired: schema.course.timeRequired,
  courseMode: schema.course.courseMode,
  inLanguage: schema.course.inLanguage
};

/** Organization (for homepage) — identifies the publisher/business entity */
const organizationSchema = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: schema.course.provider,
  url: BASE,
  logo: BASE + '/apple-touch-icon.png'
};

/** WebSite (for homepage) — identifies the site itself.
 *  No SearchAction: the site has no on-site search feature, and a
 *  SearchAction pointing at a non-existent endpoint would be structured
 *  data that doesn't match real site functionality. */
const websiteSchema = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: schema.course.provider,
  url: BASE,
  inLanguage: schema.course.inLanguage,
  publisher: { '@type': 'Organization', name: schema.course.provider, url: BASE }
};

/** FAQPage (for homepage) */
const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: schema.faq.map(item => ({
    '@type': 'Question',
    name: item.q,
    acceptedAnswer: { '@type': 'Answer', text: item.a }
  }))
};

/** BreadcrumbList helper */
function breadcrumb(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url
    }))
  };
}

/** Schemas for /cca-foundations-exam */
const examSchemas = [
  {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: 'CCA Foundations Exam Practice Test',
    description: 'Full-length CCA Foundations practice test — 60 timed, domain-weighted questions across all 5 exam domains, with explanations and a scored breakdown.',
    url: BASE + '/cca-foundations-exam/',
    isPartOf: { '@type': 'WebSite', name: schema.course.provider, url: BASE }
  },
  breadcrumb([
    { name: 'Home',                  url: BASE },
    { name: 'CCA Foundations Exam',  url: BASE + '/cca-foundations-exam' }
  ])
];

/** Schemas for /cca-practice-questions */
const questionsSchemas = [
  {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: 'Free CCA Practice Questions',
    description: 'Free CCA practice questions across all 5 exam domains — detailed explanations, multiple test modes, and domain-weighted scoring to help you pass.',
    url: BASE + '/cca-practice-questions/',
    isPartOf: { '@type': 'WebSite', name: schema.course.provider, url: BASE }
  },
  breadcrumb([
    { name: 'Home',                     url: BASE },
    { name: 'CCA Practice Questions',   url: BASE + '/cca-practice-questions' }
  ])
];

/** Schemas for /cca-exam-guide */
const guideSchemas = [
  {
    // WebPage (not Article): the page shows no visible byline or published/
    // updated date, so an Article type \u2014 which Google expects to carry
    // datePublished + author \u2014 would be incomplete or require fabricated
    // data that doesn't appear on the page. WebPage matches what's actually
    // shown, consistent with the other reference pages on this site
    // (cca-foundations-exam, cca-practice-questions, diagnostic, register).
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: 'Claude Certified Architect Exam Guide',
    description: 'The Claude Certified Architect exam guide: format, domain weights, passing score, and proven study strategies for all 5 domains.',
    url: BASE + '/cca-exam-guide/',
    isPartOf: { '@type': 'WebSite', name: schema.course.provider, url: BASE }
  },
  breadcrumb([
    { name: 'Home',          url: BASE },
    { name: 'CCA Exam Guide', url: BASE + '/cca-exam-guide' }
  ])
];

/** Schemas for /register */
const registerSchemas = [
  {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: 'Register for the CCA Exam',
    description: "Register for the CCA Foundations exam through Anthropic's Skilljar portal. Review exam details, passing score, format, and cost before requesting access.",
    url: BASE + '/register/',
    isPartOf: { '@type': 'WebSite', name: schema.course.provider, url: BASE }
  },
  breadcrumb([
    { name: 'Home',     url: BASE },
    { name: 'Register', url: BASE + '/register/' }
  ])
];

/** Schemas for /diagnostic */
const diagnosticSchemas = [
  {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: 'CCA Readiness Diagnostic',
    description: 'Free 10-question CCA Foundations diagnostic quiz: get a per-domain score and a readiness estimate against the 720/1,000 passing standard.',
    url: BASE + '/diagnostic/',
    isPartOf: { '@type': 'WebSite', name: schema.course.provider, url: BASE }
  },
  breadcrumb([
    { name: 'Home',            url: BASE },
    { name: 'Diagnostic Quiz', url: BASE + '/diagnostic/' }
  ])
];

/** Schemas for /study-plan-generator */
const studyPlanSchemas = [
  {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'CCA Study Plan Generator',
    description: 'Free tool that builds a personalized, exam-weighted CCA Foundations study schedule from your weeks until exam and self-reported weak domains.',
    url: BASE + '/study-plan-generator/',
    applicationCategory: 'EducationalApplication',
    operatingSystem: 'Any',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    isPartOf: { '@type': 'WebSite', name: schema.course.provider, url: BASE }
  },
  breadcrumb([
    { name: 'Home',                  url: BASE },
    { name: 'Study Plan Generator',  url: BASE + '/study-plan-generator' }
  ])
];

// FAQ content for /faq — mainEntity text must match the visible <summary>/<p>
// text in faq/index.html exactly (links rendered as plain text).
const faqPageQA = [
  {
    q: 'What is the Claude Certified Architect (CCA) Foundations exam?',
    a: "The CCA Foundations exam is Anthropic's official certification for professionals who design and build production-grade applications with Claude. It tests practical, scenario-based decision-making across five domains: Agentic Architecture, Claude Code Configuration, Prompt Engineering, Tool Design & MCP, and Context Management."
  },
  {
    q: 'How many questions are on the CCA Foundations exam, and how long do I have?',
    a: 'The CCA Foundations exam consists of 60 scenario-based multiple choice questions with a 120-minute time limit, delivered as a proctored online exam.'
  },
  {
    q: 'What types of questions appear on the CCA Foundations exam?',
    a: "All questions are scenario-based multiple choice — you're placed in a realistic situation and must choose the best architectural decision. There are no simple definition or recall questions, which is why hands-on practice matters more than memorizing terminology."
  },
  {
    q: 'What is the passing score for the CCA Foundations exam?',
    a: 'The CCA Foundations exam uses a scaled scoring system from 100 to 1,000. The passing score is 720 out of 1,000 — this is a scaled score, not the percentage of questions you answered correctly.'
  },
  {
    q: 'Is the CCA Foundations exam open-book?',
    a: 'No. The CCA Foundations exam is a proctored, closed-book assessment — you cannot reference documentation, notes, or external resources during the exam. This is why active recall practice, working through questions without looking up the answer first, is the most effective way to prepare.'
  },
  // TODO(cost-verify): standard fee ($99) and free-for-first-5,000-partner-employees
  // early-access terms should be periodically re-checked against Anthropic's
  // registration page — capacity and pricing can change. Last verified 2026-06-12.
  {
    q: 'How much does the CCA Foundations exam cost?',
    a: "The standard registration fee for the CCA Foundations exam is $99 (USD), paid directly to Anthropic when you schedule your session. Anthropic is also offering free registration to the first 5,000 employees at partner companies through an early-access program — verify current eligibility and pricing on Anthropic's official registration page before you book. Either way, it's worth taking our free 10-question diagnostic quiz first to see where you stand against the 720/1,000 passing standard."
  },
  {
    q: 'Where do I register for the official CCA Foundations exam?',
    a: "You register for the official CCA Foundations exam directly through Anthropic. Visit our official exam registration page for a summary of the registration details and a link to Anthropic's registration portal."
  },
  {
    q: 'How long is the CCA Foundations certification valid?',
    a: 'The CCA Foundations certification is valid for 2 years from your passing date.'
  },
  {
    q: 'Can I retake the CCA Foundations exam if I fail?',
    a: "Yes. A mandatory waiting period applies between attempts — refer to Anthropic's current certification policy for the exact interval. The most effective retake strategy is to use your score breakdown to find your weakest domain, spend most of your retake preparation there, and run one more full timed simulation before attempting again."
  },
  {
    q: 'What are the five CCA Foundations exam domains and how are they weighted?',
    a: 'The exam covers five domains, each weighted differently: Agentic Architecture (27%), Claude Code Configuration (20%), Prompt Engineering (20%), Tool Design & MCP (18%), and Context Management (15%). Agentic Architecture carries the most weight, so it deserves a proportionally larger share of your study time. Our CCA exam guide breaks down each domain in detail, and our blog covers each one individually, from Domain 1: Agentic Architecture & Orchestration (27%) through to Domain 5: Context Management & Reliability (15%).'
  },
  {
    q: 'Is the CCA Foundations certification worth it?',
    a: "For engineers and architects who build production applications with Claude, yes. The certification validates practical skills across agent design, configuration, prompt engineering, tool integration, and context management, and it's valid for 2 years. Even if you don't need the credential itself, the preparation builds a working understanding of the architectural tradeoffs that come up constantly when building with Claude."
  },
  {
    q: 'Who should take the CCA Foundations exam?',
    a: "The exam is aimed at software engineers, solutions architects, AI engineers, and technical leads who design or oversee production applications built with Claude. No prior certification is required, but hands-on experience with Claude's APIs, Claude Code, and agentic workflows will make the material far more familiar."
  },
  {
    q: 'How should I prepare for the CCA Foundations exam?',
    a: 'Most candidates prepare in 1–2 weeks: work through each of the five domains, take short daily practice sessions to find weak areas, review the explanation for every question (not just the correct answer), use frameworks like SPIDER, CALM, and PRECISE to organize your thinking, and complete at least one full 120-minute timed simulation before exam day. Our CCA practice questions bank and CCA Foundations exam simulator cover all 400 practice questions across the five domains.'
  },
  {
    q: 'What does the CCA Practice Platform include?',
    a: 'The platform includes 400 scenario-based practice questions across all five exam domains, full-length 120-minute timed exam simulations, a free 10-question diagnostic quiz that estimates your readiness against the 720/1,000 passing standard, and a complete exam guide covering format, domain weights, and study strategy.'
  },
  {
    q: 'Is this site affiliated with Anthropic?',
    a: "No. This is an independent study resource. It is not affiliated with, authorized by, or endorsed by Anthropic. 'Claude' and 'Claude Certified Architect' are trademarks of their respective owner. We provide unofficial practice materials — including a free diagnostic quiz, practice questions, and full exam simulations — to help you prepare for the official exam."
  }
];

/** Schemas for /faq */
const faqPageSchemas = [
  {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: 'CCA Foundations Exam FAQ',
    description: 'Answers to the most common questions about the Claude Certified Architect (CCA) Foundations exam: cost, format, passing score, the five domains, and how to prepare.',
    url: BASE + '/faq/',
    isPartOf: { '@type': 'WebSite', name: schema.course.provider, url: BASE }
  },
  breadcrumb([
    { name: 'Home', url: BASE },
    { name: 'FAQ',  url: BASE + '/faq' }
  ]),
  {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqPageQA.map(item => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a }
    }))
  }
];

// ---------------------------------------------------------------------------
// Helpers — existing pages
// ---------------------------------------------------------------------------

function renderBlock(...schemas) {
  const tags = schemas
    .map(s => `<script type="application/ld+json">${JSON.stringify(s)}</script>`)
    .join('\n');
  return `${START_MARKER}\n${tags}\n${END_MARKER}`;
}

/**
 * Replace or inject a schema block in an HTML string.
 * - First run : replaces the original dynamic script (matched by FIRST_RUN_RE)
 * - Rebuilds  : replaces the previous markers (matched by REBUILD_RE)
 * - New page  : inserts before </head>
 */
function splice(html, block) {
  if (FIRST_RUN_RE.test(html))  return html.replace(FIRST_RUN_RE, block);
  if (REBUILD_RE.test(html))    return html.replace(REBUILD_RE, block);
  return html.replace('</head>', block + '\n</head>');
}

function processFile(filePath, ...schemas) {
  const rel   = path.relative(__dirname, filePath);
  const html  = fs.readFileSync(filePath, 'utf8');
  const block = renderBlock(...schemas);
  const out   = splice(html, block);
  fs.writeFileSync(filePath, out, 'utf8');
  console.log('✓', rel);
}

// ---------------------------------------------------------------------------
// Helpers — blog
// ---------------------------------------------------------------------------

/** Escape text for use inside an HTML element */
function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape text for use inside an HTML attribute value (double-quoted) */
function escAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

/** Produce a ≤65-char <title> for a blog post. Appends ' | CCA Prep' when it
 *  fits; uses the bare title when that fits; otherwise truncates at a word
 *  boundary and appends an ellipsis. */
function pageTitle(postTitle) {
  const SUFFIX = ' | CCA Prep';
  if ((postTitle + SUFFIX).length <= 65) return postTitle + SUFFIX;
  if (postTitle.length <= 65) return postTitle;
  const cut = postTitle.slice(0, 62).replace(/[\s,;:—–-]+\S*$/, '');
  return cut + '…';
}

/** Format an ISO date string (YYYY-MM-DD) to a human-readable date */
function formatDate(iso) {
  const d = iso.includes('T') ? new Date(iso) : new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
  });
}

/** Load all posts from posts/ sorted newest-first */
function loadPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  return fs.readdirSync(POSTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(POSTS_DIR, f), 'utf8')))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

/**
 * Topic groupings used to pick contextually-relevant "Related Articles" links
 * for each post (internal-linking strength — every post should link to
 * several others, not just be reachable via the /blog index card). Posts in
 * the same group are surfaced first; the list is padded with posts from other
 * groups so every post always gets a full set of related links regardless of
 * how the bank of posts grows over time.
 */
const POST_TOPICS = {
  'agentic-architecture-orchestration-cca-domain-1':  'domain',
  'claude-code-config-workflows-cca-domain-2':        'domain',
  'prompt-engineering-structured-output-cca-domain-3':'domain',
  'tool-design-mcp-cca-domain-4':                     'domain',
  'context-management-reliability-cca-domain-5':      'domain',
  'cca-foundations-exam-domains-explained':           'domain',
  'cca-exam-study-schedule-30-day-plan':              'prep',
  'cca-exam-anti-patterns':                           'prep',
  'cca-foundations-exam-practice-questions-free':     'prep',
  'how-to-write-effective-claude-md-file':            'prep',
  'cca-foundations-exam-guide-2026':                  'prep',
  'cca-real-world-reports-responsibilities-salaries': 'career',
  'claude-certified-architect-salary-career-2026':    'career',
  'why-claude-certification-is-important':            'career',
  'is-cca-certification-worth-it-2026':               'career',
  'how-to-become-claude-certified-architect':         'career',
  'claude-certified-architect-certification-worth-it':'career',
  'ai-engineer-certifications-2026':                  'career',
  'how-hard-is-cca-foundations-exam':                 'prep',
  'how-to-learn-claude-agent-development':            'prep',
};

/**
 * Pick `n` related posts for `post` using a cyclic "ring" within its topic
 * group: post at index i links to the next n posts in the group (wrapping
 * around). This — unlike a naive "first n same-topic" pick — distributes
 * inbound related-article links EVENLY across every post in the group (each
 * post ends up with exactly `n` same-topic inbound links, not just the ones
 * that happen to sort first), so no post is left thin on contextual internal
 * links. Falls back to other-topic posts only if a group is smaller than n+1.
 */
function relatedPosts(post, allPosts, n = 3) {
  // cca-foundations-exam-guide-2026 overlaps heavily with the /cca-exam-guide/
  // pillar (same "CCA exam guide" intent), so it's excluded from other posts'
  // related-reads to avoid reinforcing that duplication. It still resolves its
  // own ring normally below.
  const candidates = allPosts.filter(p => p.slug !== 'cca-foundations-exam-guide-2026' || p.slug === post.slug);
  const topic = POST_TOPICS[post.slug];
  const group = candidates.filter(p => POST_TOPICS[p.slug] === topic);
  const idx = group.findIndex(p => p.slug === post.slug);
  const picked = [];
  for (let k = 1; k <= group.length - 1 && picked.length < n; k++) {
    picked.push(group[(idx + k) % group.length]);
  }
  if (picked.length < n) {
    const others = candidates.filter(p => p.slug !== post.slug && POST_TOPICS[p.slug] !== topic);
    for (const p of others) {
      if (picked.length >= n) break;
      picked.push(p);
    }
  }
  return picked;
}

/** Inline CSS shared by all blog pages */
function sharedCSS() {
  return `<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --banner-h:0px;--bg:#f5f3ea;--surface:#fff;--surface3:#e8e5dc;--border:#d9d5ca;--border2:#c5c0b5;--text3:#6f6f66;
  --text:#191918;--text2:#5a5a52;--text3:#6f6f66;
  --accent:#d97757;--accent2:#a04f31;--accent3:#a8502f;--accent-text:#b04928;--accent-btn:#c4522c;
  --radius:8px;
}
html{scroll-behavior:smooth}
body{font-family:Georgia,'Times New Roman',serif;background:var(--bg);color:var(--text);line-height:1.7;overflow-x:hidden;min-height:100vh}
a{color:var(--accent-text);text-decoration:underline;text-underline-offset:3px;transition:color .2s}
a:hover{color:var(--accent3)}

/* ── Nav ── */
nav{position:fixed;top:var(--banner-h,0px);left:0;right:0;z-index:100;background:rgba(245,243,234,.92);backdrop-filter:blur(12px);border-bottom:1px solid var(--border)}
nav .inner{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;max-width:1100px;margin:0 auto;gap:12px}
.nav-logo{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:1rem;font-weight:600;color:var(--text);text-decoration:none;letter-spacing:-.3px;white-space:nowrap}
.nav-logo span{color:var(--text3);font-weight:400;font-size:.82rem;margin-left:6px}
.nav-links{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.nav-links a{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;padding:8px 14px;border-radius:6px;font-size:.88rem;color:var(--text2);text-decoration:none;transition:all .2s;white-space:nowrap}
.nav-links a:hover{color:var(--text);background:rgba(0,0,0,.04)}
.nav-links a.active{color:var(--text);font-weight:600}
.nav-cta{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;background:var(--accent-btn);color:#fff !important;padding:8px 18px;border-radius:6px;font-size:.88rem;font-weight:600;text-decoration:none !important;transition:background .2s;white-space:nowrap}
.nav-cta:hover{background:var(--accent2) !important}
.nav-hamburger{display:none;flex-direction:column;justify-content:center;align-items:center;gap:5px;padding:6px;cursor:pointer;border:none;background:none;margin-left:auto;flex-shrink:0;min-width:44px;min-height:44px}
.nav-hamburger span{display:block;width:22px;height:2px;background:var(--text);border-radius:2px;transition:transform .25s,opacity .25s}
@media(max-width:660px){
  nav .inner{flex-wrap:nowrap}
  .nav-links{display:none !important;position:absolute;top:100%;left:0;right:0;flex-direction:column;background:rgba(245,243,234,.97);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:12px 16px;gap:0;box-shadow:0 8px 24px rgba(0,0,0,.08)}
  .nav-links.open{display:flex !important}
  .nav-links a{padding:12px 16px;border-radius:6px;width:100%;text-align:left;white-space:normal;min-height:44px;display:flex;align-items:center}
  .nav-cta{display:none !important}
  .nav-hamburger{display:flex !important}
}

/* ── Post page ── */
.post-wrap{max-width:720px;margin:0 auto;padding:86px clamp(1.5rem,4vw,2.5rem) 80px}
.back-link{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.88rem;color:var(--text3);text-decoration:none;display:inline-block;margin-bottom:24px;transition:color .2s}
.back-link:hover{color:var(--accent-text)}
.post-title{font-size:clamp(1.8rem,4vw,2.6rem);font-weight:700;color:var(--text);line-height:1.15;letter-spacing:-.5px;margin-bottom:10px}
.post-meta{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.85rem;color:var(--text3);padding-bottom:28px;border-bottom:1px solid var(--border);margin-bottom:32px}

/* ── Post body typography ── */
.post-body{font-size:1.05rem;line-height:1.78}
.post-body h2{font-size:1.45rem;font-weight:700;color:var(--text);margin:2.2em 0 .65em;letter-spacing:-.3px;line-height:1.25}
.post-body h3{font-size:1.15rem;font-weight:700;color:var(--text);margin:1.8em 0 .5em;line-height:1.3}
.post-body p{margin-bottom:1.2em}
.post-body ul,.post-body ol{margin:0 0 1.2em 1.4em}
.post-body li{margin-bottom:.4em}
.post-body strong{font-weight:700;color:var(--text)}
.post-body code{font-family:'Courier New',monospace;font-size:.87em;background:#e8e5dc;padding:2px 6px;border-radius:4px;color:var(--accent2)}
.post-body pre{background:#191918;color:#f5f3ea;padding:20px 24px;border-radius:var(--radius);overflow-x:auto;margin:1.5em 0;font-family:'Courier New',monospace;font-size:.87em;line-height:1.6}
.post-body pre code{background:none;padding:0;color:inherit}
.post-body blockquote{border-left:3px solid var(--accent);padding:10px 18px;margin:1.5em 0;color:var(--text2);font-style:italic}
.post-body hr{border:none;border-top:1px solid var(--border);margin:2em 0}
.post-body table{display:block;width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;border-collapse:collapse;margin:1.5em 0;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.9rem}
.post-body th{text-align:left;padding:10px 14px;border-bottom:2px solid var(--border);font-weight:600;color:var(--text)}
.post-body td{padding:10px 14px;border-bottom:1px solid var(--border);color:var(--text2)}

/* ── Related articles (internal-linking block at end of each post) ── */
.related-posts{margin-top:3em;padding-top:1.8em;border-top:1px solid var(--border)}
.related-posts h2{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:1.05rem;font-weight:700;color:var(--text);margin:0 0 .9em;letter-spacing:-.2px}
.related-posts ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.6em}
.related-posts li{margin:0}
.related-posts a{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;color:var(--accent-text);text-decoration:none;font-weight:600;font-size:.95rem;line-height:1.4}
.related-posts a:hover{text-decoration:underline}

/* ── Blog index ── */
.blog-wrap{max-width:720px;margin:0 auto;padding:96px clamp(1.5rem,4vw,2.5rem) 80px}
.blog-header{margin-bottom:44px;padding-bottom:28px;border-bottom:1px solid var(--border)}
.blog-header h1{font-size:clamp(2rem,4vw,2.75rem);font-weight:700;letter-spacing:-.5px;margin-bottom:8px}
.blog-header p{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;color:var(--text2);font-size:.97rem}
.post-list{display:flex;flex-direction:column;gap:0}
.post-card{padding:28px 0;border-bottom:1px solid var(--border)}
.post-card-date{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.82rem;color:var(--text3);margin-bottom:5px}
.post-card-title{font-size:1.22rem;font-weight:700;margin-bottom:7px;line-height:1.3}
.post-card-title a{color:var(--text);text-decoration:none;transition:color .2s}
.post-card-title a:hover{color:var(--accent-text)}
.post-card-desc{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;color:var(--text2);font-size:.93rem;line-height:1.55}
.empty-state{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;color:var(--text3);padding:40px 0}

/* ── Breadcrumb ── */
.bc{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.82rem;padding:10px 0 4px}
.bc ol{list-style:none;display:flex;align-items:center;gap:0;padding:0;margin:0}
.bc li{display:flex;align-items:center}
.bc li+li::before{content:"\u203A";padding:0 6px;color:var(--text3);font-size:.9em}
.bc a{color:var(--text3);text-decoration:none;transition:color .2s}
.bc a:hover{color:var(--accent-text)}
.bc [aria-current]{color:var(--text2);font-weight:500}

/* ── Footer ── */
.site-footer{background:#191918;color:#8a8a7f;padding:28px 24px;text-align:center;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.82rem;line-height:1.6}
.site-footer a{color:#8a8a7f;text-underline-offset:3px}
.site-footer a:hover{color:#f5f3ea}

/* ── Compliance banner ── */
#site-banner{position:fixed;top:0;left:0;right:0;z-index:101;background:var(--surface3,#e8e5dc);color:var(--text2,#5a5a52);font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.72rem;line-height:1.4;text-align:center;padding:7px 44px 7px 16px;border-bottom:1px solid var(--border2,#c5c0b5)}
#site-banner-close{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--text3,#8a8a7f);font-size:1.1rem;line-height:1;cursor:pointer;padding:4px 7px;border-radius:4px;transition:color .15s;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center}
#site-banner-close:hover{color:var(--text,#191918)}
</style>`;
}

/** Shared nav HTML */
function blogNav(activePage) {
  const link = (href, label) => {
    const cls = activePage === href ? ' class="active"' : '';
    return `<a href="${href}"${cls}>${label}</a>`;
  };
  return "<div id=\"site-banner\" role=\"note\" aria-label=\"Independence notice\">Independent exam prep · Not affiliated with or endorsed by Anthropic · Not the official CCA exam or certification<button id=\"site-banner-close\" aria-label=\"Dismiss notice\">✕</button></div>\n<script>(function(){var b=document.getElementById(\"site-banner\"),c=document.getElementById(\"site-banner-close\");if(!b)return;if(localStorage.getItem(\"ccaBanner\")===\"0\"){b.style.display=\"none\";document.documentElement.style.setProperty(\"--banner-h\",\"0px\");return;}function setH(){document.documentElement.style.setProperty(\"--banner-h\",b.offsetHeight+\"px\");}setH();window.addEventListener(\"resize\",setH);c.addEventListener(\"click\",function(){b.style.display=\"none\";document.documentElement.style.setProperty(\"--banner-h\",\"0px\");localStorage.setItem(\"ccaBanner\",\"0\");});})()</script>\n" + `<nav aria-label="Main navigation">
  <div class="inner">
    <a href="/" class="nav-logo">CCA <span>Practice Platform</span></a>
    <div class="nav-links" id="blog-nav-links">
      ${link('/cca-practice-questions/', 'Practice Tests')}
      ${link('/cca-foundations-exam/', 'Exam Sim')}
      ${link('/cca-exam-guide/', 'Guide')}
      ${link('/diagnostic/', 'Diagnostic')}
      ${link('/blog/', 'Blog')}
      ${link('/faq/', 'FAQ')}
      <!-- Was a plain "Register" nav-link, easily mistaken for "register/sign
           up for this site." It actually opens Anthropic's external exam-
           registration info page, so it now reads as an explicit external
           link with an arrow + accessible label. -->
      <a href="/register/" aria-label="Official Claude Certified Architect exam registration on Anthropic's site">Official Exam <span aria-hidden="true" style="font-size:.85em;line-height:1">&#8599;</span></a>
    </div>
    <a href="/" class="nav-cta">Start Practicing</a>
    <button class="nav-hamburger" aria-label="Toggle menu"
      onclick="document.getElementById('blog-nav-links').classList.toggle('open')">
      <span></span><span></span><span></span>
    </button>
  </div>
</nav>`;
}

/** Shared footer HTML */
function blogFooter() {
  const year = new Date().getFullYear();
  // Mini-sitemap: every key page on the site, with descriptive anchor text,
  // reachable from every blog post's footer (strengthens internal linking
  // and keeps every important page within 1–2 clicks of any page on the site).
  const links = [
    ['/', 'Home'],
    ['/cca-practice-questions/', 'Practice Questions'],
    ['/cca-foundations-exam/', 'Foundations Exam Simulator'],
    ['/cca-exam-guide/', 'Exam Guide'],
    ['/diagnostic/', 'Free Diagnostic Quiz'],
    ['/blog/', 'Blog'],
    ['/faq/', 'FAQ'],
    ['/register/', 'Official Exam Registration'],
  ].map(([href, label]) => `<a href="${href}">${label}</a>`).join(' &nbsp;&middot;&nbsp; ');
  return `<footer class="site-footer">
  <p style="margin:0 0 6px">&copy; ${year} Claude Certified Architects</p>
  <p style="margin:0 0 10px;font-size:.82rem">${links}</p>
  <p style="max-width:620px;margin:0 auto;font-size:.85rem;line-height:1.65;color:#c8c8be">Claude Certified Architects is an independent exam-preparation resource. We are not affiliated with, endorsed by, or sponsored by Anthropic, and this is not the official Claude Certified Architect exam or certification. ‘Claude’ and ‘Claude Certified Architect’ are trademarks of Anthropic. We provide unofficial practice materials to help candidates prepare for the official exam.</p>
  <p style="margin:10px 0 0;font-size:.82rem">Questions? <a href="mailto:support@claudecertifiedarchitects.com">support@claudecertifiedarchitects.com</a></p>
</footer>`;
}

/** Article JSON-LD for a blog post */
function articleJsonLd(post) {
  const img = post.ogImage
    ? (post.ogImage.startsWith('http') ? post.ogImage : BASE + post.ogImage)
    : BASE + '/og-image-v2.png';
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.h1 || post.title,
    description: post.description,
    url: `${BASE}/blog/${post.slug}/`,
    datePublished: post.date,
    dateModified: post.updated || post.date,
    image: img,
    publisher: { '@type': 'Organization', name: 'Claude Certified Architects', url: BASE },
    author:    { '@type': 'Organization', name: 'Claude Certified Architects', url: BASE },
    isPartOf:  { '@type': 'WebSite', name: 'Claude Certified Architects', url: BASE }
  };
}

/** Generate one blog post page → blog/<slug>/index.html */
function generateBlogPost(post, _index, allPosts) {
  const ogImg = post.ogImage
    ? (post.ogImage.startsWith('http') ? post.ogImage : BASE + post.ogImage)
    : BASE + '/og-image-v2.png';

  const schemaList = [articleJsonLd(post), breadcrumb([
    { name: 'Home', url: BASE },
    { name: 'Blog', url: `${BASE}/blog/` },
    { name: post.h1 || post.title, url: `${BASE}/blog/${post.slug}/` }
  ])];

  // If the post defines an `faq` array ({q, a} pairs matching its visible
  // FAQ section), emit FAQPage structured data alongside the Article schema.
  if (Array.isArray(post.faq) && post.faq.length) {
    schemaList.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: post.faq.map(item => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a }
      }))
    });
  }

  const schemas = schemaList.map(s => `<script type="application/ld+json">${JSON.stringify(s)}</script>`).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<!-- Google tag (gtag.js) -->
<script>(function(w,d,s,i){w.dataLayer=w.dataLayer||[];function gtag(){w.dataLayer.push(arguments);}w.gtag=w.gtag||gtag;gtag('js',new Date());gtag('config',i);gtag('config','AW-18239120039',{'conversion_linker':true});function gtagLoad(){var j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtag/js?id='+i;d.head.appendChild(j);}if(d.readyState==='complete'){gtagLoad();}else{w.addEventListener('load',gtagLoad);}})(window,document,'script','GT-K8FC4RXW');</script>
<!-- End Google tag (gtag.js) -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${escHtml(pageTitle(post.title))}</title>
<meta name="description" content="${escAttr(post.description)}">
<link rel="canonical" href="${BASE}/blog/${post.slug}/">
<meta property="og:type" content="article">
<meta property="og:title" content="${escAttr(post.title)}">
<meta property="og:description" content="${escAttr(post.description)}">
<meta property="og:url" content="${BASE}/blog/${post.slug}/">
<meta property="og:site_name" content="Claude Certified Architects">
<meta property="og:image" content="${ogImg}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta property="article:published_time" content="${post.date}">
<meta property="article:modified_time" content="${post.updated || post.date}">
<meta property="article:section" content="CCA Exam Preparation">
<meta name="author" content="Claude Certified Architects">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escAttr(post.title)}">
<meta name="twitter:description" content="${escAttr(post.description)}">
<meta name="twitter:image" content="${ogImg}">
<link rel="preconnect" href="https://www.googletagmanager.com">
${schemas}
${sharedCSS()}
</head>
<body>
<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GT-K8FC4RXW" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->
${blogNav('/blog/')}
<main class="post-wrap">
  <article>
    <header>
      <div class="bc" role="navigation" aria-label="Breadcrumb">
        <ol>
          <li><a href="/">Home</a></li>
          <li><a href="/blog/">Blog</a></li>
          <li><span aria-current="page">${escHtml(post.h1 || post.title)}</span></li>
        </ol>
      </div>
      <h1 class="post-title">${escHtml(post.h1 || post.title)}</h1>
      <p class="post-meta">By Claude Certified Architects · <time datetime="${post.date}">${formatDate(post.date)}</time>${post.updated ? ` · Updated <time datetime="${post.updated}">${formatDate(post.updated)}</time>` : ''}</p>
    </header>
    <div class="post-body">
      ${post.body}
    </div>
    ${(() => {
      const related = relatedPosts(post, allPosts || []);
      if (!related.length) return '';
      return `<section class="related-posts" aria-label="Related articles">
      <h2>Related Articles</h2>
      <ul>
        ${related.map(p => `<li><a href="/blog/${p.slug}/">${escHtml(p.title)}</a></li>`).join('\n        ')}
      </ul>
    </section>`;
    })()}
  </article>
</main>
${blogFooter()}
</body>
</html>`;

  const dir = path.join(BLOG_DIR, post.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
  console.log(`✓ blog/${post.slug}/index.html`);
}

/** Generate the blog index page → blog/index.html */
function generateBlogIndex(posts) {
  const schemas = `<script type="application/ld+json">${JSON.stringify(breadcrumb([
    { name: 'Home', url: BASE },
    { name: 'Blog', url: `${BASE}/blog` }
  ]))}</script>`;

  const listHtml = posts.length === 0
    ? `<p class="empty-state">No posts yet — check back soon.</p>`
    : posts.map(p => `
    <div class="post-card">
      <div class="post-card-date">${formatDate(p.date)}</div>
      <div class="post-card-title"><a href="/blog/${p.slug}/">${escHtml(p.title)}</a></div>
      <p class="post-card-desc">${escHtml(p.description)}</p>
    </div>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<!-- Google tag (gtag.js) -->
<script>(function(w,d,s,i){w.dataLayer=w.dataLayer||[];function gtag(){w.dataLayer.push(arguments);}w.gtag=w.gtag||gtag;gtag('js',new Date());gtag('config',i);gtag('config','AW-18239120039',{'conversion_linker':true});function gtagLoad(){var j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtag/js?id='+i;d.head.appendChild(j);}if(d.readyState==='complete'){gtagLoad();}else{w.addEventListener('load',gtagLoad);}})(window,document,'script','GT-K8FC4RXW');</script>
<!-- End Google tag (gtag.js) -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>CCA Blog | Claude Certified Architect Guides &amp; Study Tips</title>
<meta name="description" content="Guides on Claude architecture, prompt engineering, MCP, agentic systems, and passing the CCA Foundations exam on your first attempt.">
<link rel="canonical" href="${BASE}/blog/">
<meta property="og:type" content="website">
<meta property="og:title" content="CCA Blog | Claude Certified Architect Guides &amp; Study Tips">
<meta property="og:description" content="Articles and guides on Claude architecture, prompt engineering, MCP, and passing the CCA Foundations exam.">
<meta property="og:url" content="${BASE}/blog/">
<meta property="og:site_name" content="Claude Certified Architects">
<meta property="og:image" content="${BASE}/og-image-v2.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta name="author" content="Claude Certified Architects">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="CCA Blog | Claude Certified Architect Guides &amp; Study Tips">
<meta name="twitter:description" content="Articles and guides on Claude architecture, prompt engineering, MCP, and passing the CCA Foundations exam.">
<meta name="twitter:image" content="${BASE}/og-image-v2.png">
<link rel="preconnect" href="https://www.googletagmanager.com">
${schemas}
${sharedCSS()}
</head>
<body>
<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GT-K8FC4RXW" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->
${blogNav('/blog/')}
<main class="blog-wrap">
  <div class="bc" role="navigation" aria-label="Breadcrumb">
    <ol><li><a href="/">Home</a></li><li><span aria-current="page">Blog</span></li></ol>
  </div>
  <header class="blog-header">
    <h1>Blog</h1>
    <p>Guides and insights on Claude architecture, prompt engineering, and CCA exam prep.</p>
  </header>
  <div class="post-list">
    ${listHtml}
  </div>
</main>
${blogFooter()}
</body>
</html>`;

  fs.mkdirSync(BLOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(BLOG_DIR, 'index.html'), html, 'utf8');
  console.log('✓ blog/index.html');
}

// ---------------------------------------------------------------------------
// Homepage — inject 3 most-recent posts into <!-- cca:recent-posts --> block
// ---------------------------------------------------------------------------

function injectRecentPosts(posts) {
  const recent = posts.slice(0, 3);
  const cards = recent.map(p => `
    <a href="/blog/${p.slug}/" class="bp-card">
      <div class="bp-date">${formatDate(p.date)}</div>
      <div class="bp-title">${escHtml(p.title)}</div>
      <p class="bp-desc">${escHtml(p.description)}</p>
    </a>`).join('');

  const block = `<!-- cca:recent-posts:start -->
<section class="blog-preview">
  <div class="bp-inner">
    <div class="section-label">FROM THE BLOG</div>
    <h2>Latest Articles</h2>
    <div class="bp-grid">${cards}
    </div>
    <a href="/blog/" class="bp-all">View all articles →</a>
  </div>
</section>
<!-- cca:recent-posts:end -->`;

  const indexPath = path.join(__dirname, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  html = html.replace(/<!-- cca:recent-posts:start -->[\s\S]*?<!-- cca:recent-posts:end -->/, block);
  fs.writeFileSync(indexPath, html, 'utf8');
  console.log('✓ index.html (recent posts injected)');
}

// ---------------------------------------------------------------------------
// Custom 404 page — served by GitHub Pages for any unmatched path
// ---------------------------------------------------------------------------

function generate404() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<!-- Google tag (gtag.js) -->
<script>(function(w,d,s,i){w.dataLayer=w.dataLayer||[];function gtag(){w.dataLayer.push(arguments);}w.gtag=w.gtag||gtag;gtag('js',new Date());gtag('config',i);gtag('config','AW-18239120039',{'conversion_linker':true});function gtagLoad(){var j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtag/js?id='+i;d.head.appendChild(j);}if(d.readyState==='complete'){gtagLoad();}else{w.addEventListener('load',gtagLoad);}})(window,document,'script','GT-K8FC4RXW');</script>
<!-- End Google tag (gtag.js) -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Page Not Found · Claude Certified Architects</title>
<meta name="robots" content="noindex,follow">
${sharedCSS()}
</head>
<body>
<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GT-K8FC4RXW" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->
${blogNav('')}
<main class="post-wrap" style="text-align:center">
  <h1 class="post-title">404 — Page Not Found</h1>
  <p style="color:var(--text2);font-size:1.05rem;margin:1em 0 2em">The page you're looking for doesn't exist or may have moved.</p>
  <p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif">
    <a href="/">Homepage</a> &nbsp;&middot;&nbsp;
    <a href="/blog/">Blog</a> &nbsp;&middot;&nbsp;
    <a href="/cca-practice-questions/">Practice Questions</a> &nbsp;&middot;&nbsp;
    <a href="/diagnostic/">Free Diagnostic Quiz</a>
  </p>
</main>
${blogFooter()}
</body>
</html>`;

  fs.writeFileSync(path.join(__dirname, '404.html'), html, 'utf8');
  console.log('✓ 404.html');
}

// ---------------------------------------------------------------------------
// Sitemap generator
// ---------------------------------------------------------------------------

// Returns the date (YYYY-MM-DD) a tracked file was actually last changed:
// today if it has uncommitted changes, otherwise the date of the last
// commit that touched it. Avoids bumping every page's <lastmod> to "today"
// on every build regardless of whether that page's content changed.
function gitLastmod(relPath) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const status = execSync(`git status --porcelain -- "${relPath}"`, { cwd: __dirname, encoding: 'utf8' }).trim();
    if (status) return today;
    const log = execSync(`git log -1 --format=%cd --date=short -- "${relPath}"`, { cwd: __dirname, encoding: 'utf8' }).trim();
    if (log) return log;
  } catch (e) { /* fall through */ }
  return today;
}

function generateSitemap(posts = []) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const pages = [
    { loc: BASE + '/',                         priority: '1.0', changefreq: 'weekly',  lastmod: gitLastmod('index.html') },
    { loc: BASE + '/cca-foundations-exam/',     priority: '0.9', changefreq: 'weekly',  lastmod: gitLastmod('cca-foundations-exam/index.html') },
    { loc: BASE + '/cca-practice-questions/',   priority: '0.9', changefreq: 'weekly',  lastmod: gitLastmod('cca-practice-questions/index.html') },
    { loc: BASE + '/cca-exam-guide/',           priority: '0.8', changefreq: 'monthly', lastmod: gitLastmod('cca-exam-guide/index.html') },
    { loc: BASE + '/blog/',                     priority: '0.7', changefreq: 'weekly',  lastmod: gitLastmod('blog/index.html') },
    { loc: BASE + '/register/',               priority: '0.8', changefreq: 'monthly', lastmod: gitLastmod('register/index.html') },
    { loc: BASE + '/diagnostic/',             priority: '0.8', changefreq: 'monthly', lastmod: gitLastmod('diagnostic/index.html') },
    { loc: BASE + '/study-plan-generator/',   priority: '0.8', changefreq: 'monthly', lastmod: gitLastmod('study-plan-generator/index.html') },
    { loc: BASE + '/faq/',                    priority: '0.8', changefreq: 'monthly', lastmod: gitLastmod('faq/index.html') },
    ...posts.map(p => ({
      loc:        `${BASE}/blog/${p.slug}/`,
      priority:   '0.8',
      changefreq: 'monthly',
      lastmod:    (p.updated || p.date).slice(0, 10)
    }))
  ];

  const urls = pages.map(p => `
  <url>
    <loc>${p.loc}</loc>
    <lastmod>${p.lastmod}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}
</urlset>
`;

  const dest = path.join(__dirname, 'sitemap.xml');
  fs.writeFileSync(dest, xml, 'utf8');
  console.log('✓ sitemap.xml  (' + today + ', ' + (8 + posts.length) + ' URLs)');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
console.log('Pre-rendering JSON-LD…\n');

processFile(path.join(__dirname, 'index.html'),
  organizationSchema, websiteSchema, courseSchema, faqSchema);

processFile(path.join(__dirname, 'cca-foundations-exam',  'index.html'),
  ...examSchemas);

processFile(path.join(__dirname, 'cca-practice-questions', 'index.html'),
  ...questionsSchemas);

processFile(path.join(__dirname, 'cca-exam-guide',         'index.html'),
  ...guideSchemas);

processFile(path.join(__dirname, 'register', 'index.html'),
  ...registerSchemas);

processFile(path.join(__dirname, 'diagnostic', 'index.html'),
  ...diagnosticSchemas);

processFile(path.join(__dirname, 'study-plan-generator', 'index.html'),
  ...studyPlanSchemas);

processFile(path.join(__dirname, 'faq', 'index.html'),
  ...faqPageSchemas);


console.log('\nBuilding blog…\n');

const posts = loadPosts();
injectRecentPosts(posts);
generateBlogIndex(posts);
posts.forEach(generateBlogPost);

console.log('');
generate404();

console.log('');
generateSitemap(posts);

console.log('\nDone. Commit and push the updated HTML files.');
