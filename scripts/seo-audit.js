/**
 * Site-wide SEO audit: extracts title, meta description, canonical, meta
 * robots, H1(s), and OG/Twitter tags from every page in sitemap.xml, then
 * flags common issues (missing/duplicate titles & descriptions, length
 * limits, H1 count, canonical mismatches, noindex, missing social tags).
 *
 * Usage:
 *   node scripts/seo-audit.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = 'https://www.claudecertifiedarchitects.com';

const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);

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

function getMetaTags(html) {
  const tags = [...html.matchAll(/<meta\s+([^>]*)>/gi)].map(m => m[1]);
  return tags.map(attrs => {
    const nameM    = attrs.match(/(?:name|property)\s*=\s*(["'])(.*?)\1/i);
    const contentM = attrs.match(/content\s*=\s*(["'])(.*?)\1/i);
    return { key: nameM ? nameM[2] : null, content: contentM ? contentM[2] : null };
  });
}

function extract(html) {
  const titleM = html.match(/<title>([\s\S]*?)<\/title>/i);
  const title  = titleM ? decode(titleM[1]) : null;

  const meta = getMetaTags(html);
  const findMeta = key => {
    const m = meta.find(t => t.key && t.key.toLowerCase() === key.toLowerCase());
    return m ? decode(m.content) : null;
  };

  const canonicalM = html.match(/<link\s+[^>]*rel\s*=\s*["']canonical["'][^>]*>/i);
  let canonical = null;
  if (canonicalM) {
    const hrefM = canonicalM[0].match(/href\s*=\s*(["'])(.*?)\1/i);
    canonical = hrefM ? hrefM[2] : null;
  }

  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => decode(m[1].replace(/<[^>]+>/g, '')));

  return {
    title,
    description:  findMeta('description'),
    robots:       findMeta('robots'),
    canonical,
    h1s,
    og: {
      title:       findMeta('og:title'),
      description: findMeta('og:description'),
      url:         findMeta('og:url'),
      image:       findMeta('og:image'),
      type:        findMeta('og:type'),
    },
    twitter: {
      card:        findMeta('twitter:card'),
      title:       findMeta('twitter:title'),
      description: findMeta('twitter:description'),
      image:       findMeta('twitter:image'),
    },
  };
}

const pages = urls.map(url => {
  const u = new URL(url);
  const filePath = path.join(ROOT, u.pathname.replace(/^\//, ''), 'index.html');
  const html = fs.readFileSync(filePath, 'utf8');
  return { url, path: u.pathname, file: path.relative(ROOT, filePath), ...extract(html) };
});

// ── Tabulate ─────────────────────────────────────────────────────────────
console.log('='.repeat(100));
console.log('PAGE-BY-PAGE TABLE');
console.log('='.repeat(100));
pages.forEach(p => {
  console.log(`\n${p.url}`);
  console.log(`  file:        ${p.file}`);
  console.log(`  title (${(p.title||'').length}):  ${p.title}`);
  console.log(`  desc  (${(p.description||'').length}):  ${p.description}`);
  console.log(`  canonical:   ${p.canonical}`);
  console.log(`  robots:      ${p.robots || '(none)'}`);
  console.log(`  H1 (${p.h1s.length}):       ${JSON.stringify(p.h1s)}`);
  console.log(`  og:title:    ${p.og.title}`);
  console.log(`  og:desc:     ${p.og.description}`);
  console.log(`  og:url:      ${p.og.url}`);
  console.log(`  og:image:    ${p.og.image}`);
  console.log(`  og:type:     ${p.og.type}`);
  console.log(`  tw:card:     ${p.twitter.card}`);
  console.log(`  tw:title:    ${p.twitter.title}`);
  console.log(`  tw:desc:     ${p.twitter.description}`);
  console.log(`  tw:image:    ${p.twitter.image}`);
});

// ── Flag issues ──────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(100));
console.log('ISSUES');
console.log('='.repeat(100));

const issues = [];
function flag(page, msg) { issues.push({ url: page.url, msg }); }

// Duplicates
const titleMap = new Map();
const descMap  = new Map();
pages.forEach(p => {
  if (p.title) {
    if (!titleMap.has(p.title)) titleMap.set(p.title, []);
    titleMap.get(p.title).push(p.url);
  }
  if (p.description) {
    if (!descMap.has(p.description)) descMap.set(p.description, []);
    descMap.get(p.description).push(p.url);
  }
});

pages.forEach(p => {
  // Title
  if (!p.title) flag(p, 'Missing <title>');
  else if (p.title.length > 60) flag(p, `Title too long (${p.title.length} chars > 60): "${p.title}"`);

  // Description
  if (!p.description) flag(p, 'Missing meta description');
  else if (p.description.length > 155) flag(p, `Description too long (${p.description.length} chars > 155): "${p.description}"`);

  // H1
  if (p.h1s.length === 0) flag(p, 'Zero H1 elements');
  else if (p.h1s.length > 1) flag(p, `Multiple H1 elements (${p.h1s.length}): ${JSON.stringify(p.h1s)}`);

  // Canonical
  const expectedCanonical = `${BASE}${p.path}`;
  if (!p.canonical) flag(p, 'Missing canonical link');
  else if (p.canonical !== expectedCanonical) flag(p, `Canonical mismatch: "${p.canonical}" !== expected "${expectedCanonical}"`);

  // Robots
  if (p.robots && /noindex/i.test(p.robots)) flag(p, `Stray noindex in meta robots: "${p.robots}"`);

  // OG tags
  if (!p.og.title) flag(p, 'Missing og:title');
  if (!p.og.description) flag(p, 'Missing og:description');
  if (!p.og.url) flag(p, 'Missing og:url');
  else if (p.og.url !== expectedCanonical) flag(p, `og:url mismatch: "${p.og.url}" !== expected "${expectedCanonical}"`);
  if (!p.og.image) flag(p, 'Missing og:image');
  if (!p.og.type) flag(p, 'Missing og:type');

  // Twitter tags
  if (!p.twitter.card) flag(p, 'Missing twitter:card');
  if (!p.twitter.title) flag(p, 'Missing twitter:title');
  if (!p.twitter.description) flag(p, 'Missing twitter:description');
  if (!p.twitter.image) flag(p, 'Missing twitter:image');
});

// Duplicate titles/descriptions across pages
for (const [title, urlsWith] of titleMap) {
  if (urlsWith.length > 1) issues.push({ url: urlsWith.join(', '), msg: `Duplicate title across ${urlsWith.length} pages: "${title}"` });
}
for (const [desc, urlsWith] of descMap) {
  if (urlsWith.length > 1) issues.push({ url: urlsWith.join(', '), msg: `Duplicate description across ${urlsWith.length} pages: "${desc}"` });
}

if (issues.length === 0) {
  console.log('\n(none found)');
} else {
  issues.forEach(i => console.log(`\n[${i.url}]\n  ${i.msg}`));
}

console.log(`\n\nTOTAL: ${pages.length} pages, ${issues.length} issue(s) flagged.`);
