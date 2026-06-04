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
  return new Date().toISOString().slice(0, 10);
}

async function generatePost() {
  const existing = loadExistingPosts();
  const existingTitles = existing.map(p => `- ${p.title} (slug: ${p.slug})`).join('\n');
  const existingSlugs = new Set(existing.map(p => p.slug));

  const today = todayDate();

  const systemPrompt = `You are a technical content writer for claudecertifiedarchitects.com, a CCA (Claude Certified Architect) exam preparation platform.

Write blog posts that:
- Target people preparing for the CCA Foundations exam or deciding whether to get certified
- Cover technical topics: agentic architecture, prompt engineering, MCP, tool design, context management, Claude Code
- Are well-structured with HTML body content using <h2>, <h3>, <p>, <ul>, <li>, <strong> tags
- Include practical, specific, actionable content — not vague generalities
- Are approximately 1500–2500 words of body content
- End with a call-to-action paragraph linking to /cca-practice-questions, /cca-foundations-exam, or /cca-exam-guide using absolute-path href attributes
- Use British/international English spelling

Output ONLY valid JSON matching this exact schema (no markdown fences, no explanation):
{
  "title": "string — max 60 chars, compelling, SEO-friendly",
  "description": "string — max 160 chars, includes relevant keywords",
  "date": "${today}",
  "slug": "string — lowercase, hyphens only, unique, descriptive",
  "ogImage": "/og-image-v2.png",
  "body": "string — HTML content",
  "h1": "string — same as or a slightly longer variant of title"
}`;

  const userPrompt = `Generate a new blog post for claudecertifiedarchitects.com.

Existing posts (do NOT duplicate these topics — pick a fresh angle):
${existingTitles}

High-value topic areas to choose from (pick the one that best fills a gap in the existing content):
- CCA exam preparation tactics: study schedules, domain-specific weak spots, exam-day strategy
- Technical deep-dives: designing MCP servers, the CALM/PRECISE/SPIDER frameworks in detail
- Common failure patterns: mistakes architects make when building production Claude systems
- Career and market: CCA in specific industries (legal, healthcare, finance), team certification strategy
- Comparison topics: agentic vs non-agentic architectures, CCA vs other AI credentials
- Practical tutorials: writing effective CLAUDE.md files, scoping tools correctly, multi-agent orchestration

Output only the JSON object. No markdown code fences, no preamble, just the raw JSON.`;

  console.log('Calling Claude API to generate blog post...');

  const message = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = message.content[0].text.trim();

  // Extract JSON by finding the outermost { ... } — works regardless of markdown fences
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) {
    console.error('No JSON object found in Claude response:');
    console.error(raw.slice(0, 500));
    process.exit(1);
  }
  const jsonStr = raw.slice(firstBrace, lastBrace + 1);

  let post;
  try {
    post = JSON.parse(jsonStr);
  } catch (e) {
    console.error('Failed to parse JSON from Claude response:');
    console.error(raw.slice(0, 500));
    process.exit(1);
  }

  // Validate required fields
  const required = ['title', 'description', 'date', 'slug', 'ogImage', 'body', 'h1'];
  for (const field of required) {
    if (!post[field]) {
      console.error(`Missing required field: ${field}`);
      process.exit(1);
    }
  }

  // Enforce description length
  if (post.description.length > 160) {
    console.warn(`Description was ${post.description.length} chars — truncating to 160.`);
    post.description = post.description.slice(0, 157).replace(/[,;:\s]+$/, '') + '...';
  }

  // Enforce slug uniqueness
  if (existingSlugs.has(post.slug)) {
    const fallback = `${post.slug}-${today.slice(0, 7)}`;
    console.warn(`Slug "${post.slug}" already exists — using "${fallback}" instead.`);
    post.slug = fallback;
  }

  // Always use today's date
  post.date = today;

  const filename = `${post.slug}.json`;
  const filepath = path.join(POSTS_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(post, null, 2), 'utf8');

  console.log(`✓ New post saved: posts/${filename}`);
  console.log(`  Title: ${post.title}`);
  console.log(`  Description (${post.description.length} chars): ${post.description}`);
  console.log(`  Slug: ${post.slug}`);
}

generatePost().catch(err => {
  console.error('Error generating post:', err.message);
  process.exit(1);
});
