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
 *
 * Last content update: 2026-08-06 — MR question format copy
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
// processFile() calls spliceNav(), which replaces everything between the
// <!-- cca:nav:start/end --> markers inside <nav> with renderNav(activePage):
// the N1 grouped navigation below (bar, dropdown panels, mobile panel, its
// styles and its script). The apply script that shipped N1 by hand (17 Oct
// 2026) emits the identical block, so a build is a no-op on the nav.
const NAV_START  = '<!-- cca:nav:start -->';
const NAV_END    = '<!-- cca:nav:end -->';
const NAV_RE     = /<!-- cca:nav:start -->[\s\S]*?<!-- cca:nav:end -->/;

// NAVGEN-START
// ── N1 grouped navigation (Oct 2026) ─────────────────────────────────────────
// One nav block for every page family. Everything the nav needs (markup, styles,
// behaviour) lives INSIDE the <nav> element between the cca:nav markers, so no
// page <head> changes. Every link is a plain <a href> in the HTML; the dropdown
// panels and the mobile panel are hidden with CSS until opened. The marked,
// Developer dropdown (B3, Oct 2026) sits between Architect and Resources.
const NAV2_START = '<!-- cca:nav:start -->';
const NAV2_END   = '<!-- cca:nav:end -->';
// The N1 slot markers were replaced by the Developer dropdown at the B3 launch (Oct 2026).
const NAV2_CHEV = '<svg class="cnav-chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const NAV2_FONT = "font-family:-apple-system,system-ui,'Segoe UI',sans-serif;";
// Row heights per page family: the bar keeps today's rendered height on every
// page (desktop row, then the burger row below 1200 px). nav adds a 1px border.
const NAV2_HEIGHTS = {
  home:       { desk: 78, mob: 72, narrow: 68 },   // 79 / 73 / 69 today (69 at <=640)
  static:     { desk: 63, mob: 72 },               // 64 / 73 today
  register:   { desk: 68, mob: 72 },               // 69 / 73 today
  diagnostic: { desk: 62, mob: 72 },               // 63 / 73 today
  blog:       { desk: 63, mob: 72 }                // today's blog row wraps to 100; the article offset is a fixed 86px
};
const NAV2_CSS =
  'nav .cnav{justify-content:flex-start;gap:4px;padding-top:0;padding-bottom:0}' +
  'nav .cnav .logo{margin-right:14px}' +
  '.cnav-item,.cnav-item:link,.cnav-item:visited{' + NAV2_FONT + 'font-size:.9rem;line-height:1.3;color:var(--text2,#5a5a52);text-decoration:none;background:none;border:0;padding:9px 12px;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;margin:0}' +
  '.cnav-item:hover,.cnav-item[aria-expanded="true"]{background:rgba(0,0,0,.05);color:var(--text,#191918)}' +
  '.cnav-item.active,.cnav-item.on{color:var(--text,#191918);font-weight:600}' +
  '.cnav-dd{position:relative;display:inline-flex}' +
  '.cnav-panel{display:none;position:absolute;top:calc(100% + 6px);left:0;background:var(--surface,#fff);border:1px solid var(--border,#d9d5ca);border-radius:12px;box-shadow:0 12px 32px rgba(40,30,20,.12);padding:8px;min-width:330px;z-index:20;' + NAV2_FONT + '}' +
  '.cnav-dd.open>.cnav-panel{display:block}' +
  '.cnav-panel-sm{min-width:220px}' +
  '.cnav-panel-r{left:auto;right:0;min-width:250px}' +
  '.cnav-ph{font-size:.7rem;font-weight:700;letter-spacing:.08em;color:var(--accent-text,#b04928);padding:8px 12px 4px}' +
  '.cnav-row{position:relative;padding:9px 12px;border-radius:8px}' +
  '.cnav-row:hover,.cnav-row:focus-within{background:var(--bg,#f5f3ea)}' +
  '.cnav-row:focus-within{outline:2px solid var(--accent-text,#b04928);outline-offset:-2px}' +
  '.cnav-rl,.cnav-rl:link,.cnav-rl:visited{font:inherit;font-size:.9rem;font-weight:600;line-height:1.35;color:var(--text,#191918);text-decoration:none;background:none;border:0;padding:0;margin:0;cursor:pointer;text-align:left;display:inline}' +
  '.cnav-rl::after{content:"";position:absolute;inset:0;border-radius:8px}' +
  '.cnav-rl:focus-visible{outline:none}' +
  '.cnav-rd{font-size:.78rem;line-height:1.4;color:var(--text3,#6f6f66);margin-top:2px}' +
  '.cnav-signed{padding:8px 12px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px}' +
  '.cnav-right{margin-left:auto;display:flex;align-items:center;gap:10px;flex-shrink:0}' +
  '.cnav-btn,.cnav-btn:link,.cnav-btn:visited{' + NAV2_FONT + 'font-size:.85rem;line-height:1.3;padding:8px 14px;border-radius:8px;text-decoration:none;white-space:nowrap;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;margin:0}' +
  '.cnav-ghost,.cnav-ghost:visited{border:1px solid var(--border,#d9d5ca);background:transparent;color:var(--text2,#5a5a52);font-weight:600}' +
  '.cnav-ghost:hover{color:var(--text,#191918);border-color:var(--border2,#c5c0b5)}' +
  '.cnav-main,.cnav-main:visited{border:1px solid var(--accent-btn,#c4522c);background:var(--accent-btn,#c4522c);color:#fff;font-weight:700}' +
  '.cnav-main:hover{background:var(--accent2,#a04f31);border-color:var(--accent2,#a04f31);color:#fff}' +
  '.cnav-cta,.cnav-cta:visited{' + NAV2_FONT + 'font-size:.85rem;line-height:1.3;font-weight:600;color:var(--text2,#5a5a52);background:transparent;border:1px solid var(--border,#d9d5ca);padding:8px 14px;border-radius:8px;text-decoration:none;white-space:nowrap;display:inline-flex;align-items:center}' +
  '.cnav-cta:hover{color:var(--text,#191918);border-color:var(--border2,#c5c0b5);background:transparent}' +
  '.cnav-auth{display:inline-flex;align-items:center;gap:10px}' +
  // Same declarations again at id specificity: the logo block's #nav-auth-static rules
  // (kept for the pre-N1 nav-auth.js during the deploy cache window) would otherwise win.
  '#nav-auth-static .cnav-ghost{' + NAV2_FONT + 'font-size:.85rem;font-weight:600;padding:8px 14px;border:1px solid var(--border,#d9d5ca);border-radius:8px;background:transparent;color:var(--text2,#5a5a52);max-width:none;width:auto;min-height:0}' +
  '#nav-auth-static .cnav-ghost:hover{color:var(--text,#191918);border-color:var(--border2,#c5c0b5)}' +
  '#nav-auth-static .cnav-main{' + NAV2_FONT + 'font-size:.85rem;font-weight:700;padding:8px 14px;border:1px solid var(--accent-btn,#c4522c);border-radius:8px;background:var(--accent-btn,#c4522c);color:#fff;max-width:none;width:auto;min-height:0}' +
  '#nav-auth-static .cnav-main:hover{background:var(--accent2,#a04f31);border-color:var(--accent2,#a04f31);color:#fff}' +
  '.cnav-acctbtn{' + NAV2_FONT + 'font-size:.74rem;font-weight:700;letter-spacing:.06em;line-height:1.3;padding:8px 12px;border-radius:8px;display:inline-flex;align-items:center;gap:8px;cursor:pointer;border:1px solid var(--border,#d9d5ca);background:transparent;color:var(--text2,#5a5a52);white-space:nowrap;margin:0}' +
  '.cnav-acctbtn:hover,.cnav-acctbtn[aria-expanded="true"]{background:rgba(0,0,0,.05);color:var(--text,#191918)}' +
  '.cnav-acctbtn:has(.enrolled){border-color:rgba(45,122,95,.3);background:rgba(45,122,95,.1);color:var(--green,#2d7a5f)}' +
  '.cnav-acctbtn:has(.enrolled):hover,.cnav-acctbtn:has(.enrolled)[aria-expanded="true"]{background:rgba(45,122,95,.16);color:var(--green,#2d7a5f)}' +
  'nav .cnav-acctbtn .user-badge,nav .cnav-acctbtn .cnav-badge{font:inherit;letter-spacing:inherit;padding:0;border:0;background:none;color:inherit;border-radius:0}' +
  '.cnav-badge{' + NAV2_FONT + 'font-size:.7rem;font-weight:700;letter-spacing:.06em;color:var(--text2,#5a5a52)}' +
  '.cnav-badge.enrolled{color:var(--green,#2d7a5f)}' +
  'nav:not(.cnav-in) .cnav-acct{display:none!important}' +
  'nav.cnav-in .cnav-out{display:none!important}' +
  '.cnav-burger{display:none;margin-left:auto;width:48px;height:48px;border:1px solid var(--border,#d9d5ca);background:var(--surface,#fff);border-radius:10px;align-items:center;justify-content:center;cursor:pointer;padding:0;flex-shrink:0;color:var(--text,#191918)}' +
  '.cnav-burger svg{display:block}' +
  '.cnav-burger .ic-close{display:none}' +
  '.cnav-burger[aria-expanded="true"] .ic-open{display:none}' +
  '.cnav-burger[aria-expanded="true"] .ic-close{display:block}' +
  '.cnav-item:focus-visible,.cnav-btn:focus-visible,.cnav-cta:focus-visible,.cnav-acctbtn:focus-visible,.cnav-burger:focus-visible,.cnav-ml:focus-visible,nav .cnav .logo:focus-visible{outline:2px solid var(--accent-text,#b04928);outline-offset:2px}' +
  '.cnav-mob{display:none;position:absolute;top:100%;left:0;right:0;padding:16px 16px 28px;background:var(--bg,#f5f3ea);border-bottom:1px solid var(--border,#d9d5ca);box-shadow:0 8px 24px rgba(0,0,0,.08);max-height:calc(100vh - var(--banner-h,0px) - 73px);max-height:calc(100dvh - var(--banner-h,0px) - 73px);overflow-y:auto;overscroll-behavior:contain;' + NAV2_FONT + '}' +
  '.cnav-mob.open{display:block}' +
  '.cnav-ml,.cnav-ml:link,.cnav-ml:visited{display:flex;justify-content:space-between;align-items:center;min-height:48px;padding:0 4px;font-size:1rem;line-height:1.3;color:var(--text,#191918);text-decoration:none;border-bottom:1px solid var(--border,#d9d5ca);margin:0}' +
  '.cnav-ml span{color:inherit}' +
  '.cnav-ml:hover,.cnav-ml:hover span{color:var(--accent-text,#b04928)}' +
  '.cnav-ml-main{font-weight:700}' +
  '.cnav-mh{font-size:.7rem;font-weight:700;letter-spacing:.08em;color:var(--accent-text,#b04928);margin:22px 4px 4px}' +
  '.cnav-mauth{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:8px}' +
  '.cnav-mauth .cnav-btn{min-height:48px}' +
  '.cnav-mcard{background:var(--surface,#fff);border:1px solid var(--border,#d9d5ca);border-radius:12px;padding:12px 14px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:10px}' +
  '.cnav-mcard .cnav-btn{min-height:44px}' +
  '.cnav-memail{display:block;font-size:.85rem;line-height:1.4;color:var(--text3,#6f6f66);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px}' +
  'nav .cnav-mob .mobile-nav-user{display:none}' +
  'nav .cnav-mob .mobile-nav-user.nav-signed-in{display:flex}' +
  'nav .cnav-mob .user-email{display:block;max-width:210px;font-size:.85rem;color:var(--text3,#6f6f66)}' +
  '@media(max-width:1199px){nav .cnav>.cnav-item,nav .cnav>.cnav-dd,nav .cnav>.cnav-right{display:none!important}nav .cnav-burger{display:flex}}' +
  '@media(min-width:1200px){.cnav-mob{display:none!important}}';
