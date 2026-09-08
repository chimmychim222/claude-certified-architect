/**
 * EM-DASH SWEEP — read-only unless --write-baseline.   node scripts/emdash-sweep.js [mode]
 *
 * The rule (publish manual §6b, added 8 Sep 2026): no em-dash in PROSE on any
 * surface that publishes. Em-dash-heavy prose reads as machine-written; a
 * comment in that register was called out on a technical forum on 8 Sep 2026.
 * The bank already bans them in scored options (primer §0 item 7b); this
 * extends the ban to prose. Rewrite with a comma, a full stop or a split,
 * never a reflex semicolon, never a meaning change.
 *
 * Modes:
 *   (none)             every content surface, judged against scripts/emdash-baseline.json
 *   --staged           only files in `git diff --cached --name-only`, a post JSON
 *                      auto-paired with its built page and vice versa; the gate in §5
 *   --files a b c      spot-check named files (repo-relative)
 *   --write-baseline   regenerate the baseline from the working tree (the ONLY write)
 *
 * Exit codes: 0 pass · 1 a checked file INCREASED over its baseline, or carries
 * hits on a path the baseline does not list · 2 an embedded control failed, so
 * nothing else it printed can be trusted.
 *
 * THE BASELINE IS A DECISION, NOT A BACKLOG. On 8 Sep 2026 the corpus held
 * 2,354 em-dashes across 107 customer surfaces and 45 of 46 posts. The owner
 * ruled: fix the detector, the rule, the two September posts and the dev.to-
 * syndicated posts; do NOT retrofit the rest (days of work on pages that rank,
 * and rewriting text nobody complained about risks new errors). A deferred
 * post is cleaned when it is substantially revised for another reason. The
 * baseline records each deferred path at its count on the day of the ruling.
 * A count may fall (regenerate the baseline afterwards); it may never rise,
 * and a path with hits that the baseline does not know is a failure.
 * Touching a deferred path prints a WARNING naming the manual clause.
 *
 * In scope: post title/description/h1/FAQ and body prose; every served HTML
 * page's prose, meta content and JSON-LD; llms.txt; schema.json strings;
 * app.js QUESTIONS stems, explanations and options, LESSONS, and UI strings
 * outside the arrays; diagnostic/index.html POOL and page strings; the
 * customer-facing regions of scripts/stripe-webhook.js (emails, unsubscribe
 * page, diagnostic-results mail, STUDY_TIPS, SAMPLE_QUESTIONS).
 *
 * Carve-outs, ruled 8 Sep 2026 (manual §6b), and only these:
 *   1. verbatim quoted material — <blockquote> and <q>, which includes the
 *      consented customer quote on the homepage
 *   2. code — <pre> and <code>; an author's own comment inside a code block is
 *      prose and was rewritten, the carve-out covers tool output as it appeared
 *   3. scored options of bank item [232] (primer §9a's recorded exception),
 *      matched by STEM TEXT, never by index (indices shift when a slot is retired)
 *   4. glyphs and data labels that are not sentences: the empty-value
 *      placeholder ('—', '— / 1,000') and the currency <option> list
 * Code comments, CSS and non-JSON-LD inline scripts are not prose and are
 * never counted. En-dashes are not counted at all; numeric ranges are
 * legitimate, and an en-dash used as an em-dash is a copy-edit, not a tell.
 *
 * Controls run on every invocation, before any repo file is read, and abort
 * on mismatch (exit 2): a synthetic positive that must count exactly 7 across
 * the raw, entity and escape forms and classify prose 4 / code 1 / blockquote 1,
 * and a synthetic negative carrying en-dashes, hyphens, the bare word "mdash"
 * and "u2014" with no backslash that must count 0. Both results are printed.
 *
 * Served publicly: scripts/ is inside the Pages deploy tree (calendar row
 * 459). No secrets, no customer data, no local paths; the repo is resolved
 * from this file's own location. Keep it that way.
 */
