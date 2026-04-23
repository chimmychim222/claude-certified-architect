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

/** Course + AggregateRating (for homepage) */
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
  inLanguage: schema.course.inLanguage,
  aggregateRating: {
    '@type': 'AggregateRating',
    ratingValue: schema.rating.ratingValue,
    reviewCount: schema.rating.reviewCount,
    bestRating: schema.rating.bestRating,
    worstRating: schema.rating.worstRating
  }
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
    name: 'CCA Foundations Exam Practice | Claude Certified Architect',
    description: 'Full-length CCA Foundations exam simulation with 60 timed, domain-weighted questions. Mirrors the official Claude Certified Architect certification format.',
    url: BASE + '/cca-foundations-exam/',
    isPartOf: { '@type': 'WebSite', url: BASE }
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
    name: 'CCA Practice Questions | 300 Scenario-Based Exam Prep',
    description: '300 scenario-based practice questions covering all 5 CCA Foundations exam domains with detailed explanations and domain-weighted scoring.',
    url: BASE + '/cca-practice-questions/',
    isPartOf: { '@type': 'WebSite', url: BASE }
  },
  breadcrumb([
    { name: 'Home',                     url: BASE },
    { name: 'CCA Practice Questions',   url: BASE + '/cca-practice-questions' }
  ])
];

