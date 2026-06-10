/**
 * Site-wide JSON-LD audit: extracts every <script type="application/ld+json">
 * block from every page in sitemap.xml, validates JSON syntax, checks
 * required properties for each schema.org @type, cross-references values
 * against visible page content (title/H1/canonical/meta), and flags any
 * Review/AggregateRating markup.
 *
 * Usage:
 *   node scripts/jsonld-audit.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = 'https://www.claudecertifiedarchitects.com';

const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);

const issues = [];
function flag(url, msg) { issues.push({ url, msg }); }

// Required properties per @type (minimal set per Google's structured-data
// guidelines / schema.org "required" fields for the relevant rich results).
const REQUIRED = {
  Organization:   ['name', 'url'],
  WebSite:        ['name', 'url'],
  Course:         ['name', 'description', 'provider'],
  Offer:          ['price', 'priceCurrency'],
  FAQPage:        ['mainEntity'],
  Question:       ['name', 'acceptedAnswer'],
  Answer:         ['text'],
  Article:        ['headline', 'datePublished', 'author', 'publisher', 'image'],
  BreadcrumbList: ['itemListElement'],
  ListItem:       ['position', 'name', 'item'],
  WebPage:        ['name', 'description', 'url'],
};

function checkRequired(url, obj, label) {
  const type = obj['@type'];
  const req = REQUIRED[type];
  if (!req) return;
  for (const prop of req) {
    if (obj[prop] === undefined || obj[prop] === null || obj[prop] === '') {
      flag(url, `${label} (${type}) missing required property "${prop}"`);
    }
  }
  // Recurse into nested typed objects
  for (const [key, val] of Object.entries(obj)) {
    if (key === '@type' || key === '@context') continue;
    if (val && typeof val === 'object' && !Array.isArray(val) && val['@type']) {
      checkRequired(url, val, `${label}.${key}`);
    }
    if (Array.isArray(val)) {
      val.forEach((item, i) => {
        if (item && typeof item === 'object' && item['@type']) {
          checkRequired(url, item, `${label}.${key}[${i}]`);
        }
      });
    }
  }
}

function decode(s) {
  return (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

console.log('='.repeat(100));
console.log('PAGE-BY-PAGE JSON-LD INVENTORY');
console.log('='.repeat(100));

const pages = urls.map(url => {
  const u = new URL(url);
  const filePath = path.join(ROOT, u.pathname.replace(/^\//, ''), 'index.html');
  const html = fs.readFileSync(filePath, 'utf8');

  const titleM = html.match(/<title>([\s\S]*?)<\/title>/i);
  const title  = titleM ? decode(titleM[1]) : null;
  const h1s    = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => decode(m[1].replace(/<[^>]+>/g, '')));
  const canonicalM = html.match(/<link\s+[^>]*rel\s*=\s*["']canonical["'][^>]*>/i);
  let canonical = null;
  if (canonicalM) {
    const hrefM = canonicalM[0].match(/href\s*=\s*(["'])(.*?)\1/i);
    canonical = hrefM ? hrefM[2] : null;
  }

  const blockMatches = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  const blocks = blockMatches.map(m => m[1]);

  const parsed = blocks.map((b, i) => {
    try {
      return { ok: true, obj: JSON.parse(b) };
    } catch (e) {
      flag(url, `Block ${i}: INVALID JSON — ${e.message}`);
      return { ok: false, raw: b };
    }
  });

  console.log(`\n${url}`);
  console.log(`  file:      ${path.relative(ROOT, filePath)}`);
  console.log(`  title:     ${title}`);
  console.log(`  H1:        ${JSON.stringify(h1s)}`);
  console.log(`  canonical: ${canonical}`);
  console.log(`  JSON-LD blocks: ${blocks.length}`);
  parsed.forEach((p, i) => {
    if (p.ok) {
      console.log(`    [${i}] @type: ${p.obj['@type']}`);
    } else {
      console.log(`    [${i}] INVALID JSON`);
    }
  });

  return { url, path: u.pathname, file: path.relative(ROOT, filePath), title, h1s, canonical, parsed };
});

// ── Validate ─────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(100));
console.log('VALIDATION');
console.log('='.repeat(100));

pages.forEach(p => {
  const types = p.parsed.filter(x => x.ok).map(x => x.obj['@type']);

  // 1. @context check + required-property check for every block
  p.parsed.forEach((x, i) => {
    if (!x.ok) return;
    const obj = x.obj;
    if (obj['@context'] !== 'https://schema.org') {
      flag(p.url, `Block ${i} (${obj['@type']}): @context is "${obj['@context']}", expected "https://schema.org"`);
    }
    if (!obj['@type']) {
      flag(p.url, `Block ${i}: missing @type`);
    }
    checkRequired(p.url, obj, `Block ${i}`);
  });

  // 2. Review / AggregateRating anywhere
  p.parsed.forEach((x, i) => {
    if (!x.ok) return;
    const json = JSON.stringify(x.obj);
    if (/"@type"\s*:\s*"(Review|AggregateRating)"/.test(json) || /"aggregateRating"|"review"\s*:/i.test(json)) {
      flag(p.url, `Block ${i}: contains Review/AggregateRating markup (not backed by real reviews)`);
    }
  });

  // 3. BreadcrumbList: last item should point to this page's canonical URL
  p.parsed.forEach((x, i) => {
    if (!x.ok || x.obj['@type'] !== 'BreadcrumbList') return;
    const items = x.obj.itemListElement || [];
    if (items.length === 0) {
      flag(p.url, `Block ${i} (BreadcrumbList): empty itemListElement`);
      return;
    }
    // positions should be sequential starting at 1
    items.forEach((item, idx) => {
      if (item.position !== idx + 1) {
        flag(p.url, `Block ${i} (BreadcrumbList): item ${idx} has position ${item.position}, expected ${idx + 1}`);
      }
    });
    const last = items[items.length - 1];
    const expected = p.canonical;
    // Accept with or without trailing slash for the last crumb
    const norm = s => (s || '').replace(/\/$/, '');
    if (expected && norm(last.item) !== norm(expected)) {
      flag(p.url, `Block ${i} (BreadcrumbList): last item URL "${last.item}" does not match page canonical "${expected}"`);
    }
  });

  // 4. Article: headline/description/url/image should match visible content
  p.parsed.forEach((x, i) => {
    if (!x.ok || x.obj['@type'] !== 'Article') return;
    const a = x.obj;
    if (a.url !== p.canonical) {
      flag(p.url, `Block ${i} (Article): url "${a.url}" !== canonical "${p.canonical}"`);
    }
    if (!p.h1s.includes(a.headline) && p.title !== a.headline) {
      // headline should correspond to either the H1 or the <title> base
      flag(p.url, `Block ${i} (Article): headline "${a.headline}" matches neither H1 ${JSON.stringify(p.h1s)} nor <title> "${p.title}"`);
    }
    if (!a.datePublished || !/^\d{4}-\d{2}-\d{2}/.test(a.datePublished)) {
      flag(p.url, `Block ${i} (Article): datePublished "${a.datePublished}" is not a valid ISO date`);
    }
  });

  // 5. WebPage: url should match canonical
  p.parsed.forEach((x, i) => {
    if (!x.ok || x.obj['@type'] !== 'WebPage') return;
    const w = x.obj;
    const norm = s => (s || '').replace(/\/$/, '');
    if (norm(w.url) !== norm(p.canonical)) {
      flag(p.url, `Block ${i} (WebPage): url "${w.url}" !== canonical "${p.canonical}"`);
    }
  });

  // 6. Type-coverage check by page role
  if (p.path === '/') {
    if (!types.includes('Organization')) flag(p.url, 'Homepage missing Organization schema');
    if (!types.includes('WebSite'))      flag(p.url, 'Homepage missing WebSite schema');
    if (!types.includes('Course'))       flag(p.url, 'Homepage missing Course schema');
    if (!types.includes('FAQPage'))      flag(p.url, 'Homepage missing FAQPage schema');
  }
  if (p.path.startsWith('/blog/') && p.path !== '/blog/') {
    if (!types.includes('Article')) flag(p.url, 'Blog post missing Article schema');
    if (!types.includes('BreadcrumbList')) flag(p.url, 'Blog post missing BreadcrumbList schema');
  }
  if (p.path !== '/' && !types.includes('BreadcrumbList')) {
    flag(p.url, `Page below homepage has no BreadcrumbList schema (types: ${JSON.stringify(types)})`);
  }
});

// ── Report ───────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(100));
console.log('ISSUES');
console.log('='.repeat(100));

if (issues.length === 0) {
  console.log('\n(none found)');
} else {
  issues.forEach(i => console.log(`\n[${i.url}]\n  ${i.msg}`));
}

console.log(`\n\nTOTAL: ${pages.length} pages, ${issues.length} issue(s) flagged.`);