'use strict';
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const REPO = path.join(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'emdash-baseline.json');
const argv = process.argv.slice(2);
const MODE = argv.includes('--staged') ? 'staged' : argv.includes('--files') ? 'files' : argv.includes('--write-baseline') ? 'write' : 'all';

const EM_RE = /—|&mdash;|&#8212;|&#x2014;|\\u2014/gi;
const emIn = s => typeof s === 'string' ? (s.match(EM_RE) || []).length : 0;
const BS = String.fromCharCode(92);

// ── the [232] exception, by stem text ────────────────────────────────────────
const OPTION_EXCEPTION_STEM = "A monitoring dashboard shows that your agent's response quality has gradually decreased over the past month despite no code changes.";

// ── HTML context classifier ───────────────────────────────────────────────────
// Returns one record per em-dash: { idx, ctx, snippet }. ctx ∈ code | blockquote |
// comment | style | script | json-ld | attribute | glyph | currency | prose
function classifyHtml(s) {
  const spans = [];
  const mark = (re, ctx) => { let m; while ((m = re.exec(s))) spans.push({ a: m.index, b: m.index + m[0].length, ctx }); };
  mark(/<!--[\s\S]*?-->/g, 'comment');
  mark(/<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi, 'json-ld');
  mark(/<script\b[\s\S]*?<\/script>/gi, 'script');
  mark(/<style\b[\s\S]*?<\/style>/gi, 'style');
  mark(/<pre\b[\s\S]*?<\/pre>/gi, 'code');
  mark(/<code\b[\s\S]*?<\/code>/gi, 'code');
  mark(/<blockquote\b[\s\S]*?<\/blockquote>/gi, 'blockquote');
  mark(/<q\b[\s\S]*?<\/q>/gi, 'blockquote');
  mark(/<option value="[A-Z]{3}">[^<]*<\/option>/g, 'currency');
  mark(/<[a-zA-Z][^>]*>/g, 'attribute');
  const order = ['comment', 'json-ld', 'script', 'style', 'code', 'blockquote', 'currency', 'attribute'];
  const out = []; let m;
  const re = new RegExp(EM_RE.source, 'gi');
  while ((m = re.exec(s))) {
    const i = m.index; let ctx = 'prose';
    for (const c of order) { if (spans.some(sp => sp.ctx === c && i >= sp.a && i < sp.b)) { ctx = c; break; } }
    if (ctx === 'prose') {
      const ls = s.lastIndexOf('\n', i) + 1, le = s.indexOf('\n', i);
      const text = s.slice(ls, le === -1 ? s.length : le).replace(/<[^>]+>/g, '').trim();
      if (/^(—|&mdash;)(\s*\/\s*1,000)?$/.test(text)) ctx = 'glyph';
    }
    out.push({ idx: i, ctx, snippet: s.slice(Math.max(0, i - 70), i + 70).replace(/\s+/g, ' ') });
  }
  return out;
}
const IN_SCOPE_HTML = new Set(['prose', 'attribute', 'json-ld']);

// ── string- and comment-aware literal extractor (from scripts/build-pools.js) ─
function extractLiteral(src, marker, openCh, closeCh) {
  const start = src.indexOf(marker); if (start === -1) return null;
  const open = start + marker.length - 1;
  let depth = 0, inStr = false, strCh = '', esc = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inStr) { if (esc) esc = false; else if (c === BS) esc = true; else if (c === strCh) inStr = false; continue; }
    if (c === '/' && n === '/') { const nl = src.indexOf('\n', i); if (nl === -1) return null; i = nl; continue; }
    if (c === '/' && n === '*') { const ce = src.indexOf('*/', i + 2); if (ce === -1) return null; i = ce + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; continue; }
    if (c === openCh) depth++;
    else if (c === closeCh) { depth--; if (depth === 0) return { text: src.slice(open, i + 1), start: open, end: i }; }
  }
  return null;
}
const evalLiteral = text => new Function('return (' + text + ')')();
const isCommentLine = l => /^\s*(\/\/|\*|\/\*)/.test(l);
function lineOf(src, idx) { return src.slice(0, idx).split('\n').length; }

