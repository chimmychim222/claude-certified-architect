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

// ── Nav injection ─────────────────────────────────────────────────────────────
// Canonical 10-item navbar in fixed order. processFile() calls spliceNav()
// which either replaces between <!-- cca:nav:start/end --> markers (subsequent
// runs) or finds the <div class="nav-links" id="nav-links"> div directly (first
// run), so no manual marker seeding is required on the first build.
const NAV_START  = '<!-- cca:nav:start -->';
const NAV_END    = '<!-- cca:nav:end -->';
const NAV_RE     = /<!-- cca:nav:start -->[\s\S]*?<!-- cca:nav:end -->/;
const NAV_DIV_RE = /<div class="nav-links" id="nav-links">[\s\S]*?<\/div>/;

const NAV_PAGES = [
  ['/',                       'Home'          ],
  ['/cca-foundations-exam/',  'Exam'          ],
  ['/?hub=practice-tests',    'Practice Tests'],
  ['/cca-practice-questions/','Question Bank' ],
  ['/cca-exam-guide/',        'Guide'         ],
  ['/diagnostic/',            'Diagnostic'    ],
  ['/study-plan-generator/',  'Study Plan'    ],
  ['/blog/',                  'Blog'          ],
  ['/faq/',                   'FAQ'           ],
];

const OFFICIAL_EXAM_LINK =
  '<a href="/register/"' +
  ' aria-label="Official Claude Certified Architect exam registration on Anthropic\'s site"' +
  ' style="font-family:-apple-system,system-ui,\'Segoe UI\',sans-serif;padding:5px 10px;border-radius:6px;font-size:.85rem;font-weight:600;color:var(--accent-text);background:transparent;border:1px solid var(--accent-text);transition:all .2s;text-decoration:none;display:inline-flex;align-items:center;gap:4px;white-space:nowrap"' +
  ' onclick="closeNav()">Exam Info</a>';

const REGISTER_CTA_LINK =
  '<a href="#register-action" class="nav-cta active"' +
  ' aria-label="Jump to the exam registration portal link below"' +
  ' onclick="closeNav()">Register</a>';

function renderNav(activePage) {
  const items = NAV_PAGES.map(([href, label]) => {
    const active = href === activePage ? ' class="active" aria-current="page"' : '';
    return `<a href="${href}" onclick="closeNav()"${active}>${label}</a>`;
  });
  items.push(activePage === '/register/' ? REGISTER_CTA_LINK : OFFICIAL_EXAM_LINK);
  // #nav-auth-static: fixed-min-width wrapper that holds the auth cluster.
  // margin-left:auto (via LOGO_CSS) pushes it to the right on desktop.
  // nav-auth.js (deferred) and the inline NAV_HINT_SCRIPT swap its contents
  // to the logged-in cluster when the user is authenticated.
  items.push(
    '<div id="nav-auth-static">' +
      '<a href="/?login=true" class="nav-auth-login" onclick="closeNav()">Log In</a>' +
      '<a href="/?signup=true" class="nav-auth-signup" onclick="closeNav()">Sign Up Free</a>' +
    '</div>'
  );
  // Inline hint: synchronous localStorage read before first paint → zero CLS.
  items.push(NAV_HINT_SCRIPT);
  return items.join('\n      ');
}

function spliceNav(html, navHtml) {
  const wrapped = `${NAV_START}\n      ${navHtml}\n      ${NAV_END}`;
  if (NAV_RE.test(html))     return html.replace(NAV_RE, wrapped);
  if (NAV_DIV_RE.test(html)) {
    return html.replace(NAV_DIV_RE,
      `<div class="nav-links" id="nav-links">\n      ${wrapped}\n    </div>`);
  }
  return html; // no nav div found — skip silently
}

// ── Footer injection ──────────────────────────────────────────────────────────
const FOOTER_START   = '<!-- cca:footer:start -->';
const FOOTER_END     = '<!-- cca:footer:end -->';
const FOOTER_RE      = /<!-- cca:footer:start -->[\s\S]*?<!-- cca:footer:end -->/;
const FOOTER_EL_RE   = /<footer[^>]*>[\s\S]*?<\/footer>/;