/** Schemas for /cca-exam-guide */
const guideSchemas = [
  {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: 'CCA Exam Guide \u2014 How to Pass the Claude Certified Architect Exam',
    description: 'Complete guide to the CCA Foundations exam format, domains, scoring, and study strategies.',
    url: BASE + '/cca-exam-guide/',
    publisher: { '@type': 'Organization', name: 'Claude Certified Architects', url: BASE },
    isPartOf: { '@type': 'WebSite', url: BASE }
  },
  breadcrumb([
    { name: 'Home',          url: BASE },
    { name: 'CCA Exam Guide', url: BASE + '/cca-exam-guide' }
  ])
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

/** Format an ISO date string (YYYY-MM-DD) to a human-readable date */
function formatDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
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

/** Inline CSS shared by all blog pages */
function sharedCSS() {
  return `<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f5f3ea;--surface:#fff;--border:#d9d5ca;
  --text:#191918;--text2:#5a5a52;--text3:#8a8a7f;
  --accent:#d97757;--accent2:#c4623f;--accent3:#a8502f;
  --radius:8px;
}
html{scroll-behavior:smooth}
body{font-family:Georgia,'Times New Roman',serif;background:var(--bg);color:var(--text);line-height:1.7;overflow-x:hidden;min-height:100vh}
a{color:var(--accent);text-decoration:underline;text-underline-offset:3px;transition:color .2s}
a:hover{color:var(--accent3)}

/* ── Nav ── */
nav{position:fixed;top:0;left:0;right:0;z-index:100;background:rgba(245,243,234,.92);backdrop-filter:blur(12px);border-bottom:1px solid var(--border)}
nav .inner{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;max-width:1100px;margin:0 auto;gap:12px}
.nav-logo{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:1rem;font-weight:600;color:var(--text);text-decoration:none;letter-spacing:-.3px;white-space:nowrap}
.nav-logo span{color:var(--text3);font-weight:400;font-size:.82rem;margin-left:6px}
.nav-links{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.nav-links a{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;padding:8px 14px;border-radius:6px;font-size:.88rem;color:var(--text2);text-decoration:none;transition:all .2s;white-space:nowrap}
.nav-links a:hover{color:var(--text);background:rgba(0,0,0,.04)}
.nav-links a.active{color:var(--text);font-weight:600}
.nav-cta{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;background:var(--accent);color:#fff !important;padding:8px 18px;border-radius:6px;font-size:.88rem;font-weight:600;text-decoration:none !important;transition:background .2s;white-space:nowrap}
.nav-cta:hover{background:var(--accent2) !important}
.nav-hamburger{display:none;flex-direction:column;justify-content:center;gap:5px;padding:6px;cursor:pointer;border:none;background:none;margin-left:auto;flex-shrink:0}
.nav-hamburger span{display:block;width:22px;height:2px;background:var(--text);border-radius:2px;transition:transform .25s,opacity .25s}
@media(max-width:660px){
  nav .inner{flex-wrap:nowrap}
  .nav-links{display:none !important;position:absolute;top:100%;left:0;right:0;flex-direction:column;background:rgba(245,243,234,.97);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:12px 16px;gap:0;box-shadow:0 8px 24px rgba(0,0,0,.08)}
  .nav-links.open{display:flex !important}
  .nav-links a{padding:12px 16px;border-radius:6px;width:100%;text-align:left;white-space:normal}
  .nav-cta{display:none !important}
  .nav-hamburger{display:flex !important}
}

/* ── Post page ── */
.post-wrap{max-width:720px;margin:0 auto;padding:86px clamp(1.5rem,4vw,2.5rem) 80px}
.back-link{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.88rem;color:var(--text3);text-decoration:none;display:inline-block;margin-bottom:24px;transition:color .2s}
.back-link:hover{color:var(--accent)}
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
.post-body table{width:100%;border-collapse:collapse;margin:1.5em 0;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.9rem}
.post-body th{text-align:left;padding:10px 14px;border-bottom:2px solid var(--border);font-weight:600;color:var(--text)}
.post-body td{padding:10px 14px;border-bottom:1px solid var(--border);color:var(--text2)}

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
.post-card-title a:hover{color:var(--accent)}
.post-card-desc{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;color:var(--text2);font-size:.93rem;line-height:1.55}
.empty-state{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;color:var(--text3);padding:40px 0}

/* ── Breadcrumb ── */
.bc{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.82rem;padding:10px 0 4px}
.bc ol{list-style:none;display:flex;align-items:center;gap:0;padding:0;margin:0}
.bc li{display:flex;align-items:center}
.bc li+li::before{content:"\u203A";padding:0 6px;color:var(--text3);font-size:.9em}
.bc a{color:var(--text3);text-decoration:none;transition:color .2s}
.bc a:hover{color:var(--accent)}
.bc [aria-current]{color:var(--text2);font-weight:500}

/* ── Footer ── */
.site-footer{background:#191918;color:#8a8a7f;padding:28px 24px;text-align:center;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.82rem;line-height:1.6}
.site-footer a{color:#8a8a7f;text-underline-offset:3px}
.site-footer a:hover{color:#f5f3ea}
</style>`;
}

/** Shared nav HTML */
function blogNav(activePage) {
  const link = (href, label) => {
    const cls = activePage === href ? ' class="active"' : '';
    return `<a href="${href}"${cls}>${label}</a>`;
  };
  return `<nav>
  <div class="inner">
    <a href="/" class="nav-logo">CCA <span>Practice Platform</span></a>
    <div class="nav-links" id="blog-nav-links">
      ${link('/cca-practice-questions', 'Practice')}
      ${link('/cca-foundations-exam', 'Exam Sim')}
      ${link('/cca-exam-guide', 'Guide')}
      ${link('/blog', 'Blog')}
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
  return `<footer class="site-footer">
  <p>&copy; ${year} Claude Certified Architects &nbsp;&middot;&nbsp;
     <a href="/">Home</a> &nbsp;&middot;&nbsp;
     <a href="/blog">Blog</a> &nbsp;&middot;&nbsp;
     For educational purposes only. Not affiliated with Anthropic.</p>
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
    headline: post.title,
    description: post.description,
    url: `${BASE}/blog/${post.slug}`,
    datePublished: post.date,
    dateModified: post.date,
    image: img,
    publisher: { '@type': 'Organization', name: 'Claude Certified Architects', url: BASE },
    author:    { '@type': 'Organization', name: 'Claude Certified Architects', url: BASE },
    isPartOf:  { '@type': 'WebSite', url: BASE }
  };
}