// ── per-surface scanners: each returns { hits:[{ctx, where, snippet}], excluded:{ctx:n} } ─
// One record per em-dash, never per field: a second em-dash added to a field
// that already carried one must read as an increase against the baseline.
function push(res, ctx, where, snippet, inScope, times) { const n = times === undefined ? 1 : times; for (let k = 0; k < n; k++) { if (inScope) res.hits.push({ ctx, where, snippet: snippet.replace(/\s+/g, ' ').slice(0, 150) }); else res.excluded[ctx] = (res.excluded[ctx] || 0) + 1; } }

function scanPostJson(rel, text) {
  const res = { hits: [], excluded: {} }; const j = JSON.parse(text);
  for (const [k, v] of Object.entries(j)) {
    if (k === 'body') { classifyHtml(v).forEach(o => push(res, o.ctx, 'body', o.snippet, IN_SCOPE_HTML.has(o.ctx))); continue; }
    if (typeof v === 'string' && emIn(v)) push(res, 'field:' + k, k, v, true, emIn(v));
    if (Array.isArray(v)) v.forEach((x, i) => { if (x && typeof x === 'object') for (const [kk, vv] of Object.entries(x)) if (emIn(vv)) push(res, 'field:' + k + '.' + kk, k + '[' + i + '].' + kk, vv, true, emIn(vv)); });
  }
  return res;
}
function scanHtml(rel, text) {
  const res = { hits: [], excluded: {} };
  classifyHtml(text).forEach(o => push(res, o.ctx, 'line ' + lineOf(text, o.idx), o.snippet, IN_SCOPE_HTML.has(o.ctx)));
  return res;
}
function scanBankItems(res, items, where) {
  items.forEach((q, i) => {
    if (emIn(q.q)) push(res, 'stem', where + '[' + i + '] q', q.q, true, emIn(q.q));
    if (emIn(q.e)) push(res, 'explanation', where + '[' + i + '] e', q.e, true, emIn(q.e));
    (q.o || []).forEach((o, oi) => { if (!emIn(o)) return; const exempt = typeof q.q === 'string' && q.q.startsWith(OPTION_EXCEPTION_STEM); push(res, exempt ? 'option-exception-232' : 'option', where + '[' + i + '] o[' + oi + ']', o, !exempt, emIn(o)); });
  });
}
function scanAppJs(rel, text) {
  const res = { hits: [], excluded: {} };
  const qLit = extractLiteral(text, 'const QUESTIONS = [', '[', ']'); const lLit = extractLiteral(text, 'const LESSONS = [', '[', ']'); const fLit = extractLiteral(text, 'const FREE_POOL_STEMS = [', '[', ']');
  if (!qLit || !lLit) { res.hits.push({ ctx: 'PARSE-FAILURE', where: 'app.js', snippet: 'QUESTIONS or LESSONS literal not found; treat this run as invalid' }); return res; }
  const Q = evalLiteral(qLit.text); scanBankItems(res, Q, 'QUESTIONS');
  const L = evalLiteral(lLit.text); L.forEach((l, i) => { const n = emIn(JSON.stringify(l)); if (n) push(res, 'lesson', 'LESSONS[' + i + '] ×' + n, (l.title || '') + ' (' + n + ' em-dashes in module text)', true, n); });
  const skip = [qLit, lLit, fLit].filter(Boolean).map(x => [x.start, x.end]);
  const lines = text.split('\n'); let pos = 0;
  lines.forEach((l, i) => { const start = pos; pos += l.length + 1; if (skip.some(([a, b]) => start >= a && start <= b)) return; const n = emIn(l); if (!n) return; if (isCommentLine(l)) { res.excluded.comment = (res.excluded.comment || 0) + n; return; } if (/^\s*(let|const|var)?\s*\w*\s*=\s*'—';?\s*$/.test(l.replace(/\r$/, ''))) { res.excluded.glyph = (res.excluded.glyph || 0) + n; return; } for (let k = 0; k < n; k++) push(res, 'ui-string', 'line ' + (i + 1), l.trim(), true); });
  return res;
}
function scanDiagnostic(rel, text) {
  const res = { hits: [], excluded: {} };
  const pLit = extractLiteral(text, 'const POOL = {', '{', '}');
  if (!pLit) { res.hits.push({ ctx: 'PARSE-FAILURE', where: rel, snippet: 'POOL literal not found; treat this run as invalid' }); return res; }
  const POOL = JSON.parse(pLit.text); const flat = Object.values(POOL).flat(); scanBankItems(res, flat, 'POOL');
  const rest = text.slice(0, pLit.start) + '{}' + text.slice(pLit.end + 1);
  // page markup outside scripts, then the inline script's own string lines (results copy), comments excluded
  const scriptSpans = []; let m; const sre = /<script\b(?![^>]*ld\+json)[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = sre.exec(rest))) scriptSpans.push({ a: m.index, b: m.index + m[0].length, body: m[1], at: m.index + m[0].indexOf(m[1]) });
  classifyHtml(rest).forEach(o => { if (o.ctx === 'script') return; push(res, o.ctx, 'line ' + lineOf(rest, o.idx), o.snippet, IN_SCOPE_HTML.has(o.ctx)); });
  for (const sp of scriptSpans) sp.body.split('\n').forEach((l, i) => { const n = emIn(l); if (!n) return; if (isCommentLine(l)) { res.excluded.comment = (res.excluded.comment || 0) + n; return; } for (let k = 0; k < n; k++) push(res, 'page-script-string', 'line ' + (lineOf(rest, sp.at) + i), l.trim(), true); });
  return res;
}
const WEBHOOK_REGION_FNS = ['emailWrap', 'eP', 'eBtn', 'buildEmail1', 'buildEmail2', 'buildEmail3', 'unsubPage'];
function scanWebhook(rel, text) {
  const res = { hits: [], excluded: {} }; const lines = text.split('\n'); const inRegion = new Array(lines.length).fill(null);
  const markRegion = (a, b, name) => { for (let i = a - 1; i < b && i < lines.length; i++) inRegion[i] = name; };
  for (const fn of WEBHOOK_REGION_FNS) { const s = text.indexOf('function ' + fn + '('); if (s === -1) continue; const rel2 = text.slice(s + 1).search(/\n(async )?function |\napp\.(get|post)\(|\nconst [A-Z_]+ = /); markRegion(lineOf(text, s), rel2 === -1 ? lines.length : lineOf(text, s + 1 + rel2), fn); }
  for (const [name, marker] of [['STUDY_TIPS', 'const STUDY_TIPS = {'], ['SAMPLE_QUESTIONS', 'const SAMPLE_QUESTIONS = {']]) { const lit = extractLiteral(text, marker, '{', '}'); if (lit) markRegion(lineOf(text, lit.start), lineOf(text, lit.end), name); }
  const de = text.indexOf("app.post('/diagnostic-email'"); if (de !== -1) { const end = text.indexOf("\napp.get('/'", de); markRegion(lineOf(text, de), end === -1 ? lines.length : lineOf(text, end), '/diagnostic-email'); }
  const un = text.indexOf("app.get('/unsubscribe'"); if (un !== -1) { const end = text.indexOf('function unsubPage(', un); markRegion(lineOf(text, un), end === -1 ? lines.length : lineOf(text, end), '/unsubscribe'); }
  lines.forEach((l, i) => { const n = emIn(l); if (!n) return; if (isCommentLine(l)) { res.excluded.comment = (res.excluded.comment || 0) + n; return; } if (!inRegion[i]) { res.excluded['not-customer-facing'] = (res.excluded['not-customer-facing'] || 0) + n; return; } for (let k = 0; k < n; k++) push(res, inRegion[i], 'line ' + (i + 1), l.trim(), true); });
  return res;
}
function scanPlainLines(rel, text) { const res = { hits: [], excluded: {} }; text.split(/\r?\n/).forEach((l, i) => { const n = emIn(l); for (let k = 0; k < n; k++) push(res, 'line', 'line ' + (i + 1), l, true); }); return res; }

function surfaceOf(rel) {
  if (/^posts\/[^/]+\.json$/.test(rel)) return 'post-json';
  if (rel === 'app.js') return 'app.js';
  if (rel === 'diagnostic/index.html') return 'diagnostic';
  if (rel === 'scripts/stripe-webhook.js') return 'webhook';
  if (rel === 'llms.txt' || rel === 'schema.json') return 'plain';
  if (/\.html$/.test(rel) && !/^(scripts|node_modules|audit-output|draft-output|_lighthouse)\//.test(rel) && rel !== 'googledd8ffb443c41ec49.html') return 'html';
  return null;
}
function scanFile(rel) {
  const surface = surfaceOf(rel); if (!surface) return null;
  const abs = path.join(REPO, rel); if (!fs.existsSync(abs)) return { rel, surface, missing: true, hits: [], excluded: {} };
  const text = fs.readFileSync(abs, 'utf8');
  const r = surface === 'post-json' ? scanPostJson(rel, text) : surface === 'app.js' ? scanAppJs(rel, text) : surface === 'diagnostic' ? scanDiagnostic(rel, text) : surface === 'webhook' ? scanWebhook(rel, text) : surface === 'plain' ? scanPlainLines(rel, text) : scanHtml(rel, text);
  return { rel, surface, ...r };
}

// ── controls: synthetic, embedded, run first, abort on mismatch ───────────────
function runControls() {
  const POS = '<p>Prose em-dash here — one in prose.</p>\n<pre>code em-dash — inside pre</pre>\n<blockquote>quoted em-dash — inside blockquote</blockquote>\n<p>entities: &mdash; and &#8212; and &#x2014; plus escape ' + BS + 'u2014 and en entity &ndash;</p>\n<p>ranges 2024–2026 and Paris – London; hyphens well-known self-test</p>\n';
  const NEG = '<p>No em dash anywhere. The word mdash appears bare, and u2014 without a backslash.</p>\n<p>Ranges 10–20 and Mon–Fri; hyphens: well-known, self-test, re-run, x-y.</p>\n';
  const posCount = emIn(POS), negCount = emIn(NEG);
  const posCtx = {}; classifyHtml(POS).forEach(o => posCtx[o.ctx] = (posCtx[o.ctx] || 0) + 1);
  const ok = posCount === 7 && negCount === 0 && posCtx.prose === 5 && posCtx.code === 1 && posCtx.blockquote === 1;
  console.log('controls: positive fired ' + posCount + '/7 (contexts ' + JSON.stringify(posCtx) + ', expected prose 5 = 1 raw + 3 entities + 1 escape, code 1, blockquote 1) · negative fired ' + negCount + '/0 with en-dashes and hyphens present');
  if (!ok) { console.error('\nABORT — an embedded control failed. The detector cannot be trusted on this run.'); process.exit(2); }
}

// ── main ──────────────────────────────────────────────────────────────────────
runControls();
const tracked = execSync('git ls-files', { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
let targets;
if (MODE === 'staged') {
  const staged = execSync('git diff --cached --name-only', { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
  const set = new Set(staged);
  for (const f of staged) { let m; if ((m = f.match(/^posts\/([^/]+)\.json$/))) set.add('blog/' + m[1] + '/index.html'); if ((m = f.match(/^blog\/([^/]+)\/index\.html$/))) set.add('posts/' + m[1] + '.json'); }
  targets = [...set].filter(f => surfaceOf(f) && (tracked.includes(f) || fs.existsSync(path.join(REPO, f))));
  console.log('mode: --staged · ' + staged.length + ' staged, ' + targets.length + ' content files after pairing' + (targets.length ? ': ' + targets.join(', ') : ''));
} else if (MODE === 'files') {
  targets = argv.slice(argv.indexOf('--files') + 1).filter(a => !a.startsWith('--')).map(f => f.replace(/\\/g, '/').replace(/^\.\//, ''));
  console.log('mode: --files · ' + targets.join(', '));
} else {
  targets = tracked.filter(surfaceOf);
  console.log('mode: ' + (MODE === 'write' ? '--write-baseline' : 'all content surfaces') + ' · ' + targets.length + ' files');
}

const results = targets.map(scanFile).filter(Boolean);
let baseline = null;
if (fs.existsSync(BASELINE_PATH)) { try { baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); } catch (e) { console.error('ABORT — baseline file is not valid JSON: ' + e.message); process.exit(2); } }

if (MODE === 'write') {
  const files = {}; results.filter(r => r.hits.length).sort((a, b) => a.rel.localeCompare(b.rel)).forEach(r => files[r.rel] = r.hits.length);
  const sha = execSync('git rev-parse --short HEAD', { cwd: REPO, encoding: 'utf8' }).trim();
  const out = { generatedAt: sha, generatedOn: new Date().toISOString().slice(0, 10), rule: 'publish manual §6b, 8 Sep 2026: counts recorded here are DEFERRED by decision, not queued; a count may fall, never rise', totalHits: Object.values(files).reduce((a, b) => a + b, 0), files };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log('baseline written: ' + Object.keys(files).length + ' paths, ' + out.totalHits + ' accepted hits, at ' + sha);
  process.exit(0);
}

let failures = 0, warnings = 0, totalHits = 0;
const ctxTot = {};
console.log('\npath | in-scope hits | baseline | verdict');
for (const r of results.sort((a, b) => b.hits.length - a.hits.length)) {
  const n = r.hits.length; totalHits += n; r.hits.forEach(h => ctxTot[h.ctx] = (ctxTot[h.ctx] || 0) + 1);
  const base = baseline && Object.prototype.hasOwnProperty.call(baseline.files, r.rel) ? baseline.files[r.rel] : null;
  let verdict;
  if (r.missing) verdict = 'MISSING (deleted or renamed)';
  else if (n === 0) verdict = 'clean';
  else if (!baseline) verdict = 'REPORT (no baseline yet)';
  else if (base === null) { verdict = 'FAIL — hits on a path the baseline does not list'; failures++; }
  else if (n > base) { verdict = 'FAIL — increased from ' + base; failures++; }
  else if (n < base) verdict = 'improved from ' + base + ' (regenerate the baseline)';
  else { verdict = 'deferred at ' + base + ' (manual §6b)'; if (MODE === 'staged') { verdict += ' · WARNING: deferred prose touched, §6b says clean it now'; warnings++; } }
  if (n || MODE !== 'all' || r.missing) console.log(r.rel + ' | ' + n + ' | ' + (base === null ? '-' : base) + ' | ' + verdict);
  if ((MODE !== 'all' || verdict.startsWith('FAIL')) && n) r.hits.slice(0, 60).forEach(h => console.log('    [' + h.ctx + '] ' + h.where + ' | …' + h.snippet + '…'));
}
const excl = {}; results.forEach(r => Object.entries(r.excluded).forEach(([k, v]) => excl[k] = (excl[k] || 0) + v));
console.log('\nin-scope hits: ' + totalHits + ' across ' + results.filter(r => r.hits.length).length + ' of ' + results.length + ' files · by context ' + JSON.stringify(ctxTot));
console.log('excluded by carve-out or non-prose context: ' + JSON.stringify(excl));
console.log('baseline: ' + (baseline ? baseline.generatedAt + ' (' + Object.keys(baseline.files).length + ' paths, ' + baseline.totalHits + ' accepted)' : 'NONE — report only; generate with --write-baseline once the accepted state is on disk'));
if (failures) { console.log('\nRESULT: FAIL (' + failures + ' file' + (failures > 1 ? 's' : '') + ') — rewrite before staging; manual §6b'); process.exit(1); }
console.log('\nRESULT: PASS' + (warnings ? ' with ' + warnings + ' warning' + (warnings > 1 ? 's' : '') : ''));
