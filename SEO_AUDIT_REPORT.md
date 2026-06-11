# SEO Audit Report — Claude Certified Architects

**Site:** https://www.claudecertifiedarchitects.com
**Last updated:** 2026-06-11
**Latest commit audited:** `d837f94`

This report consolidates all SEO/E-E-A-T/accessibility audit work to date. Re-run
`node scripts/seo-audit.js` and `node scripts/jsonld-audit.js`, plus the Lighthouse
commands in the Appendix, to refresh the data and update this file.

---

## 1. Pass/Fail Checklist

### Technical SEO
| Check | Status | Notes |
|---|---|---|
| robots.txt allows all important paths | ✅ Pass | `User-agent: *` / `Allow: /` |
| robots.txt links sitemap absolutely | ✅ Pass | `Sitemap: https://www.claudecertifiedarchitects.com/sitemap.xml` |
| sitemap.xml valid, canonical, indexable URLs only | ✅ Pass | 28/28 URLs return 200, no redirects/404s/noindex |
| sitemap `<lastmod>` accurate | ✅ Pass | Driven by `gitLastmod()` in build.js |
| HTTPS enforced, zero mixed content | ✅ Pass | No `http://` resource refs found |
| Single canonical hostname (www) | ✅ Pass | non-www → 301 → `https://www.…`; `http://` → 301 → `https://` |
| Custom 404 page | ✅ Pass | `404.html`, branded, returns HTTP 404 |
| Fixed in | — | [c748fb4](../../commit/c748fb4), [1ec8d16](../../commit/1ec8d16) |

### Structured Data (JSON-LD)
| Check | Status | Notes |
|---|---|---|
| All blocks valid JSON, `@context`/`@type` correct | ✅ Pass | 0 issues across 28 pages |
| Required properties present per type | ✅ Pass | Course, Organization, WebSite, FAQPage, Article, WebPage, BreadcrumbList |
| No fabricated Review/AggregateRating | ✅ Pass | None present |
| BreadcrumbList sequential + matches canonical | ✅ Pass | All non-home pages |
| Article `headline`/`url`/`datePublished` match visible content | ✅ Pass | All 21 posts |
| Organization schema has `name`, `url`, `logo` | ✅ Pass | |
| Organization schema has `sameAs` | ❌ **Gap** | No social profiles exist anywhere in repo — see §5 |
| Fixed in | — | [2b40e48](../../commit/2b40e48), [d837f94](../../commit/d837f94) |

### Mobile-First Readiness
| Check | Status | Notes |
|---|---|---|
| Tap targets ≥ 44px, no overlap | ✅ Pass | |
| Mobile content parity with desktop | ✅ Pass | |
| Tables don't overflow viewport | ✅ Pass | |
| Hamburger nav on all subpages | ✅ Pass | |
| Fixed in | — | [1ec8d16](../../commit/1ec8d16) |

### Accessibility
| Check | Status | Notes |
|---|---|---|
| ARIA labels on nav/buttons/modals | ✅ Pass | |
| Modal `role="dialog"` / `aria-modal` / focus trap | ✅ Pass | |
| Visible focus styles | ✅ Pass | |
| WCAG AA color contrast | ✅ Pass | |
| Lighthouse Accessibility = 100 | ✅ Pass | All 3 sampled pages, mobile + desktop |
| Fixed in | — | [aa3e690](../../commit/aa3e690), [d12d8db](../../commit/d12d8db) |

### E-E-A-T / Trust Signals
| Check | Status | Notes |
|---|---|---|
| Visible author byline on articles | ✅ Pass | "By Claude Certified Architects" in `.post-meta` |
| Visible published date | ✅ Pass | `<time>` element |
| `dateModified`/"Updated" mechanism | ✅ Pass (unused) | `post.updated` field drives JSON-LD `dateModified` + sitemap `lastmod`; no posts revised yet |
| Independence disclaimer site-wide | ✅ Pass | `#site-banner` + footer, all 28 pages |
| About page | ❌ **Gap** | Does not exist; no nav/footer link |
| Contact page | ❌ **Gap** | Does not exist; no real contact email/form available |
| Organization `sameAs` social links | ❌ **Gap** | Same as structured-data gap above |
| Fixed in | — | [d837f94](../../commit/d837f94) |