const FOOTER_NAV_PAGES = [
  ['/',                       'Home'          ],
  ['/cca-foundations-exam/',  'Exam'          ],
  ['/?hub=practice-tests',    'Practice Tests'],
  ['/cca-practice-questions/','Question Bank' ],
  ['/cca-exam-guide/',        'Guide'         ],
  ['/diagnostic/',            'Diagnostic'    ],
  ['/study-plan-generator/',  'Study Plan'    ],
  ['/blog/',                  'Blog'          ],
  ['/faq/',                   'FAQ'           ],
  ['/register/',              'Exam Info' ],
];

function renderFooter(year) {
  const links = FOOTER_NAV_PAGES
    .map(([h, l]) => `<a href="${h}">${l}</a>`)
    .join(' &middot; ');
  return (
    `<div class="links-row">${links}</div>\n` +
    `<p class="footer-disclaimer">CCA Practice Platforms is an independent exam-preparation resource. We are not affiliated with, endorsed by, sponsored by, or authorized by Anthropic, and this is not the official Claude Certified Architect exam or certification. 'Claude', 'Claude Certified Architect', and 'CCA' are trademarks of Anthropic, PBC, used here only to identify the exam our materials help you prepare for.</p>\n` +
    `<p style="margin-top:8px;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.78rem;color:var(--text3)"><a href="/privacy/">Privacy Policy</a> &middot; <a href="/terms/">Terms of Service</a> &middot; <a href="/refund/">Refund Policy</a></p>\n` +
    `<p style="margin-top:8px">© ${year} CCA Practice Platforms · Questions? <a href="mailto:support@claudecertifiedarchitects.com">support@claudecertifiedarchitects.com</a></p>`
  );
}

function spliceFooter(html, footerInnerHtml) {
  const wrapped = `${FOOTER_START}\n${footerInnerHtml}\n${FOOTER_END}`;
  if (FOOTER_RE.test(html))   return html.replace(FOOTER_RE, wrapped);
  if (FOOTER_EL_RE.test(html)) {
    return html.replace(FOOTER_EL_RE,
      `<footer>\n<div class="container">\n${wrapped}\n</div>\n</footer>`);
  }
  return html;
}

