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
- Technical deep-dives: designing MCP servers and tool interfaces (Tool Design & MCP Integration), agentic loop and multi-agent orchestration patterns (Agentic Architecture & Orchestration), context management for long documents and multi-agent handoffs (Context Management & Reliability)
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

Do not choose a topic whose subject matter is a fact not on the verified list below — for example the retake policy, item format, or scoring — because there is not enough verified material to write 1500–2500 words without inventing unsupported detail. Prefer topics about preparation approach, the five domains and their objectives, or the practical experience of studying, where the writing does not depend on undocumented exam facts.

Return ONLY a raw JSON object — no markdown fences, no explanation — with exactly these four fields:
  title       — string, max 60 chars, SEO-friendly
  description — string, max 155 chars, complete sentence (no ellipsis), includes relevant keywords
  slug        — string, lowercase, hyphens only, URL-safe
  h1          — string, same as or a slightly longer version of title

The title and description must never contain: pass-rate or outcome guarantees, salary or hiring-demand claims, ROI superlatives, any named study framework, mnemonic, acronym, or methodology attributed to the exam that does not appear in Anthropic's official CCAR-F exam guide ("SPIDER", "CALM", and "PRECISE" are examples already found fabricated on this site — this is not an exhaustive list), unsourced negative claims about the exam, or any claim that the exam is single-answer multiple choice only.

VERIFIED FACTS — these are the only exam facts you may assert. Any other factual claim about the exam must be omitted rather than guessed, inferred, estimated, or reasoned out from context.
- Exam: Claude Certified Architect – Foundations; official exam code CCAR-F (also written CCA-F)
- Fee: $125 USD
- Items: 60
- Time limit: 120 minutes
- Passing score: 720, scaled on a 100–1,000 range
- Item format: multiple-choice AND multiple-response; each item states how many responses to select
- Structure: 4 scenarios drawn from a bank of 6, presented at random
- Delivery: Pearson VUE, proctored
- Validity: 12 months
- Renewal: free non-proctored assessment on the Anthropic Partner Academy; if it lapses, the full exam must be retaken at full fee
- Retakes: 14/30/90 days after the first/second/third failure; maximum four attempts per rolling 12 months; the fee applies to each attempt
- Domains: Agentic Architecture & Orchestration 27%, Claude Code Configuration & Workflows 20%, Prompt Engineering & Structured Output 20%, Tool Design & MCP Integration 18%, Context Management & Reliability 15%

Out of scope — never describe any of these as tested on the exam: Constitutional AI, RLHF, safety training methodologies, fine-tuning, vision, computer use, streaming or server-sent events, prompt caching implementation details.

There is no public credential lookup registry. There is no free-registration offer or partner eligibility gate — anyone may register.

If a fact about the exam is not stated above, omit it. Do not infer, estimate, or reason it out from context.`,
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
- Output ONLY the HTML body content — no JSON, no markdown fences, no title heading, no preamble

Never state or imply any of the following, even as a passing remark or example:
- Pass-rate statistics, certification-outcome guarantees, or claims that certification leads to a job, promotion, or raise
- Salary figures or hiring-demand claims for CCA-certified professionals
- ROI superlatives ("massive ROI", "guaranteed return", "in high demand")
- Testimonials, quotes, or anecdotes from named or unnamed candidates — do not invent people
- Any named study framework, mnemonic, acronym, or methodology attributed to the exam that does not appear in Anthropic's official CCAR-F exam guide. "SPIDER", "CALM", and "PRECISE" are examples already found fabricated on this site — this is not an exhaustive list; only reference material actually defined in the guide
- Unsourced negative claims about the exam's content or format (e.g. "there are no X questions", "the exam never covers Y")
- That the exam is single-answer multiple choice only — the official guide states items are multiple-choice AND multiple-response, and each item states how many responses to select

VERIFIED FACTS — these are the only exam facts you may assert. Any other factual claim about the exam must be omitted rather than guessed, inferred, estimated, or reasoned out from context.
- Exam: Claude Certified Architect – Foundations; official exam code CCAR-F (also written CCA-F)
- Fee: $125 USD
- Items: 60
- Time limit: 120 minutes
- Passing score: 720, scaled on a 100–1,000 range
- Item format: multiple-choice AND multiple-response; each item states how many responses to select
- Structure: 4 scenarios drawn from a bank of 6, presented at random
- Delivery: Pearson VUE, proctored
- Validity: 12 months
- Renewal: free non-proctored assessment on the Anthropic Partner Academy; if it lapses, the full exam must be retaken at full fee
- Retakes: 14/30/90 days after the first/second/third failure; maximum four attempts per rolling 12 months; the fee applies to each attempt
- Domains: Agentic Architecture & Orchestration 27%, Claude Code Configuration & Workflows 20%, Prompt Engineering & Structured Output 20%, Tool Design & MCP Integration 18%, Context Management & Reliability 15%

Out of scope — never describe any of these as tested on the exam: Constitutional AI, RLHF, safety training methodologies, fine-tuning, vision, computer use, streaming or server-sent events, prompt caching implementation details.

There is no public credential lookup registry. There is no free-registration offer or partner eligibility gate — anyone may register.

If a fact about the exam is not stated above, omit it. Do not infer, estimate, or reason it out from context.

The post's body text must state, in plain language, that claudecertifiedarchitects.com is independent practice material, is not the official exam, and is not affiliated with Anthropic.`,
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
    ogImage:     '/cca-link-image-v3.jpg',
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