// Synchronous hint for the static and blog pages: a visitor whose last sign-in
// left the cca_logged_in hint sees the account button before nav-auth.js loads.
// nav-auth.js later confirms or corrects it. The homepage does not use this:
// app.js's updateNavUI() drives its ids directly, exactly as before.
const NAV2_HINT =
  '(function(){try{var e=localStorage.getItem("cca_logged_in");if(!e)return;var r=document.querySelector("nav .cnav");if(!r)return;var n=r.parentNode;n.classList.add("cnav-in");' +
  'var p=localStorage.getItem("cca_products")||(localStorage.getItem("cca_enrolled")==="true"?"ccar":"");' +
  'var t=p==="both"?"ENROLLED \\u00B7 BOTH":p==="ccdv"?"ENROLLED \\u00B7 CCDV-F":p==="ccar"?"ENROLLED \\u00B7 CCAR-F":"FREE";' +
  'n.querySelectorAll("[data-acct-email]").forEach(function(x){x.textContent=e;});' +
  'n.querySelectorAll("[data-acct-badge]").forEach(function(x){x.textContent=t;x.className="cnav-badge "+(p?"enrolled":"free");});}catch(x){}})();';
// Behaviour: dropdowns open on click or tap, one at a time; click outside or
// Escape closes; the burger toggles the mobile panel. On the homepage only,
// links that have an in-page equivalent (Practice Tests, Lessons, Progress,
// My dashboard, Log In, Sign Up Free, Log out) run it instead of navigating;
// the hrefs stay valid for everyone else. Every lookup is null-guarded.
const NAV2_SCRIPT =
  '(function(){var root=document.querySelector("nav .cnav");if(!root)return;var nav=root.parentNode;' +
  'function closeAll(){nav.querySelectorAll(".cnav-dd.open").forEach(function(d){d.classList.remove("open");var b=d.querySelector("button");if(b)b.setAttribute("aria-expanded","false");});}' +
  'nav.querySelectorAll(".cnav-dd>button").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();var d=b.parentNode,was=d.classList.contains("open");closeAll();if(!was){d.classList.add("open");b.setAttribute("aria-expanded","true");}});});' +
  'document.addEventListener("click",function(){closeAll();});' +
  'var burger=document.getElementById("cnav-burger"),mob=document.getElementById("cnav-mob");' +
  'function setMob(o){if(!burger||!mob)return;mob.classList.toggle("open",o);burger.setAttribute("aria-expanded",o?"true":"false");burger.setAttribute("aria-label",o?"Close menu":"Open menu");}' +
  'if(burger&&mob)burger.addEventListener("click",function(e){e.stopPropagation();setMob(!mob.classList.contains("open"));});' +
  'document.addEventListener("keydown",function(e){if(e.key!=="Escape")return;var o=nav.querySelector(".cnav-dd.open>button");closeAll();if(o)o.focus();if(mob&&mob.classList.contains("open")){setMob(false);if(burger)burger.focus();}});' +
  'nav.addEventListener("click",function(e){var a=e.target.closest("[data-go],[data-auth],[data-logout]");if(!a||!nav.contains(a))return;' +
  'var home=!!document.getElementById("home-section");' +
  'if(a.hasAttribute("data-go")){if(home&&typeof showSection==="function"){e.preventDefault();closeAll();setMob(false);showSection(a.getAttribute("data-go"));}}' +
  'else if(a.hasAttribute("data-auth")){if(home&&typeof openAuthModal==="function"){e.preventDefault();closeAll();setMob(false);openAuthModal(a.getAttribute("data-auth"));}}' +
  'else if(a.hasAttribute("data-logout")){e.preventDefault();closeAll();setMob(false);if(home&&typeof logOut==="function")logOut();else if(window.__navSO)window.__navSO();}});' +
  '})();';