// ── Logo injection ────────────────────────────────────────────────────────────
// Canonical logo markup, identical on every static page. Injected between
// <!-- cca:logo:start/end --> markers so it can't drift independently.
// The homepage uses a <div class="logo"> (SPA, no navigation), so it is NOT
// processed here and keeps its existing markup unchanged.
const LOGO_START = '<!-- cca:logo:start -->';
const LOGO_END   = '<!-- cca:logo:end -->';
const LOGO_RE    = /<!-- cca:logo:start -->[\s\S]*?<!-- cca:logo:end -->/;
// CSS injected alongside the logo markup. Appears in <body> after per-page
// <head> styles, so higher-specificity rules here win the cascade.
// Auth buttons (nav-auth-login / nav-auth-signup) are the last items inside
// nav-links on every static/blog page. margin-left:auto on nav-auth-login
// pushes the pair to the right on desktop. On mobile they appear naturally
// inside the hamburger dropdown.
const LOGO_CSS  =
  // Logo wordmark
  'nav .logo{font-family:-apple-system,system-ui,\'Segoe UI\',sans-serif;' +
    'font-size:1rem;font-weight:600;color:var(--text);text-decoration:none;' +
    'letter-spacing:-.3px;white-space:nowrap}' +

  // nav-links fills available width so the auth wrapper can push to the right
  'nav .nav-links{flex:1}' +

  // #nav-auth-static: fixed-minimum-width wrapper — margin-left:auto pushes it
  // to the right edge; min-width keeps the space reserved so swapping
  // Log In/Sign Up Free for the logged-in cluster causes zero layout shift.
  '#nav-auth-static{margin-left:auto;display:flex;align-items:center;gap:8px;' +
    'min-width:180px;justify-content:flex-end;flex-shrink:0}' +

  // Logged-out links inside the wrapper (desktop appearance)
  '#nav-auth-static .nav-auth-login{font-family:-apple-system,system-ui,\'Segoe UI\',' +
    'sans-serif;font-size:.8rem;font-weight:600;color:var(--text2);background:transparent;' +
    'border:1px solid var(--border);border-radius:6px;text-decoration:none;' +
    'white-space:nowrap;transition:all .2s}' +
  '#nav-auth-static .nav-auth-signup{font-family:-apple-system,system-ui,\'Segoe UI\',' +
    'sans-serif;font-size:.8rem;font-weight:700;color:var(--accent-text);' +
    'background:transparent;border:1px solid var(--accent-text);border-radius:6px;' +
    'text-decoration:none;white-space:nowrap;transition:all .2s}' +

  // Logged-in elements (injected by nav-auth.js / inline hint)
  '.nav-user-name{font-family:-apple-system,system-ui,\'Segoe UI\',sans-serif;' +
    'font-size:.78rem;font-weight:600;color:var(--text);white-space:nowrap;' +
    'overflow:hidden;text-overflow:ellipsis;max-width:90px}' +
  '.nav-logout-btn{font-family:-apple-system,system-ui,\'Segoe UI\',sans-serif;' +
    'font-size:.75rem;font-weight:600;color:var(--text3);background:transparent;' +
    'border:1px solid var(--border);border-radius:6px;padding:4px 10px;' +
    'cursor:pointer;white-space:nowrap;transition:all .2s}' +

  // Homepage mobile-only auth links (class nav-auth-btn) — hidden on desktop
  'nav .nav-auth-btn{display:none}' +

  // Mobile ≤640 px: expand wrapper to full-width column, reset border styles
  '@media(max-width:640px){' +
    '#nav-auth-static{margin-left:0;min-width:0;width:100%;flex-direction:column;' +
      'align-items:flex-start;gap:4px}' +
    '#nav-auth-static .nav-auth-login,' +
    '#nav-auth-static .nav-auth-signup,' +
    '#nav-auth-static .nav-logout-btn,' +
    '#nav-auth-static .nav-user-name{border:none;color:var(--text2);' +
      'font-size:.9rem;width:100%;padding:12px 16px;min-height:44px;' +
      'display:flex;align-items:center;max-width:none}' +
    // Show homepage mobile auth links inside hamburger dropdown
    'nav .nav-auth-btn{display:flex;align-items:center;color:var(--text2);' +
      'text-decoration:none;font-family:-apple-system,system-ui,\'Segoe UI\',sans-serif;' +
      'font-size:.9rem;min-height:44px}' +
  '}' +

  // Homepage only: hide the JS-driven user-area on mobile (it overflows the bar)
  '@media(max-width:768px){.user-area{display:none!important}}';

// Inline hint — synchronous localStorage read that runs BEFORE first paint
// so a logged-in user never sees the logged-out state (zero CLS). Placed
// inside nav-links after #nav-auth-static so the element already exists.
// Inline hint: synchronous localStorage read before first paint → zero CLS.
// Falls back to wrapping bare .nav-auth-login links if #nav-auth-static was
// served from a stale CDN cache without the wrapper div.
const NAV_HINT_SCRIPT =
  '<script>(function(){' +
  'try{var e=localStorage.getItem(\'cca_logged_in\');if(!e)return;' +
  'var c=document.getElementById(\'nav-auth-static\');' +
  'if(!c){' +
    'var l=document.querySelector(\'a.nav-auth-login\');if(!l)return;' +
    'c=document.createElement(\'div\');c.id=\'nav-auth-static\';' +
    'l.parentElement.insertBefore(c,l);c.appendChild(l);' +
    'var s=document.querySelector(\'a.nav-auth-signup\');if(s)c.appendChild(s);' +
  '}' +
  'c.innerHTML=' +
    '\'<span class="nav-user-name" title="\'+e+\'">\'+e.split(\'@\')[0]+\'</span>\'' +
    '+\'<button class="nav-logout-btn" onclick="window.__navSO&&window.__navSO()">Log out</button>\';' +
  '}catch(x){}})()' +
  '<' + '/script>';