/** Generate one blog post page → blog/<slug>/index.html */
function generateBlogPost(post) {
  const ogImg = post.ogImage
    ? (post.ogImage.startsWith('http') ? post.ogImage : BASE + post.ogImage)
    : BASE + '/og-image-v2.png';

  const schemas = [articleJsonLd(post), breadcrumb([
    { name: 'Home', url: BASE },
    { name: 'Blog', url: `${BASE}/blog` },
    { name: post.title, url: `${BASE}/blog/${post.slug}` }
  ])].map(s => `<script type="application/ld+json">${JSON.stringify(s)}</script>`).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GT-K8FC4RXW');</script>
<!-- End Google Tag Manager -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${escHtml(post.title)} | Claude Certified Architects</title>
<meta name="description" content="${escAttr(post.description)}">
<link rel="canonical" href="${BASE}/blog/${post.slug}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escAttr(post.title)}">
<meta property="og:description" content="${escAttr(post.description)}">
<meta property="og:url" content="${BASE}/blog/${post.slug}">
<meta property="og:site_name" content="Claude Certified Architects">
<meta property="og:image" content="${ogImg}">
<meta property="article:published_time" content="${post.date}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escAttr(post.title)}">
<meta name="twitter:description" content="${escAttr(post.description)}">
<meta name="twitter:image" content="${ogImg}">
${schemas}
${sharedCSS()}
</head>
<body>
<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GT-K8FC4RXW" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->
${blogNav('/blog')}
<main class="post-wrap">
  <article>
    <header>
      <div class="bc" role="navigation" aria-label="Breadcrumb">
        <ol>
          <li><a href="/">Home</a></li>
          <li><a href="/blog">Blog</a></li>
          <li><span aria-current="page">${escHtml(post.h1 || post.title)}</span></li>
        </ol>
      </div>
      <h1 class="post-title">${escHtml(post.h1 || post.title)}</h1>
      <p class="post-meta"><time datetime="${post.date}">${formatDate(post.date)}</time></p>
    </header>
    <div class="post-body">
      ${post.body}
    </div>
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
      <div class="post-card-title"><a href="/blog/${p.slug}">${escHtml(p.title)}</a></div>
      <p class="post-card-desc">${escHtml(p.description)}</p>
    </div>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GT-K8FC4RXW');</script>
<!-- End Google Tag Manager -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Blog | Claude Certified Architects</title>
<meta name="description" content="Articles and guides on Claude architecture, prompt engineering, MCP, and passing the CCA Foundations exam.">
<link rel="canonical" href="${BASE}/blog">
<meta property="og:type" content="website">
<meta property="og:title" content="Blog | Claude Certified Architects">
<meta property="og:description" content="Articles and guides on Claude architecture, prompt engineering, MCP, and passing the CCA Foundations exam.">
<meta property="og:url" content="${BASE}/blog">
<meta property="og:site_name" content="Claude Certified Architects">
<meta property="og:image" content="${BASE}/og-image-v2.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Blog | Claude Certified Architects">
<meta name="twitter:description" content="Articles and guides on Claude architecture, prompt engineering, MCP, and passing the CCA Foundations exam.">
<meta name="twitter:image" content="${BASE}/og-image-v2.png">
${schemas}
${sharedCSS()}
</head>
<body>
<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GT-K8FC4RXW" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->
${blogNav('/blog')}
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
// Sitemap generator
// ---------------------------------------------------------------------------

function generateSitemap(posts = []) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const pages = [
    { loc: BASE + '/',                         priority: '1.0', changefreq: 'weekly',  lastmod: today },
    { loc: BASE + '/cca-foundations-exam/',     priority: '0.9', changefreq: 'weekly',  lastmod: today },
    { loc: BASE + '/cca-practice-questions/',   priority: '0.9', changefreq: 'weekly',  lastmod: today },
    { loc: BASE + '/cca-exam-guide/',           priority: '0.8', changefreq: 'monthly', lastmod: today },
    { loc: BASE + '/blog/',                     priority: '0.7', changefreq: 'weekly',  lastmod: today },
    ...posts.map(p => ({
      loc:        `${BASE}/blog/${p.slug}/`,
      priority:   '0.8',
      changefreq: 'monthly',
      lastmod:    p.date
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
  console.log('✓ sitemap.xml  (' + today + ', ' + (5 + posts.length) + ' URLs)');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
console.log('Pre-rendering JSON-LD…\n');

processFile(path.join(__dirname, 'index.html'),
  courseSchema, faqSchema);

processFile(path.join(__dirname, 'cca-foundations-exam',  'index.html'),
  ...examSchemas);

processFile(path.join(__dirname, 'cca-practice-questions', 'index.html'),
  ...questionsSchemas);

processFile(path.join(__dirname, 'cca-exam-guide',         'index.html'),
  ...guideSchemas);

console.log('\nBuilding blog…\n');

const posts = loadPosts();
generateBlogIndex(posts);
posts.forEach(generateBlogPost);

console.log('');
generateSitemap(posts);

console.log('\nDone. Commit and push the updated HTML files.');