const NAV2_ARCH = [
  ['/cca-practice-questions/', 'CCAR-F Practice Questions', '500 practice questions with explanations', ''],
  ['/?hub=practice-tests', 'Practice Dashboard', 'All CCAR-F test modes in one place', ''],
  ['/?startTest=quick', 'Free 10-Question Sprint', 'Try the question style, no account needed', ''],
  ['/cca-foundations-exam/', 'Full Mock Exam', '60 questions in 120 minutes', ''],
  ['/diagnostic/', 'Diagnostic', '10 questions, no account needed', ''],
  ['/study-plan-generator/', 'Study Plan', 'A free schedule built from your exam date', ''],
  ['/register/', 'Exam Info', 'Format, passing score and how to book', ' aria-label="Official Claude Certified Architect exam registration on Anthropic\'s site"']
];
// B3 (Oct 2026): the Developer dropdown that fills the slot N1 left empty.
const NAV2_DEV = [
  ['/ccdv-f-practice-questions/', 'CCDV-F Practice Questions', '500 questions across all eight domains', ''],
  ['/?hub=practice-tests&product=ccdv', 'Practice Dashboard', 'All CCDV-F test modes in one place', ''],
  ['/?startTest=quick&product=ccdv', 'Free 10-Question Sprint', 'Try the question style, no payment', ''],
  ['/ccdv-f-mock-exam/', 'Full Mock Exam', '53 questions in 120 minutes', ''],
  ['/blog/ccdv-f-vs-ccar-f-claude-developer-exam/', 'CCDV-F vs CCAR-F', 'Which exam fits your role', ''],
  ['/ccdv-f-exam-guide/', 'Exam Info', 'Format, domains, scoring and how to book', '']
];
const NAV2_RES = [
  ['/cca-exam-guide/', 'CCAR-F Exam Guide'],
  ['/ccdv-f-exam-guide/', 'CCDV-F Exam Guide'],
  ['/blog/',           'Blog'],
  ['/faq/',            'FAQ']
];