const LOGO_HTML  =
  // Preconnect to Firebase/gstatic CDN — minimises the cold-load round-trip
  // for nav-auth.js's dynamic firebase-app + firebase-auth imports.
  '<link rel="preconnect" href="https://www.gstatic.com" crossorigin>' +
  // nav-auth.js is deferred so it never blocks LCP; it uses requestIdleCallback
  // internally so the Firebase import doesn't compete with rendering.
  '<script src="/nav-auth.js" defer></script>' +
  `<style>${LOGO_CSS}</style>` +
  '<a href="/" class="logo">CCA Practice Platforms</a>';

function spliceLogo(html) {
  const wrapped = `${LOGO_START}${LOGO_HTML}${LOGO_END}`;
  if (LOGO_RE.test(html)) return html.replace(LOGO_RE, wrapped);
  return html;
}

// ── Auth cluster injection ────────────────────────────────────────────────────
// Injects "Log In" (/?login=true) and "Sign Up Free" (/?signup=true) buttons,
// plus an optional page-specific CTA, into every static page's nav via
// <!-- cca:auth:start/end --> markers placed after <!-- cca:nav:end -->.
// The homepage keeps its own JS-driven #nav-logged-in/#nav-logged-out swap and
// is NOT processed here (activePage === null skips auth cluster injection).
const AUTH_START = '<!-- cca:auth:start -->';
const AUTH_END   = '<!-- cca:auth:end -->';
const AUTH_RE    = /<!-- cca:auth:start -->[\s\S]*?<!-- cca:auth:end -->/;

// Page-specific CTAs. Pages not listed get auth buttons only (no page CTA).
// bp = mobile breakpoint matching that page's hamburger media query.
const AUTH_CLUSTER_CONFIG = {
  '/diagnostic/': { label: 'Get Access — $49', href: '/?checkout=true', bp: 600 }
};
const AUTH_DEFAULT_BP = 640;

const S_LOGIN  = "font-family:-apple-system,system-ui,'Segoe UI',sans-serif;padding:6px 14px;" +
  "font-size:.8rem;font-weight:600;color:var(--text2);background:transparent;" +
  "border:1px solid var(--border);border-radius:6px;text-decoration:none;" +
  "white-space:nowrap;transition:all .2s";
const S_SIGNUP = "font-family:-apple-system,system-ui,'Segoe UI',sans-serif;padding:6px 14px;" +
  "font-size:.8rem;font-weight:700;color:var(--accent-text);background:transparent;" +
  "border:1px solid var(--accent-text);border-radius:6px;text-decoration:none;" +
  "white-space:nowrap;transition:all .2s";
const S_CTA    = "font-family:-apple-system,system-ui,'Segoe UI',sans-serif;padding:6px 14px;" +
  "font-size:.8rem;font-weight:600;color:#fff;background:var(--accent-btn);" +
  "border:1px solid var(--accent-btn);border-radius:6px;text-decoration:none;" +
  "white-space:nowrap;transition:background .2s";

function renderAuthCluster(ctaConfig, bp) {
  const breakpoint = bp || AUTH_DEFAULT_BP;
  const css = `.nav-auth-cluster{display:flex;align-items:center;gap:8px;flex-shrink:0}` +
              `@media(max-width:${breakpoint}px){.nav-auth-cluster{display:none}}`;
  const parts = [];
  if (ctaConfig) parts.push(`<a href="${ctaConfig.href}" style="${S_CTA}">${ctaConfig.label}</a>`);
  parts.push(`<a href="/?login=true" style="${S_LOGIN}">Log In</a>`);
  parts.push(`<a href="/?signup=true" style="${S_SIGNUP}">Sign Up Free</a>`);
  return `<style>${css}</style>\n    <div class="nav-auth-cluster">\n      ` +
         parts.join('\n      ') +
         `\n    </div>`;
}

