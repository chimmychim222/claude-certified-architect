const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const POSTS_DIR = path.join(__dirname, '..', 'posts');

function loadExistingPosts() {
  return fs.readdirSync(POSTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(POSTS_DIR, f), 'utf8'));
      return { slug: data.slug, title: data.title };
    });
}

function todayDate() {
  return new Date().toISOString(); // full timestamp so same-day posts sort by exact publish time
}

async function generatePost() {
  const existing = loadExistingPosts();
  const existingTitles = existing.map(p => `- ${p.title} (slug: ${p.slug})`).join('\n');
  const existingSlugs = new Set(existing.map(p => p.slug));
  const today = todayDate();

  const topicContext = `Existing posts (do NOT duplicate — pick a fresh angle):
${existingTitles}

High-value topic areas (pick the one that best fills a gap):
- CCA exam preparation tactics: study schedules, domain-specific weak spots, exam-day strategy
- Technical deep-dives: designing MCP servers, the CALM/PRECISE/SPIDER frameworks in detail
- Common failure patterns: mistakes architects make when building production Claude systems
- Career and market: CCA in specific industries (legal, healthcare, finance), team certification strategy
- Comparison topics: agentic vs non-agentic architectures, CCA vs other AI credentials
- Practical tutorials: writing effective CLAUDE.md files, scoping tools correctly, multi-agent orchestration`;

  // ── Step 1: metadata only (small JSON, no HTML) ──────────────────────────
  console.log('Step 1: Generating post metadata...');
  const metaMsg = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 400,
    system: `You choose the topic for a new blog post on claudecertifiedarchitects.com.

Return ONLY a raw JSON object — no markdown fences, no explanation — with exactly these four fields:
  title       — string, max 60 chars, SEO-friendly
  description — string, max 155 chars, complete sentence (no ellipsis), includes relevant keywords
  slug        — string, lowercase, hyphens only, URL-safe
  h1          — string, same as or a slightly longer version of title`,
    messages: [{ role: 'user', content: topicContext }],
  });

  const metaRaw = metaMsg.content[0].text.trim();
  const mf = metaRaw.indexOf('{');
  const ml = metaRaw.lastIndexOf('}');
  if (mf === -1 || ml === -1) {
    console.error('No JSON in metadata response:\n' + metaRaw);
    process.exit(1);
  }

  let meta;
  try {
    meta = JSON.parse(metaRaw.slice(mf, ml + 1));
  } catch (e) {
    console.error('Metadata JSON parse failed:\n' + metaRaw);
    process.exit(1);
  }
  console.log('  Topic: ' + meta.title);

  // ── Step 2: body as plain HTML text (no JSON encoding issues) ─────────────
  console.log('Step 2: Generating post body...');
  const bodyMsg = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 8192,
    system: `You are a technical content writer for claudecertifiedarchitects.com, a CCA exam prep platform.

Rules:
- Write in British/international English
- Use <h2>, <h3>, <p>, <ul>, <li>, <strong> HTML tags only — no <html>, <head>, <body> wrapper
- Write 1500–2500 words
- Be practical and specific — no vague generalities
- End with a call-to-action paragraph that links to /cca-practice-questions, /cca-foundations-exam, or /cca-exam-guide (use these exact href paths)
- Output ONLY the HTML body content — no JSON, no markdown fences, no title heading, no preamble`,
    messages: [{
      role: 'user',
      content: `Write the full HTML body content for this blog post:

Title: ${meta.title}
Description: ${meta.description}

Target audience: people preparing for the CCA Foundations exam or considering getting certified.`,
    }],
  });

  const body = bodyMsg.content[0].text.trim();
  console.log('  Body: ' + body.length + ' chars');

  // ── Validate and normalise ────────────────────────────────────────────────
  if (meta.description.length > 160) {
    console.warn('Description too long (' + meta.description.length + ' chars) — truncating.');
    meta.description = meta.description.slice(0, 157).replace(/[,;:\s]+$/, '') + '...';
  }

  if (existingSlugs.has(meta.slug)) {
    const fallback = meta.slug + '-' + today.slice(0, 7);
    console.warn('Slug "' + meta.slug + '" exists — using "' + fallback + '".');
    meta.slug = fallback;
  }

  // ── Write file using JSON.stringify (handles all escaping correctly) ───────
  const post = {
    title:       meta.title,
    description: meta.description,
    date:        today,
    slug:        meta.slug,
    ogImage:     '/og-image-v2.png',
    body:        body,
    h1:          meta.h1 || meta.title,
  };

  const filename = post.slug + '.json';
  const filepath = path.join(POSTS_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(post, null, 2), 'utf8');

  console.log('✓ Saved: posts/' + filename);
  console.log('  Title: ' + post.title);
  console.log('  Description (' + post.description.length + ' chars): ' + post.description);
  console.log('  Slug: ' + post.slug);
}

generatePost().catch(err => {
  console.error('Error: ' + err.message);
  process.exit(1);
});