// opts: { logo, family: 'home'|'static'|'blog', activePage, heights }
function renderNavInner(opts) {
  const A = opts.activePage || '';
  const H = opts.heights;
  const isHome = opts.family === 'home';
  const isRegister = A === '/register/';
  const act = href => href === A ? ' active" aria-current="page' : '';
  const L = [];
  L.push('<div class="inner cnav">');
  L.push('    ' + opts.logo);
  L.push('    <a href="/?hub=practice-tests" class="cnav-item' + (A === '/?hub=practice-tests' ? ' active' : '') + '"' + (isHome ? ' data-nav="dashboard" data-go="dashboard"' : '') + '>Practice Tests</a>');
  if (isHome) {
    L.push('    <a href="#lessons-section" class="cnav-item" data-nav="lessons" data-go="lessons" id="nav-lessons-link" style="display:none">Lessons</a>');
    L.push('    <a href="#progress-section" class="cnav-item" data-nav="progress" data-go="progress" id="nav-progress-link" style="display:none">Progress</a>');
  }
  const archOn = NAV2_ARCH.some(r => r[0] === A);
  L.push('    <div class="cnav-dd"><button type="button" class="cnav-item' + (archOn ? ' on' : '') + '" aria-expanded="false" aria-haspopup="true">Architect ' + NAV2_CHEV + '</button>');
  L.push('      <div class="cnav-panel">');
  L.push('        <div class="cnav-ph">CLAUDE CERTIFIED ARCHITECT (CCAR-F)</div>');
  NAV2_ARCH.forEach(r => {
    L.push('        <div class="cnav-row"><a href="' + r[0] + '" class="cnav-rl' + act(r[0]) + '"' + r[3] + '>' + r[1] + '</a><div class="cnav-rd">' + r[2] + '</div></div>');
  });
  L.push('      </div></div>');
  const devOn = NAV2_DEV.some(r => r[0] === A);
  L.push('    <div class="cnav-dd"><button type="button" class="cnav-item' + (devOn ? ' on' : '') + '" aria-expanded="false" aria-haspopup="true">Developer ' + NAV2_CHEV + '</button>');
  L.push('      <div class="cnav-panel">');
  L.push('        <div class="cnav-ph">CLAUDE CERTIFIED DEVELOPER (CCDV-F)</div>');
  NAV2_DEV.forEach(r => {
    L.push('        <div class="cnav-row"><a href="' + r[0] + '" class="cnav-rl' + act(r[0]) + '"' + r[3] + '>' + r[1] + '</a><div class="cnav-rd">' + r[2] + '</div></div>');
  });
  L.push('      </div></div>');
  const resOn = NAV2_RES.some(r => r[0] === A);
  L.push('    <div class="cnav-dd"><button type="button" class="cnav-item' + (resOn ? ' on' : '') + '" aria-expanded="false" aria-haspopup="true">Resources ' + NAV2_CHEV + '</button>');
  L.push('      <div class="cnav-panel cnav-panel-sm">');
  NAV2_RES.forEach(r => {
    L.push('        <div class="cnav-row"><a href="' + r[0] + '" class="cnav-rl' + act(r[0]) + '">' + r[1] + '</a></div>');
  });
  L.push('      </div></div>');
  L.push('    <div class="cnav-right">');
  if (isRegister) L.push('      <a href="#register-action" class="cnav-cta" aria-label="Jump to the exam registration portal link below">Register</a>');
  if (isHome) {
    L.push('      <span class="cnav-auth" id="nav-logged-out"><a href="/?login=true" class="cnav-btn cnav-ghost" data-auth="login">Log In</a><a href="/?signup=true" class="cnav-btn cnav-main" data-auth="signup">Sign Up Free</a></span>');
    L.push('      <div class="cnav-dd" id="nav-logged-in" style="display:none"><button type="button" class="cnav-acctbtn" aria-expanded="false" aria-haspopup="true"><span class="user-badge free" id="nav-user-badge">FREE</span>' + NAV2_CHEV + '</button>');
    L.push('        <div class="cnav-panel cnav-panel-r">');
    L.push('          <div class="cnav-rd cnav-signed">Signed in as <span id="nav-user-email"></span></div>');
  } else {
    L.push('      <span class="cnav-auth cnav-out" id="nav-auth-static"><a href="/?login=true" class="cnav-btn cnav-ghost nav-auth-login">Log In</a><a href="/?signup=true" class="cnav-btn cnav-main nav-auth-signup">Sign Up Free</a></span>');
    L.push('      <div class="cnav-dd cnav-acct" id="nav-auth-in"><button type="button" class="cnav-acctbtn" id="nav-acct-btn" aria-expanded="false" aria-haspopup="true"><span class="cnav-badge free" data-acct-badge>FREE</span>' + NAV2_CHEV + '</button>');
    L.push('        <div class="cnav-panel cnav-panel-r">');
    L.push('          <div class="cnav-rd cnav-signed">Signed in as <span data-acct-email></span></div>');
  }
  L.push('          <div class="cnav-row"><a href="/?hub=practice-tests" class="cnav-rl" data-go="dashboard">My dashboard</a></div>');
  L.push('          <div class="cnav-row"><button type="button" class="cnav-rl" data-logout>Log out</button></div>');
  L.push('        </div></div>');
  L.push('    </div>');
  L.push('    <button type="button" class="cnav-burger" id="cnav-burger" aria-label="Open menu" aria-expanded="false" aria-controls="cnav-mob"><svg class="ic-open" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="2" fill="none"/></svg><svg class="ic-close" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" fill="none"/></svg></button>');
  L.push('</div>');
  L.push('<div class="cnav-mob" id="cnav-mob">');
  if (isHome) {
    L.push('  <div class="cnav-mauth"><a href="/?login=true" class="cnav-btn cnav-ghost" id="mobile-nav-login" data-auth="login">Log In</a><a href="/?signup=true" class="cnav-btn cnav-main" id="mobile-nav-signup" data-auth="signup">Sign Up Free</a></div>');
    L.push('  <div class="cnav-mcard mobile-nav-user" id="mobile-nav-user"><div><span class="user-badge free" id="mobile-nav-user-badge">FREE</span><span class="user-email" id="mobile-nav-user-email"></span></div><button type="button" class="cnav-btn cnav-ghost" data-logout>Log out</button></div>');
  } else {
    L.push('  <div class="cnav-mauth cnav-out"><a href="/?login=true" class="cnav-btn cnav-ghost">Log In</a><a href="/?signup=true" class="cnav-btn cnav-main">Sign Up Free</a></div>');
    L.push('  <div class="cnav-mcard cnav-acct"><div><span class="cnav-badge free" data-acct-badge>FREE</span><span class="cnav-memail" data-acct-email></span></div><button type="button" class="cnav-btn cnav-ghost" data-logout>Log out</button></div>');
  }
  if (isRegister) L.push('  <a href="#register-action" class="cnav-ml cnav-ml-main" aria-label="Jump to the exam registration portal link below">Register<span aria-hidden="true">&rsaquo;</span></a>');
  L.push('  <a href="/?hub=practice-tests" class="cnav-ml cnav-ml-main"' + (isHome ? ' data-go="dashboard"' : '') + '>Practice Tests<span aria-hidden="true">&rsaquo;</span></a>');
  if (isHome) {
    L.push('  <a href="#lessons-section" class="cnav-ml" id="mobile-nav-lessons-link" data-go="lessons" style="display:none">Lessons<span aria-hidden="true">&rsaquo;</span></a>');
    L.push('  <a href="#progress-section" class="cnav-ml" id="mobile-nav-progress-link" data-go="progress" style="display:none">Progress<span aria-hidden="true">&rsaquo;</span></a>');
  }
  L.push('  <div class="cnav-mh">ARCHITECT (CCAR-F)</div>');
  NAV2_ARCH.forEach(r => {
    L.push('  <a href="' + r[0] + '" class="cnav-ml' + (r[0] === A ? ' active" aria-current="page' : '') + '"' + r[3] + '>' + r[1] + '<span aria-hidden="true">&rsaquo;</span></a>');
  });
  L.push('  <div class="cnav-mh">DEVELOPER (CCDV-F)</div>');
  NAV2_DEV.forEach(r => {
    L.push('  <a href="' + r[0] + '" class="cnav-ml' + (r[0] === A ? ' active" aria-current="page' : '') + '"' + r[3] + '>' + r[1] + '<span aria-hidden="true">&rsaquo;</span></a>');
  });
  L.push('  <div class="cnav-mh">RESOURCES</div>');
  NAV2_RES.forEach(r => {
    L.push('  <a href="' + r[0] + '" class="cnav-ml' + (r[0] === A ? ' active" aria-current="page' : '') + '">' + r[1] + '<span aria-hidden="true">&rsaquo;</span></a>');
  });
  L.push('</div>');
  let css = NAV2_CSS + 'nav .cnav{height:' + H.desk + 'px}@media(max-width:1199px){nav .cnav{height:' + H.mob + 'px}}';
  if (H.narrow) css += '@media(max-width:640px){nav .cnav{height:' + H.narrow + 'px}}';
  L.push('<style>' + css + '</style>');
  L.push('<script>' + (isHome ? '' : NAV2_HINT) + NAV2_SCRIPT + '<' + '/script>');
  return L.join('\n');
}
function navHeightsFor(family, activePage) {
  if (family === 'home') return NAV2_HEIGHTS.home;
  if (family === 'blog') return NAV2_HEIGHTS.blog;
  if (activePage === '/register/') return NAV2_HEIGHTS.register;
  if (activePage === '/diagnostic/') return NAV2_HEIGHTS.diagnostic;
  return NAV2_HEIGHTS.static;
}
function wrapNav(navHtml) {
  return NAV2_START + '\n      ' + navHtml + '\n      ' + NAV2_END;
}
// NAVGEN-END