function spliceAuthCluster(html, ctaConfig, bp) {
  const inner   = renderAuthCluster(ctaConfig, bp);
  const wrapped = `${AUTH_START}\n    ${inner}\n    ${AUTH_END}`;
  if (AUTH_RE.test(html)) return html.replace(AUTH_RE, wrapped);
  return html;
}

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
    { name: 'CCA Foundations Exam',  url: BASE + '/cca-foundations-exam/' }
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
    { name: 'CCA Practice Questions',   url: BASE + '/cca-practice-questions/' }
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
    { name: 'CCA Exam Guide', url: BASE + '/cca-exam-guide/' }
  ])
];

/** Schemas for /register */
const registerSchemas = [
  {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: 'Register for the CCA Exam',
    description: "Register for the CCA Foundations exam through Anthropic's official certification page; the exam is delivered via Pearson VUE. Review exam details, passing score, format, and cost before booking.",
    url: BASE + '/register/',
    isPartOf: { '@type': 'WebSite', name: schema.course.provider, url: BASE }
  }
  // BreadcrumbList removed: visible breadcrumb was removed from /register/ on 2026-06-23.
  // Keeping it orphaned in schema would mislead search engines — removed for consistency.
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
  // BreadcrumbList removed: /diagnostic/ has no visible breadcrumb — orphaned schema removed for consistency.
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
    { name: 'Study Plan Generator',  url: BASE + '/study-plan-generator/' }
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
    a: 'The CCA Foundations exam consists of 60 scenario-based multiple choice and multiple response questions with a 120-minute time limit, delivered as a proctored online exam.'
  },
  {
    q: 'What types of questions appear on the CCA Foundations exam?',
    a: "All questions are scenario-based — either multiple choice (one best answer) or multiple response (select all that apply). You're placed in a realistic situation and must choose the best architectural decision(s). There are no simple definition or recall questions, which is why hands-on practice matters more than memorizing terminology."
  },
  {
    q: 'What is the passing score for the CCA Foundations exam?',
    a: 'The CCA Foundations exam uses a scaled scoring system from 100 to 1,000. The passing score is 720 out of 1,000 — this is a scaled score, not the percentage of questions you answered correctly.'
  },
  {
    q: 'Is the CCA Foundations exam open-book?',
    a: 'No. The CCA Foundations exam is a proctored, closed-book assessment — you cannot reference documentation, notes, or external resources during the exam. This is why active recall practice, working through questions without looking up the answer first, is the most effective way to prepare.'
  },
  // TODO(cost-verify): standard fee ($125) and free-for-first-5,000-partner-employees
  // early-access terms should be periodically re-checked against Anthropic's
  // registration page — capacity and pricing can change. Last verified 2026-06-12.
  {
    q: 'How much does the CCA Foundations exam cost?',
    a: "The standard registration fee for the CCA Foundations exam is $125 (USD), paid directly to Anthropic when you schedule your session. Anthropic is also offering free registration to the first 5,000 employees at partner companies through an early-access program — verify current eligibility and pricing on Anthropic's official certification page before you book. Either way, it's worth taking our free 10-question diagnostic quiz first to see where you stand against the 720/1,000 passing standard."
  },
  {
    q: 'Where do I register for the official CCA Foundations exam?',
    a: "You register for the official CCA Foundations exam through Anthropic's official certification page. The exam is delivered via Pearson VUE (online proctored or at a Pearson VUE test centre). For an overview of exam requirements, see our registration guide at claudecertifiedarchitects.com/register/."
  },
  {
    q: 'How long is the CCA Foundations certification valid?',
    a: "The CCA Foundations certification is valid for 12 months from the date of passing. You must renew before your 12-month term expires; if it lapses, you must re-earn the certification. Check Anthropic's official exam policy for renewal details."
  },
  {
    q: 'Can I retake the CCA Foundations exam if I fail?',
    a: "Yes. Retake waiting periods and attempt limits are set by Anthropic and scheduled through Pearson VUE — check Anthropic's official exam policy and your Pearson VUE scheduling for current details. The most effective retake strategy is to use your score breakdown to find your weakest domain, spend most of your retake preparation there, and run one more full timed simulation before attempting again."
  },
  {
    q: 'What are the five CCA Foundations exam domains and how are they weighted?',
    a: 'The exam covers five domains, each weighted differently: Agentic Architecture (27%), Claude Code Configuration (20%), Prompt Engineering (20%), Tool Design & MCP (18%), and Context Management (15%). Agentic Architecture carries the most weight, so it deserves a proportionally larger share of your study time. Our CCA exam guide breaks down each domain in detail, and our blog covers each one individually, from Domain 1: Agentic Architecture & Orchestration (27%) through to Domain 5: Context Management & Reliability (15%).'
  },
  {
    q: 'Is the CCA Foundations certification worth it?',
    a: "For engineers and architects who build production applications with Claude, yes. The certification validates practical skills across agent design, configuration, prompt engineering, tool integration, and context management. Even if you don't need the credential itself, the preparation builds a working understanding of the architectural tradeoffs that come up constantly when building with Claude."
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
/** Schemas for /privacy/, /terms/, /refund/ */
const privacySchemas = [
  { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Privacy Policy',
    description: 'Privacy Policy for Claude Certified Architects.',
    url: BASE + '/privacy/', isPartOf: { '@type': 'WebSite', name: schema.course.provider, url: BASE } },
  // BreadcrumbList removed: /privacy/ has no visible breadcrumb — orphaned schema removed.
];
const termsSchemas = [
  { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Terms of Service',
    description: 'Terms of Service for Claude Certified Architects.',
    url: BASE + '/terms/', isPartOf: { '@type': 'WebSite', name: schema.course.provider, url: BASE } },
  // BreadcrumbList removed: /terms/ has no visible breadcrumb — orphaned schema removed.
];
const refundSchemas = [
  { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Refund Policy',
    description: 'Refund Policy for Claude Certified Architects — 10-day money-back guarantee.',
    url: BASE + '/refund/', isPartOf: { '@type': 'WebSite', name: schema.course.provider, url: BASE } },
  // BreadcrumbList removed: /refund/ has no visible breadcrumb — orphaned schema removed.
];

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
    { name: 'FAQ',  url: BASE + '/faq/' }
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

function processFile(filePath, activePage, ...schemas) {
  const rel   = path.relative(__dirname, filePath);
  const html  = fs.readFileSync(filePath, 'utf8');
  const block = renderBlock(...schemas);
  let out     = splice(html, block);
  out = spliceLogo(out);  // unconditional — homepage included if markers present
  if (activePage) out = spliceNav(out, renderNav(activePage));
  // Auth buttons are now inside nav-links (via renderNav). The old auth-cluster
  // markers in static pages are stripped by the Python clean-up step; this call
  // is intentionally removed so no new cluster is injected.
  out = spliceFooter(out, renderFooter(new Date().getFullYear()));
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
nav .logo{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:1rem;font-weight:600;color:var(--text);text-decoration:none;letter-spacing:-.3px;white-space:nowrap}
.nav-links{flex:1;display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.nav-links a{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;padding:5px 10px;border-radius:6px;font-size:.85rem;color:var(--text2);text-decoration:none;transition:all .2s;white-space:nowrap}
.nav-links a:hover{color:var(--text);background:rgba(0,0,0,.04)}
.nav-links a.active{color:var(--text);font-weight:600}
.nav-hamburger{display:none;flex-direction:column;justify-content:center;align-items:center;gap:5px;padding:6px;cursor:pointer;border:none;background:none;margin-left:auto;flex-shrink:0;min-width:44px;min-height:44px}
.nav-hamburger span{display:block;width:22px;height:2px;background:var(--text);border-radius:2px;transition:transform .25s,opacity .25s}
@media(max-width:640px){
  nav .inner{flex-wrap:nowrap}
  .nav-links{display:none !important;flex:none;position:absolute;top:100%;left:0;right:0;flex-direction:column;background:rgba(245,243,234,.97);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:12px 16px;gap:0;box-shadow:0 8px 24px rgba(0,0,0,.08)}
  .nav-links.open{display:flex !important}
  .nav-links a{padding:12px 16px;border-radius:6px;width:100%;text-align:left;white-space:normal;min-height:44px;display:flex;align-items:center}
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
    ${LOGO_START}${LOGO_HTML}${LOGO_END}
    <div class="nav-links" id="blog-nav-links">
      ${link('/', 'Home')}
      ${link('/cca-foundations-exam/', 'Exam')}
      ${link('/?hub=practice-tests', 'Practice Tests')}
      ${link('/cca-practice-questions/', 'Question Bank')}
      ${link('/cca-exam-guide/', 'Guide')}
      ${link('/diagnostic/', 'Diagnostic')}
      ${link('/study-plan-generator/', 'Study Plan')}
      ${link('/blog/', 'Blog')}
      ${link('/faq/', 'FAQ')}
      <a href="/register/" aria-label="Official Claude Certified Architect exam registration on Anthropic's site">Exam Info</a>
      <div id="nav-auth-static"><a href="/?login=true" class="nav-auth-login">Log In</a><a href="/?signup=true" class="nav-auth-signup">Sign Up Free</a></div>
      ${NAV_HINT_SCRIPT}
    </div>
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
  const links = FOOTER_NAV_PAGES
    .map(([href, label]) => `<a href="${href}">${label}</a>`)
    .join(' &nbsp;&middot;&nbsp; ');
  return `<footer class="site-footer">
<!-- cca:footer:start -->
  <p style="margin:0 0 6px">&copy; ${year} CCA Practice Platforms</p>
  <p style="margin:0 0 10px;font-size:.82rem">${links}</p>
  <p style="max-width:620px;margin:0 auto;font-size:.85rem;line-height:1.65;color:#c8c8be">CCA Practice Platforms is an independent exam-preparation resource. We are not affiliated with, endorsed by, sponsored by, or authorized by Anthropic, and this is not the official Claude Certified Architect exam or certification. 'Claude', 'Claude Certified Architect', and 'CCA' are trademarks of Anthropic, PBC, used here only to identify the exam our materials help you prepare for.</p>
  <p style="margin:8px 0 0;font-size:.82rem"><a href="/privacy/">Privacy Policy</a> &middot; <a href="/terms/">Terms of Service</a> &middot; <a href="/refund/">Refund Policy</a></p>
  <p style="margin:8px 0 0;font-size:.82rem">Questions? <a href="mailto:support@claudecertifiedarchitects.com">support@claudecertifiedarchitects.com</a></p>
<!-- cca:footer:end -->
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
<script>(function(w,d,s,i){w.dataLayer=w.dataLayer||[];function gtag(){w.dataLayer.push(arguments);}w.gtag=w.gtag||gtag;gtag('js',new Date());gtag('config',i);function gtagLoad(){var j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtag/js?id='+i;d.head.appendChild(j);}if(d.readyState==='complete'){gtagLoad();}else{w.addEventListener('load',gtagLoad);}})(window,document,'script','GT-K8FC4RXW');</script>
<!-- End Google tag (gtag.js) -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${escHtml(pageTitle(post.title))}</title>
<meta name="description" content="${escAttr(post.description)}">
<link rel="canonical" href="${BASE}/blog/${post.slug}/">
<meta property="og:type" content="article">
<meta property="og:title" content="${escAttr(post.title)}">
<meta property="og:description" content="${escAttr(post.description)}">
<meta property="og:url" content="${BASE}/blog/${post.slug}/">
<meta property="og:site_name" content="CCA Practice Platforms">
<meta property="og:image" content="${ogImg}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta property="article:published_time" content="${post.date}">
<meta property="article:modified_time" content="${post.updated || post.date}">
<meta property="article:section" content="CCA Exam Preparation">
<meta name="author" content="CCA Practice Platforms">
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
    { name: 'Blog', url: `${BASE}/blog/` }
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
<script>(function(w,d,s,i){w.dataLayer=w.dataLayer||[];function gtag(){w.dataLayer.push(arguments);}w.gtag=w.gtag||gtag;gtag('js',new Date());gtag('config',i);function gtagLoad(){var j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtag/js?id='+i;d.head.appendChild(j);}if(d.readyState==='complete'){gtagLoad();}else{w.addEventListener('load',gtagLoad);}})(window,document,'script','GT-K8FC4RXW');</script>
<!-- End Google tag (gtag.js) -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>CCA Blog | Claude Certified Architect Guides &amp; Study Tips</title>
<meta name="description" content="Guides on Claude architecture, prompt engineering, MCP, agentic systems, and passing the CCA Foundations exam on your first attempt.">
<link rel="canonical" href="${BASE}/blog/">
<meta property="og:type" content="website">
<meta property="og:title" content="CCA Blog | Claude Certified Architect Guides &amp; Study Tips">
<meta property="og:description" content="Articles and guides on Claude architecture, prompt engineering, MCP, and passing the CCA Foundations exam.">
<meta property="og:url" content="${BASE}/blog/">
<meta property="og:site_name" content="CCA Practice Platforms">
<meta property="og:image" content="${BASE}/og-image-v2.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta name="author" content="CCA Practice Platforms">
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
<script>(function(w,d,s,i){w.dataLayer=w.dataLayer||[];function gtag(){w.dataLayer.push(arguments);}w.gtag=w.gtag||gtag;gtag('js',new Date());gtag('config',i);function gtagLoad(){var j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtag/js?id='+i;d.head.appendChild(j);}if(d.readyState==='complete'){gtagLoad();}else{w.addEventListener('load',gtagLoad);}})(window,document,'script','GT-K8FC4RXW');</script>
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
    { loc: BASE + '/privacy/',                priority: '0.3', changefreq: 'yearly',  lastmod: gitLastmod('privacy/index.html') },
    { loc: BASE + '/terms/',                  priority: '0.3', changefreq: 'yearly',  lastmod: gitLastmod('terms/index.html') },
    { loc: BASE + '/refund/',                 priority: '0.3', changefreq: 'yearly',  lastmod: gitLastmod('refund/index.html') },
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
  console.log('✓ sitemap.xml  (' + today + ', ' + (11 + posts.length) + ' URLs)');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
console.log('Pre-rendering JSON-LD…\n');

processFile(path.join(__dirname, 'index.html'), null,
  organizationSchema, websiteSchema, courseSchema, faqSchema);

processFile(path.join(__dirname, 'cca-foundations-exam',   'index.html'), '/cca-foundations-exam/',
  ...examSchemas);

processFile(path.join(__dirname, 'cca-practice-questions',  'index.html'), '/cca-practice-questions/',
  ...questionsSchemas);

processFile(path.join(__dirname, 'cca-exam-guide',          'index.html'), '/cca-exam-guide/',
  ...guideSchemas);

processFile(path.join(__dirname, 'register',                'index.html'), '/register/',
  ...registerSchemas);

processFile(path.join(__dirname, 'diagnostic',              'index.html'), '/diagnostic/',
  ...diagnosticSchemas);

processFile(path.join(__dirname, 'study-plan-generator',    'index.html'), '/study-plan-generator/',
  ...studyPlanSchemas);

processFile(path.join(__dirname, 'faq',                     'index.html'), '/faq/',
  ...faqPageSchemas);

processFile(path.join(__dirname, 'privacy',                 'index.html'), '/privacy/',
  ...privacySchemas);

processFile(path.join(__dirname, 'terms',                   'index.html'), '/terms/',
  ...termsSchemas);

processFile(path.join(__dirname, 'refund',                  'index.html'), '/refund/',
  ...refundSchemas);


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