### AI-Search Readiness (Perplexity / ChatGPT Search / Google AI Overviews)
| Check | Status | Notes |
|---|---|---|
| Single `<h1>` per page, no skipped heading levels | ✅ Pass | |
| Descriptive (non-generic) headings | ✅ Pass | |
| Semantic tags (`main`/`nav`/`article`/`header`/`footer`/`section`) | ✅ Pass | |
| Substantial static text without JS | ✅ Pass | 1,500–3,200 chars on key pages |
| `llms.txt` at site root | ✅ Pass | New — summarizes 7 key pages + 21 posts |
| Fixed in | — | [d837f94](../../commit/d837f94) |

---

## 2. Lighthouse Scores

Run against the live production site (`npx lighthouse <url> --only-categories=performance,accessibility,best-practices,seo`), default mobile preset and `--preset=desktop`.

| Page | Mode | Performance | Accessibility | Best Practices | SEO |
|---|---|---:|---:|---:|---:|
| `/` (Home) | Mobile | 69 | 100 | 100 | 100 |
| `/` (Home) | Desktop | 94 | 100 | 100 | 100 |
| `/blog/agentic-architecture-orchestration-cca-domain-1/` | Mobile | 70 | 100 | 100 | 100 |
| `/blog/agentic-architecture-orchestration-cca-domain-1/` | Desktop | 99 | 100 | 100 | 100 |
| `/diagnostic/` | Mobile | 79 | 100 | 100 | 100 |
| `/diagnostic/` | Desktop | 97 | 100 | 100 | 100 |

**Accessibility, Best Practices, and SEO are 100/100 across every sampled page and device.** Mobile Performance is the only category below target — see §5.

Mobile diagnostics for the 3 sampled pages:

| Page | LCP | TBT | CLS | Unused JS |
|---|---:|---:|---:|---:|
| Home | 1.9s (97) | **2,840ms (score 3)** | 0 (100) | ~113 KiB (score 50) |
| Blog: Domain 1 | 3.4s (66) | 990ms (score 28) | 0 (100) | ~82 KiB (score 0) |
| Diagnostic | 1.9s (98) | 820ms (score 36) | 0 (100) | ~78 KiB (score 50) |

---

## 3. Page-by-Page Status Table (28 sitemap URLs)

All values from `node scripts/seo-audit.js` / `node scripts/jsonld-audit.js` — **0 issues flagged** (titles ≤60 chars, descriptions ≤155 chars, exactly one H1, canonical/OG/Twitter all present and correct, JSON-LD valid).