function renderNav(activePage) {
  return renderNavInner({
    logo: LOGO_START + LOGO_HTML + LOGO_END,
    family: 'static',
    activePage: activePage,
    heights: navHeightsFor('static', activePage)
  });
}

function spliceNav(html, navHtml) {
  const wrapped = wrapNav(navHtml);
  if (NAV_RE.test(html)) return html.replace(NAV_RE, wrapped);
  return html; // no nav markers found: skip silently
}

// ── Footer injection ──────────────────────────────────────────────────────────
const FOOTER_START   = '<!-- cca:footer:start -->';
const FOOTER_END     = '<!-- cca:footer:end -->';
const FOOTER_RE      = /<!-- cca:footer:start -->[\s\S]*?<!-- cca:footer:end -->/;
const FOOTER_EL_RE   = /<footer[^>]*>[\s\S]*?<\/footer>/;

const FOOTER_NAV_PAGES = [
  ['/',                       'Home'          ],
  ['/cca-foundations-exam/',  'Full Mock Exam'],
  ['/?hub=practice-tests',    'Practice Tests'],
  ['/cca-practice-questions/','Question Bank' ],
  ['/ccdv-f-practice-questions/','Developer (CCDV-F)' ],
  ['/cca-exam-guide/',        'CCAR-F Exam Guide'],
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
    `<p class="footer-disclaimer">CCA Practice Platforms is an independent exam-preparation resource. We are not affiliated with, endorsed by, sponsored by, or authorized by Anthropic, and this is not the official Claude Certified Architect or Claude Certified Developer exam or certification. 'Claude', 'Claude Certified Architect', 'Claude Certified Developer' and 'CCA' are trademarks of Anthropic, PBC, used here only to identify the exams our materials help you prepare for.</p>\n` +
    `<p style="margin-top:8px;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.78rem;color:var(--text3)"><a href="/privacy/">Privacy Policy</a> &middot; <a href="/terms/">Terms of Service</a> &middot; <a href="/refund/">Refund Policy</a></p>\n` +
    `<p style="margin-top:8px">© ${year} CCA Practice Platforms · 361 Falls Rd #831, Grafton, WI 53024, USA · Questions? <a href="mailto:support@claudecertifiedarchitects.com">support@claudecertifiedarchitects.com</a></p>`
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
    name: 'CCAR-F Practice Questions',
    description: '400 scenario-based CCA practice questions across all 5 exam domains, with detailed explanations, multiple test modes and domain-weighted scoring. A free 55-question sample needs no account.',
    url: BASE + '/cca-practice-questions/',
    isPartOf: { '@type': 'WebSite', name: schema.course.provider, url: BASE }
  },
  breadcrumb([
    { name: 'Home',                     url: BASE },
    { name: 'CCA Practice Questions',   url: BASE + '/cca-practice-questions/' }
  ])
];

