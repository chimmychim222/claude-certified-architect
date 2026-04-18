/**
 * build.js — Pre-render static JSON-LD into all HTML pages.
 *
 * Reads schema.json and inlines structured data as static <script> tags so
 * Googlebot sees them without executing JavaScript.
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
    url: BASE + '/cca-foundations-exam',
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
    url: BASE + '/cca-practice-questions',
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
    headline: 'CCA Exam Guide — How to Pass the Claude Certified Architect Exam',
    description: 'Complete guide to the CCA Foundations exam format, domains, scoring, and study strategies.',
    url: BASE + '/cca-exam-guide',
    publisher: { '@type': 'Organization', name: 'Claude Certified Architects', url: BASE },
    isPartOf: { '@type': 'WebSite', url: BASE }
  },
  breadcrumb([
    { name: 'Home',          url: BASE },
    { name: 'CCA Exam Guide', url: BASE + '/cca-exam-guide' }
  ])
];

// ---------------------------------------------------------------------------
// Helpers
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

console.log('\nDone. Commit and push the updated HTML files.');