| Page | Title (chars) | Description (chars) | H1 | JSON-LD types | Status |
|---|---:|---:|---:|---|---|
| `/` | 51 | 148 | 1 | Organization, WebSite, Course, FAQPage | ✅ |
| `/cca-foundations-exam/` | 51 | 148 | 1 | WebPage, BreadcrumbList | ✅ |
| `/cca-practice-questions/` | 56 | 145 | 1 | WebPage, BreadcrumbList | ✅ |
| `/cca-exam-guide/` | 54 | 128 | 1 | WebPage, BreadcrumbList | ✅ |
| `/blog/` | 57 | 132 | 1 | BreadcrumbList | ✅ |
| `/register/` | 54 | 153 | 1 | WebPage, BreadcrumbList | ✅ |
| `/diagnostic/` | 53 | 137 | 1 | WebPage, BreadcrumbList | ✅ |
| `/blog/ai-engineer-certifications-2026/` | 59 | 151 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/claude-certified-architect-certification-worth-it/` | 57 | 133 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/how-hard-is-cca-foundations-exam/` | 60 | 134 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/how-to-learn-claude-agent-development/` | 60 | 153 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/cca-vs-aws-ai-practitioner-which-certification/` | 57 | 147 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/agentic-architecture-orchestration-cca-domain-1/` | 56 | 151 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/claude-code-config-workflows-cca-domain-2/` | 60 | 148 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/prompt-engineering-structured-output-cca-domain-3/` | 58 | 148 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/tool-design-mcp-cca-domain-4/` | 48 | 150 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/context-management-reliability-cca-domain-5/` | 57 | 151 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/cca-exam-study-schedule-30-day-plan/` | 59 | 152 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/how-to-write-effective-claude-md-file/` | 59 | 149 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/why-claude-certification-is-important/` | 56 | 145 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/cca-real-world-reports-responsibilities-salaries/` | 60 | 152 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/claude-certified-architect-salary-career-2026/` | 60 | 143 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/how-to-become-claude-certified-architect/` | 60 | 153 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/cca-foundations-exam-practice-questions-free/` | 59 | 135 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/cca-exam-anti-patterns/` | 55 | 151 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/is-cca-certification-worth-it-2026/` | 53 | 147 | 1 | Article, BreadcrumbList | ✅ |
| `/blog/cca-foundations-exam-guide-2026/` | 53 | 146 | 1 | Article, BreadcrumbList, FAQPage | ✅ |
| `/blog/cca-foundations-exam-domains-explained/` | 55 | 134 | 1 | Article, BreadcrumbList | ✅ |

---

## 4. Open Items & Prioritized Issues (ranked by likely SEO impact)

1. **HIGH — Mobile performance / Core Web Vitals (TBT).**
   Total Blocking Time is 820–2,840ms on mobile across all 3 sampled pages (Performance scores 69–79), driven mainly by ~80–113 KiB of unused JavaScript executing on every page from the site's fully-inline architecture. INP (replaced FID) is a Google Page Experience ranking factor and these numbers likely fail "Good" thresholds for real mobile users. Prior work ([6034588](../../commit/6034588), [d6ff67e](../../commit/d6ff67e)) already deferred GTM/Firebase — home mobile TBT is still 2,840ms, so further work remains (e.g., code-split or lazy-load the quiz/dashboard JS on pages that don't need it on first paint).

2. **MEDIUM — Organization schema missing `sameAs`.**
   No social profiles exist anywhere in the repo, so this can't be added without fabricating data. Limits entity verification / Knowledge Panel eligibility and AI-citation confidence. Action: create at least one real profile (X/LinkedIn/YouTube/GitHub) for "Claude Certified Architects" and add it to `organizationSchema.sameAs` in build.js.

3. **MEDIUM — No About or Contact page.**
   Neither page exists and there's no nav/footer link to either. Google's quality-rater guidelines explicitly look for these as trust signals, particularly for career/certification (YMYL-adjacent) content. Action: once real "about the site/team" copy and a real contact email or form are available, build `/about/` and `/contact/` and link them from nav/footer.

4. **LOW — `/diagnostic/` server-response-time scored 0 (610ms TTFB)** on this run vs. 100 (130–350ms) on other pages. Likely a one-off GitHub Pages cold-cache hit rather than a structural issue — re-check on the next run before acting.

5. **INFORMATIONAL — `dateModified`/"Updated" mechanism is live but unused.**
   `post.updated` (optional field in `posts/*.json`) now drives JSON-LD `dateModified` and sitemap `lastmod` — set it the next time a post is substantively revised.

---

## Appendix: Re-running this audit

```bash
# Technical SEO + meta/OG/Twitter + JSON-LD
node scripts/seo-audit.js
node scripts/jsonld-audit.js

# Lighthouse (mobile + desktop) for the 3 sample pages
npx lighthouse https://www.claudecertifiedarchitects.com/ \
  --only-categories=performance,accessibility,best-practices,seo --quiet --output=json --output-path=home-mobile.json
npx lighthouse https://www.claudecertifiedarchitects.com/ --preset=desktop \
  --only-categories=performance,accessibility,best-practices,seo --quiet --output=json --output-path=home-desktop.json
# (repeat for /blog/agentic-architecture-orchestration-cca-domain-1/ and /diagnostic/)
```