/** Schemas for /ccdv-f-practice-questions (B3, Oct 2026) */
const ccdvQuestionsSchemas = [
  {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: 'CCDV-F Practice Questions',
    description: '400 Claude Certified Developer (CCDV-F) practice questions across all eight exam domains, every answer explained, plus a 53-question mock exam. Try 10 free.',
    url: BASE + '/ccdv-f-practice-questions/',
    isPartOf: { '@type': 'WebSite', name: schema.course.provider, url: BASE }
  },
  {
    // FAQPage for the visible FAQ on ccdv-f-practice-questions/index.html; the
    // mainEntity text must match the page's <h3>/<p> pairs word for word.
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: "How many questions are in the CCDV-F practice bank?",
        acceptedAnswer: { '@type': 'Answer', text: "400 scenario-based questions across the eight domains in Section 6 of the exam guide (CCDV-F), weighted like the guide, including multiple-response items that state how many answers to select." } },
      { '@type': 'Question', name: "How is it different from the CCAR-F practice bank?",
        acceptedAnswer: { '@type': 'Answer', text: "They prepare for different exams. CCAR-F follows the five Architect domains; CCDV-F follows the eight Developer domains, from the API and SDKs to agents, tools, security and model selection. The CCDV-F questions were written separately for the developer guide." } },
      { '@type': 'Question', name: "What do the explanations cover?",
        acceptedAnswer: { '@type': 'Answer', text: "Every CCDV-F question explains why the correct answer is right and why each other option is wrong, with the documentation it is based on named in the explanation." } },
      { '@type': 'Question', name: "Is this the official exam?",
        acceptedAnswer: { '@type': 'Answer', text: "No. We are an independent exam-prep site, not affiliated with Anthropic. Registration for the exam itself happens through Anthropic Partner Academy." } },
      { '@type': 'Question', name: "What if it isn't for me?",
        acceptedAnswer: { '@type': 'Answer', text: "There is a 10-day money-back guarantee: request a full refund within 10 days of purchase." } },
    ]
  },
  breadcrumb([
    { name: 'Home',                     url: BASE },
    { name: 'CCDV-F Practice Questions', url: BASE + '/ccdv-f-practice-questions/' }
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
    a: "The CCA Foundations exam is Anthropic's official certification for professionals who design and build production-grade applications with Claude. It tests practical, scenario-based decision-making across five domains: Agentic Architecture & Orchestration, Claude Code Configuration & Workflows, Prompt Engineering & Structured Output, Tool Design & MCP Integration, and Context Management & Reliability."
  },
  {
    q: 'How many questions are on the CCA Foundations exam, and how long do I have?',
    a: 'The CCA Foundations exam consists of 60 scenario-based items, delivered as a proctored online exam with a 120-minute time limit. Items are multiple-choice and multiple-response — each item states how many responses to select.'
  },
  {
    q: 'What types of questions appear on the CCA Foundations exam?',
    a: "All questions are scenario-based and come in two formats: multiple-choice (select one response) and multiple-response (select more than one) — each item states how many responses to select. You're placed in a realistic situation and must choose the best architectural decision. There are no simple definition or recall questions, which is why hands-on practice matters more than memorizing terminology."
  },
  {
    q: 'What is the passing score for the CCA Foundations exam?',
    a: 'The CCA Foundations exam uses a scaled scoring system from 100 to 1,000. The passing score is 720 out of 1,000 — this is a scaled score, not the percentage of questions you answered correctly.'
  },
  {
    q: 'Is the CCA Foundations exam open-book?',
    a: 'No. The CCA Foundations exam is a proctored, closed-book assessment — you cannot reference documentation, notes, or external resources during the exam. This is why active recall practice, working through questions without looking up the answer first, is the most effective way to prepare.'
  },
  {
    q: 'How much does the CCA Foundations exam cost?',
    a: "The registration fee for the CCA Foundations exam is $125 (USD), paid directly to Anthropic when you schedule your session. It's worth taking our free 10-question diagnostic quiz first to see where you stand against the 720/1,000 passing standard."
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
    a: "Yes. Waiting periods increase with each failed attempt: 14 days after the first, 30 days after the second, and 90 days after the third. You may attempt the exam up to four times within a rolling 12-month period, and the exam fee applies to each attempt. The most effective retake strategy is to use your score breakdown to find your weakest domain, spend most of your retake preparation there, and run one more full timed simulation before attempting again."
  },
  {
    q: 'What are the five CCA Foundations exam domains and how are they weighted?',
    a: 'The exam covers five domains, each weighted differently: Agentic Architecture & Orchestration (27%), Claude Code Configuration & Workflows (20%), Prompt Engineering & Structured Output (20%), Tool Design & MCP Integration (18%), and Context Management & Reliability (15%). Agentic Architecture & Orchestration carries the most weight, so it deserves a proportionally larger share of your study time. Our CCA exam guide breaks down each domain in detail, and our blog covers each one individually, from Domain 1: Agentic Architecture & Orchestration (27%) through to Domain 5: Context Management & Reliability (15%).'
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
    a: 'Work through each of the five domains, take short daily practice sessions to find weak areas, review the explanation for every question (not just the correct answer), and complete at least one full 120-minute timed simulation before exam day. Our CCA practice questions bank and CCA Foundations exam simulator cover all 400 practice questions across the five domains.'
  },
  {
    q: 'What does the CCA Practice Platform include?',
    a: 'The platform covers both Foundations exams: a CCDV-F bank of 400 questions across the eight Developer domains, and, for the CCAR-F exam, 400 scenario-based practice questions across all five exam domains — multiple-choice and multiple-response, matching the mixed format described in the official exam guide — full-length 120-minute timed exam simulations, a free 10-question diagnostic quiz that estimates your readiness against the 720/1,000 passing standard, and a complete exam guide covering format, domain weights, and study strategy.'
  },
  {
    q: "Aren't these questions just AI-generated? Why pay when I could generate my own?",
    a: "You could generate a set of questions, and nothing about ours is secret. What you are paying for is the part a generator cannot do: a person has read every one of the 400 questions against the published CCAR-F (CCA-F) exam guide's task statements, and revises them by hand, one or two questions at a time. Every answer carries a written explanation of why it is right, not just the answer key. And the full-length mock draws its 60 questions from that bank at the guide's published domain weights on every attempt, so the mock is shaped by the published weights rather than by whatever a generator happened to produce."
  },
  {
    q: 'Is this site affiliated with Anthropic?',
    a: "No. The CCA Foundations exam is Anthropic's official certification. CCA Practice Platforms is an independent exam-preparation resource — we are not affiliated with, endorsed by, sponsored by, or authorized by Anthropic, and we do not administer the official exam or certification. 'Claude', 'Claude Certified Architect', and 'CCA' are trademarks of Anthropic. We provide unofficial practice materials — including a free diagnostic quiz, practice questions, and full exam simulations — to help you prepare for the official exam."
  }
];

/** Schemas for /faq */
/** Schemas for /privacy/, /terms/, /refund/ */
const privacySchemas = [
  { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Privacy Policy',
    description: 'Privacy Policy for CCA Practice Platforms.',
    url: BASE + '/privacy/', isPartOf: { '@type': 'WebSite', name: schema.course.provider, url: BASE } },
  // BreadcrumbList removed: /privacy/ has no visible breadcrumb — orphaned schema removed.
];
const termsSchemas = [
  { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Terms of Service',
    description: 'Terms of Service for CCA Practice Platforms.',
    url: BASE + '/terms/', isPartOf: { '@type': 'WebSite', name: schema.course.provider, url: BASE } },
  // BreadcrumbList removed: /terms/ has no visible breadcrumb — orphaned schema removed.
];
const refundSchemas = [
  { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Refund Policy',
    description: 'Refund Policy for CCA Practice Platforms — 10-day money-back guarantee.',
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
  return "<div id=\"site-banner\" role=\"note\" aria-label=\"Independence notice\">Independent exam prep · Not affiliated with or endorsed by Anthropic · Not an official Anthropic exam or certification<button id=\"site-banner-close\" aria-label=\"Dismiss notice\">✕</button></div>\n<script>(function(){var b=document.getElementById(\"site-banner\"),c=document.getElementById(\"site-banner-close\");if(!b)return;if(localStorage.getItem(\"ccaBanner\")===\"0\"){b.style.display=\"none\";document.documentElement.style.setProperty(\"--banner-h\",\"0px\");return;}function setH(){document.documentElement.style.setProperty(\"--banner-h\",b.offsetHeight+\"px\");}setH();window.addEventListener(\"resize\",setH);c.addEventListener(\"click\",function(){b.style.display=\"none\";document.documentElement.style.setProperty(\"--banner-h\",\"0px\");localStorage.setItem(\"ccaBanner\",\"0\");});})()</script>\n" + `<nav aria-label="Main navigation">\n  ` + wrapNav(renderNavInner({
    logo: LOGO_START + LOGO_HTML + LOGO_END,
    family: 'blog',
    activePage: activePage,
    heights: navHeightsFor('blog', activePage)
  })) + `\n</nav>`;
}

/** Shared footer HTML */
function blogFooter() {
  const year = new Date().getFullYear();
  const links = FOOTER_NAV_PAGES
    .map(([href, label]) => `<a href="${href}">${label}</a>`)
    .join(' &nbsp;&middot;&nbsp; ');
  return `<footer class="site-footer">
<!-- cca:footer:start -->
  <p style="margin:0 0 6px">&copy; ${year} CCA Practice Platforms &middot; 361 Falls Rd #831, Grafton, WI 53024, USA</p>
  <p style="margin:0 0 10px;font-size:.82rem">${links}</p>
  <p style="max-width:620px;margin:0 auto;font-size:.85rem;line-height:1.65;color:#c8c8be">CCA Practice Platforms is an independent exam-preparation resource. We are not affiliated with, endorsed by, sponsored by, or authorized by Anthropic, and this is not the official Claude Certified Architect or Claude Certified Developer exam or certification. 'Claude', 'Claude Certified Architect', 'Claude Certified Developer' and 'CCA' are trademarks of Anthropic, PBC, used here only to identify the exams our materials help you prepare for.</p>
  <p style="margin:8px 0 0;font-size:.82rem"><a href="/privacy/">Privacy Policy</a> &middot; <a href="/terms/">Terms of Service</a> &middot; <a href="/refund/">Refund Policy</a></p>
  <p style="margin:8px 0 0;font-size:.82rem">Questions? <a href="mailto:support@claudecertifiedarchitects.com">support@claudecertifiedarchitects.com</a></p>
<!-- cca:footer:end -->
</footer>`;
}

/** Article JSON-LD for a blog post */
function articleJsonLd(post) {
  const img = post.ogImage
    ? (post.ogImage.startsWith('http') ? post.ogImage : BASE + post.ogImage)
    : BASE + '/cca-link-image-v3.jpg';
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.h1 || post.title,
    description: post.description,
    url: `${BASE}/blog/${post.slug}/`,
    datePublished: post.date,
    dateModified: post.updated || post.date,
    image: img,
    publisher: { '@type': 'Organization', name: 'CCA Practice Platforms', url: BASE },
    author:    { '@type': 'Organization', name: 'CCA Practice Platforms', url: BASE },
    isPartOf:  { '@type': 'WebSite', name: 'CCA Practice Platforms', url: BASE }
  };
}

/** Generate one blog post page → blog/<slug>/index.html */
function generateBlogPost(post, _index, allPosts) {
  const ogImg = post.ogImage
    ? (post.ogImage.startsWith('http') ? post.ogImage : BASE + post.ogImage)
    : BASE + '/cca-link-image-v3.jpg';

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
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:alt" content="Claude Certified Architect field guide card: the published exam guide's 720/1000 pass mark, 60 questions, and the five domain weightings.">
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
      <p class="post-meta">By CCA Practice Platforms · <time datetime="${post.date}">${formatDate(post.date)}</time>${post.updated ? ` · Updated <time datetime="${post.updated}">${formatDate(post.updated)}</time>` : ''}</p>
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
<meta property="og:image" content="${BASE}/cca-link-image-v3.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:alt" content="Claude Certified Architect field guide card: the published exam guide's 720/1000 pass mark, 60 questions, and the five domain weightings.">
<meta name="author" content="CCA Practice Platforms">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="CCA Blog | Claude Certified Architect Guides &amp; Study Tips">
<meta name="twitter:description" content="Articles and guides on Claude architecture, prompt engineering, MCP, and passing the CCA Foundations exam.">
<meta name="twitter:image" content="${BASE}/cca-link-image-v3.jpg">
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
<title>Page Not Found · CCA Practice Platforms</title>
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
    { loc: BASE + '/ccdv-f-practice-questions/', priority: '0.9', changefreq: 'weekly',  lastmod: gitLastmod('ccdv-f-practice-questions/index.html') },
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
  console.log('✓ sitemap.xml  (' + today + ', ' + (12 + posts.length) + ' URLs)');
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

processFile(path.join(__dirname, 'ccdv-f-practice-questions', 'index.html'), '/ccdv-f-practice-questions/',
  ...ccdvQuestionsSchemas);

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
