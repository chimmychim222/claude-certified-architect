/**
 * Stripe webhook server — runs on Render.com (free tier).
 * When a customer pays via Stripe, this sets enrolled:true in Firebase.
 *
 * Environment variables to set in Render dashboard:
 *   STRIPE_SECRET_KEY              — Stripe → Developers → API keys → Secret key
 *   STRIPE_WEBHOOK_SECRET          — Stripe → Developers → Webhooks → signing secret
 *   FIREBASE_SERVICE_ACCOUNT_JSON  — full contents of your Firebase service account .json
 *   RESEND_API_KEY                 — Resend → API Keys → Create API Key
 *                                    (domain claudecertifiedarchitects.com must be verified
 *                                    in Resend before emails will send)
 *   ADMIN_API_KEY                  — any long random string you generate yourself;
 *                                    required as the `x-admin-key` header on
 *                                    GET /admin/stale-pending-enrollments.
 *                                    Leaving it unset disables that endpoint entirely.
 *
 *   ALERT_EMAIL_TO   (optional)    — email address to notify when stale (>48h)
 *                                    pending_enrollments are found. Reuses the
 *                                    Resend setup above — no new provider needed.
 *   ALERT_WEBHOOK_URL (optional)   — a Slack or Discord "incoming webhook" URL,
 *                                    notified the same way. Set either/both/
 *                                    neither; with neither set, stale findings
 *                                    just fall back to a console.warn log line
 *                                    (visible in the Render dashboard).
 *
 *   Also see the big comment box above GET /admin/stale-pending-enrollments
 *   below for how to point a free external scheduler (cron-job.org etc.) at
 *   it — that's what makes the stale-enrollment check actually dependable on
 *   a free-tier dyno that sleeps, and keeps the instance warm as a bonus.
 */

const admin      = require('firebase-admin');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const express    = require('express');
const bodyParser = require('body-parser');
const crypto     = require('crypto');

// Constant-time secret comparison. Both sides are SHA-256 hashed first, so a
// wrong-length guess neither throws (timingSafeEqual needs equal lengths) nor
// leaks the secret's length through timing: the compare always runs over two
// 32-byte digests. Used by the admin routes and /nurture-send.
function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
// Unset ADMIN_API_KEY keeps both admin routes disabled, exactly as before.
function adminKeyMatches(req) {
  const key = process.env.ADMIN_API_KEY;
  if (!key) return false;
  const h = req.headers['x-admin-key'];
  return secretMatches(Array.isArray(h) ? h[0] : (h || ''), key);
}

// ── Diagnostic lead-capture hardening ────────────────────────────────────────
// /diagnostic-email is unauthenticated by design (it is the free diagnostic's
// email capture), and this file is served publicly by GitHub Pages, so assume
// the caller has read it. Three layers, in order of importance:
//   1. A strict allowlist of the payload diagnostic/index.html actually posts.
//      Anything else is rejected with 400 and nothing is written or sent.
//   2. HTML escaping of every caller-supplied value before it reaches an
//      email body. The allowlist makes this unreachable for new leads; the
//      nurture builders also read diagnostic_leads documents written BEFORE
//      the allowlist existed, and escaping is what protects those.
//   3. An in-process rate limit per client IP and per address. Render offers
//      no platform-level limiter, and a Free instance spins down after 15
//      idle minutes, so THESE COUNTERS RESET ON EVERY COLD START. Partial
//      mitigation, deliberately not backed by Firestore.

function escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Own-property lookup, so a caller-chosen key such as "constructor" or
// "toString" cannot resolve to a built-in through the prototype chain.
function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

// The five domain labels exactly as diagnostic/index.html's DOMAINS renders
// them (the second carries "& Workflows"; nurtureDomainKey() maps it back to
// the bank's key), each with the label's published exam share.
const DIAG_DOMAIN_WEIGHTS = Object.freeze(Object.assign(Object.create(null), {
  'Agentic Architecture & Orchestration':   27,
  'Claude Code Configuration & Workflows':  20,
  'Prompt Engineering & Structured Output': 20,
  'Tool Design & MCP Integration':          18,
  'Context Management & Reliability':       15,
}));
const DIAG_RESULT_KEYS = ['estimatedScore', 'passScore', 'weakestDomain', 'weakestDomainWeight', 'domains'];
const DIAG_DOMAIN_KEYS = ['label', 'examWeight', 'correct', 'total', 'pct'];
const DIAG_EMAIL_MAX   = 254;
const DIAG_EMAIL_RE    = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function sameKeys(obj, keys) {
  const k = Object.keys(obj);
  return k.length === keys.length && keys.every(x => k.includes(x));
}
function intIn(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; }

// Returns { ok: true, email, results } holding freshly built objects with only
// the validated fields, or { ok: false, error }. Rejects rather than coerces:
// a malformed payload is not a lead.
function validateDiagnosticPayload(body) {
  if (!isPlainObject(body) || !sameKeys(body, ['email', 'results'])) return { ok: false, error: 'Invalid payload' };
  if (typeof body.email !== 'string') return { ok: false, error: 'Invalid email' };
  const email = body.email.trim();
  if (email.length === 0 || email.length > DIAG_EMAIL_MAX || !DIAG_EMAIL_RE.test(email)) {
    return { ok: false, error: 'Invalid email' };
  }

  const r = body.results;
  if (!isPlainObject(r) || !sameKeys(r, DIAG_RESULT_KEYS)) return { ok: false, error: 'Invalid results' };
  if (!intIn(r.estimatedScore, 0, 1000)) return { ok: false, error: 'Invalid estimatedScore' };
  if (!intIn(r.passScore, 0, 1000))      return { ok: false, error: 'Invalid passScore' };
  if (typeof r.weakestDomain !== 'string' || own(DIAG_DOMAIN_WEIGHTS, r.weakestDomain) === undefined) {
    return { ok: false, error: 'Invalid weakestDomain' };
  }
  if (r.weakestDomainWeight !== DIAG_DOMAIN_WEIGHTS[r.weakestDomain]) return { ok: false, error: 'Invalid weakestDomainWeight' };
  if (!Array.isArray(r.domains) || r.domains.length !== 5) return { ok: false, error: 'Invalid domains' };

  const seen    = new Set();
  const domains = [];
  for (const d of r.domains) {
    if (!isPlainObject(d) || !sameKeys(d, DIAG_DOMAIN_KEYS)) return { ok: false, error: 'Invalid domain entry' };
    if (typeof d.label !== 'string' || own(DIAG_DOMAIN_WEIGHTS, d.label) === undefined || seen.has(d.label)) {
      return { ok: false, error: 'Invalid domain label' };
    }
    if (d.examWeight !== DIAG_DOMAIN_WEIGHTS[d.label])          return { ok: false, error: 'Invalid examWeight' };
    if (!intIn(d.total, 0, 60) || !intIn(d.correct, 0, d.total)) return { ok: false, error: 'Invalid domain counts' };
    if (!intIn(d.pct, 0, 100))                                   return { ok: false, error: 'Invalid pct' };
    seen.add(d.label);
    domains.push({ label: d.label, examWeight: d.examWeight, correct: d.correct, total: d.total, pct: d.pct });
  }
  return {
    ok: true,
    email,
    results: {
      estimatedScore:      r.estimatedScore,
      passScore:           r.passScore,
      weakestDomain:       r.weakestDomain,
      weakestDomainWeight: r.weakestDomainWeight,
      domains,
    },
  };
}

// Sliding-window counters in process memory. 10 submissions per IP per 15
// minutes, 3 per address per hour. A genuine visitor submits once, sometimes
// twice after a retake; the page's own cold-start retry only fires on a
// non-2xx, so a 429 is never re-sent as a duplicate lead. Memory is bounded
// by dropping the oldest keys past 5,000 entries.
const DIAG_LIMITS = {
  ip:    { max: 10, windowMs: 15 * 60 * 1000 },
  email: { max: 3,  windowMs: 60 * 60 * 1000 },
};
const diagHits = new Map(); // key -> [hit timestamps within the window]
function diagRateLimited(key, limit, now) {
  now = now || Date.now();
  const arr = (diagHits.get(key) || []).filter(t => now - t < limit.windowMs);
  if (arr.length >= limit.max) { diagHits.set(key, arr); return true; }
  arr.push(now);
  diagHits.set(key, arr);
  if (diagHits.size > 5000) {
    for (const k of diagHits.keys()) { if (diagHits.size <= 4000) break; diagHits.delete(k); }
  }
  return false;
}
// Render sits behind Cloudflare, which sets cf-connecting-ip; fall back to the
// first x-forwarded-for entry, then the socket.
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// express.json() capped far below its 100 KB default (a genuine payload is
// under 1 KB), with parse and size errors turned into a clean JSON rejection
// instead of Express's HTML error page. Applied to /diagnostic-email only.
const diagJsonParser = express.json({ limit: '4kb' });
function diagJson(req, res, next) {
  diagJsonParser(req, res, err => {
    if (err) {
      const status = err.type === 'entity.too.large' ? 413 : 400;
      return res.status(status).json({ error: status === 413 ? 'Payload too large' : 'Invalid JSON' });
    }
    next();
  });
}

// ── Resend helper ─────────────────────────────────────────────────────────────
// Sends transactional email via Resend.com (https://resend.com).
// Uses the built-in fetch available in Node 18+.
// Returns true on success, false on failure (never throws).
// `from` overrides the default sender (the abandoner emails send as the team
// address); `kind` labels the send in the per-day counter below.
async function sendViaResend({ to, subject, text, html, replyTo, listUnsubscribeUrl, from, kind }) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[resend] RESEND_API_KEY not set — email skipped.');
    return false;
  }
  try {
    const payload = {
      from:    from || 'CCA Practice <noreply@claudecertifiedarchitects.com>',
      to:      [to],
      subject,
      text,
    };
    if (html)              payload.html     = html;
    if (replyTo)           payload.reply_to = replyTo;
    if (listUnsubscribeUrl) {
      payload.headers = {
        'List-Unsubscribe':      `<${listUnsubscribeUrl}>, <mailto:support@claudecertifiedarchitects.com?subject=Unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
    }
    const resp = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      const data = await resp.json();
      console.log('[resend] Email sent:', data.id, '→', to);
      countSend(kind || 'other');
      return true;
    } else {
      const errText = await resp.text();
      let errName = null;
      try { errName = JSON.parse(errText).name || null; } catch (_) {}
      if (resp.status === 429) {
        // One distinct, greppable line per Resend quota state: rate_limit_exceeded
        // (per-second), daily_quota_exceeded, monthly_quota_exceeded. Logged
        // only -- no retry, no backoff.
        console.error(`[resend] QUOTA ${errName || 'unknown_429'}:`, resp.status, errText);
      } else {
        console.error('[resend] Send failed:', resp.status, errText);
      }
      return false;
    }
  } catch (err) {
    console.error('[resend] Fetch error:', err.message);
    return false;
  }
}

// Per-UTC-day send counter, email_send_counts/{YYYY-MM-DD}: `total` plus one
// field per kind. Read by the checkout-abandoner runner's volume guard (freeze
// exception 10, Build Schedule row 576). Counts only what THIS process sends;
// Firebase's verification mail goes through Resend SMTP outside it and is not
// counted, which is why that guard stops at 70 of the plan's 100. Best effort:
// a failed counter write is logged and never fails the send that was made.
function sendCountRef(d) {
  return db.collection('email_send_counts').doc((d || new Date()).toISOString().slice(0, 10));
}
function countSend(kind) {
  const inc = admin.firestore.FieldValue.increment(1);
  sendCountRef().set(
    { total: inc, [kind]: inc, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  ).catch(e => console.warn('[sendcount] write failed:', e.message));
}

// ── GA4 Measurement Protocol purchase event ───────────────────────────────────
// Fires a server-side 'purchase' event to GA4 after every successful enrollment.
// This is additive to the client-side event in app.js — GA4 deduplicates on
// transaction_id, so if both arrive only one conversion is counted.
//
// Using the Stripe session ID as transaction_id is intentional: it's the same
// value the client-side maybeFireExamPurchaseEvent uses (via stripeSessionId in
// the users/{uid} Firestore doc), which is exactly what enables deduplication.
//
// If GA4_MEASUREMENT_ID or GA4_MP_API_SECRET are not set, this skips silently —
// a missing analytics config must never prevent a real enrollment from landing.
async function fireGA4PurchaseEvent(sessionId, ga4ClientId, uid, gclidAw, ga4SessionId, ga4SessionNumber) {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret     = process.env.GA4_MP_API_SECRET;

  if (!measurementId || !apiSecret) {
    console.warn('[GA4] GA4_MEASUREMENT_ID or GA4_MP_API_SECRET not set — purchase event skipped.');
    return;
  }

  // GA4 requires a client_id. The _ga-cookie-derived value gives proper
  // attribution back to ad clicks; the firebase_ prefix fallback is weaker
  // (no session history in GA4 to tie to) but still records the conversion.
  const clientId = ga4ClientId || ('firebase_' + uid);
  if (!ga4ClientId) {
    console.log(`[GA4] No ga4ClientId for uid=${uid} — using fallback client_id; ad-click attribution may be absent.`);
  }

  const url =
    'https://www.google-analytics.com/mp/collect' +
    `?measurement_id=${encodeURIComponent(measurementId)}` +
    `&api_secret=${encodeURIComponent(apiSecret)}`;

  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
          client_id: clientId,
          events: [{
            name:   'purchase',
            params: Object.assign(
              {
                currency:       'USD',
                value:          49.0,
                transaction_id: sessionId,
                items: [{ item_id: 'cca_exam_prep', item_name: 'CCA Exam Prep', price: 49.0, quantity: 1 }],
              },
              // session_id + session_number stitch this server-side hit to the
              // original browser session so GA4 reports source/medium correctly
              // instead of "(not set) / (not set)".
              ga4SessionId     ? { session_id:     String(ga4SessionId) }     : {},
              ga4SessionNumber ? { session_number: Number(ga4SessionNumber) } : {}
            ),
          }],
        }),
    });
    // GA4 MP returns 204 No Content on success
    if (resp.ok) {
      console.log(`[GA4] purchase event sent: stripe=${sessionId} client_id=${clientId} session_id=${ga4SessionId || '(none)'} gclid=${gclidAw ? gclidAw.replace(/^GCL\.\d+\./, '') : '(none)'}`);
    } else {
      const body = await resp.text().catch(() => '');
      console.warn(`[GA4] purchase event failed: HTTP ${resp.status} ${body}`);
    }
  } catch (err) {
    console.warn('[GA4] purchase event error:', err.message);
  }
}

// ── Firebase init ─────────────────────────────────────────────────────────────
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const auth = admin.auth();
// IMPORTANT — do NOT use admin.firestore() (no args) here.
// This project's Firestore database has the custom database ID "default"
// (a literal, named database) — NOT the SDK's special reserved "(default)"
// database that admin.firestore() connects to by default. The "(default)"
// database is empty for this project, so admin.firestore() silently returns
// "5 NOT_FOUND" for every single read/write, while looking like a normal
// client (no error at init time). Confirmed empirically with
// scripts/diagnose-firestore.js — see that file's history for the trace.
// Must explicitly target the "default"-named database:
const { getFirestore } = require('firebase-admin/firestore');
const db   = getFirestore(admin.app(), 'default');
const app  = express();

// ── Global CORS — must come before all routes ─────────────────────────────────
app.use((req, res, next) => {
  const allowed = [
    'https://claudecertifiedarchitects.com',
    'https://www.claudecertifiedarchitects.com',
  ];
  const origin = req.headers.origin;
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Stripe webhook ────────────────────────────────────────────────────────────
app.post(
  '/stripe-webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type !== 'checkout.session.completed') {
      return res.json({ skipped: true, type: event.type });
    }

    // ── Event-id dedupe ── after the signature check and the type filter, before
    // any write. create() with the existence precondition is one atomic write:
    // ALREADY_EXISTS (gRPC code 6) means this event id was already processed and
    // is skipped. The record is written FIRST and released in every failure exit
    // below, so a Stripe retry after a partial failure is NOT skipped. Any other
    // store error fails OPEN: a dedupe outage must never block a real enrolment.
    const eventRef = db.collection('stripe_events').doc(event.id);
    try {
      await eventRef.create({
        type:       event.type,
        sessionId:  (event.data && event.data.object && event.data.object.id) || null,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      if (err.code === 6 || /ALREADY_EXISTS/.test(String(err.message))) {
        console.log(`[stripe] duplicate event skipped: ${event.id}`);
        return res.json({ ok: true, duplicate: true, id: event.id });
      }
      console.warn(`[stripe] dedupe store error for ${event.id}, proceeding (fail open):`, err.message);
    }
    const releaseEvent = () => eventRef.delete().catch(() => {});

    const session           = event.data.object;
    const customerEmail     = session.customer_details?.email || session.customer_email;
    const clientReferenceId = session.client_reference_id || null;

    // ── Logged-in checkout: client_reference_id carries the Firebase UID of
    // the account that started checkout (set by openPaymentModal in app.js).
    // Enroll THAT account directly, regardless of what email was typed at
    // Stripe — this is the fix for the email-mismatch/double-payment bug
    // class, where a typo'd or different checkout email orphaned the
    // purchase in pending_enrollments and left the paying account locked out.
    // Only fall through to the email-based lookup below for genuinely
    // logged-out checkouts (no client_reference_id) or if this uid is
    // somehow stale (e.g. the account was deleted between checkout and now).
    if (clientReferenceId) {
      try {
        const userRecord     = await auth.getUser(clientReferenceId);
        const uid            = userRecord.uid;
        const existingClaims = userRecord.customClaims || {};

        // Read GA4 attribution data the client wrote to Firestore before
        // redirecting to checkout — used for the MP purchase event below.
        let ga4ClientId    = null;
        let gclidAw        = null;
        let ga4SessionId   = null;
        let ga4SessionNumber = null;
        try {
          const attrSnap = await db.collection('users').doc(uid).get();
          if (attrSnap.exists) {
            const d = attrSnap.data();
            ga4ClientId    = d.ga4ClientId     || null;
            gclidAw        = d.gclid_aw        || null;
            ga4SessionId   = d.ga4SessionId    || null;
            ga4SessionNumber = d.ga4SessionNumber != null ? d.ga4SessionNumber : null;
          }
        } catch (e) { /* best-effort, never block enrollment */ }

        await auth.setCustomUserClaims(uid, { ...existingClaims, enrolled: true });

        await db.collection('users').doc(uid).set(
          {
            enrolled:        true,
            enrolledAt:      admin.firestore.FieldValue.serverTimestamp(),
            email:           customerEmail || userRecord.email,
            stripeSessionId: session.id,
            ...(gclidAw ? { gclid_aw: gclidAw } : {}),
          },
          { merge: true }
        );

        // Clean up any pending record left over from an earlier checkout
        // attempt under a different (typo'd/mismatched) email.
        if (customerEmail) {
          db.collection('pending_enrollments').doc(customerEmail.toLowerCase()).delete().catch(() => {});
        }

        console.log(`Enrolled via client_reference_id: ${customerEmail || userRecord.email} (${uid})`);
        // Fire server-side GA4 purchase event — additive, deduped by transaction_id.
        fireGA4PurchaseEvent(session.id, ga4ClientId, uid, gclidAw, ga4SessionId, ga4SessionNumber).catch(() => {});
        return res.json({ ok: true, enrolled: uid });
      } catch (err) {
        console.warn(`client_reference_id lookup failed (${clientReferenceId}):`, err.message);
        // fall through to email-based lookup below
      }
    }

    if (!customerEmail) {
      console.error('No customer email in event');
      releaseEvent(); return res.status(400).send('No customer email found');
    }

    // Look up the Firebase account for this email. If none exists yet — the
    // customer paid before signing up, or checked out with a different email
    // than they'll use to create their account — stash the purchase as a
    // "pending enrollment" so /claim-enrollment can apply it later, once a
    // matching account shows up. Returning 200 here (instead of 500) tells
    // Stripe delivery succeeded; otherwise it retries for up to 3 days and
    // then silently gives up, permanently losing the enrollment.
    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(customerEmail);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        try {
          await db.collection('pending_enrollments').doc(customerEmail.toLowerCase()).set(
            {
              email:           customerEmail,
              stripeSessionId: session.id,
              createdAt:       admin.firestore.FieldValue.serverTimestamp(),
              // Lifecycle: unclaimed -> contacted (a human emailed them) ->
              // abandoned. Terminal states stop the alert and never delete, so
              // a buyer turning up in six months still claims. The record IS
              // deleted on a successful /claim-enrollment, by the two
              // direct-enrol paths above, and by the zombie guard in
              // findStalePendingEnrollments once an enrolled account exists at
              // this email (non-terminal records only).
              // Records written before this field existed read as unclaimed.
              status:          'unclaimed',
            },
            { merge: true }
          );
          console.log(`Pending enrollment stashed (no account yet): ${customerEmail}`);
          return res.json({ ok: true, pending: true });
        } catch (stashErr) {
          console.error('Failed to stash pending enrollment:', stashErr.message);
          releaseEvent(); return res.status(500).send(stashErr.message);
        }
      }
      console.error('Enrollment lookup error:', err.message);
      releaseEvent(); return res.status(500).send(err.message);
    }

    try {
      const uid            = userRecord.uid;
      const existingClaims = userRecord.customClaims || {};

      // Read GA4 attribution data — present if user was logged in at checkout.
      let ga4ClientId    = null;
      let gclidAw        = null;
      let ga4SessionId   = null;
      let ga4SessionNumber = null;
      try {
        const attrSnap = await db.collection('users').doc(uid).get();
        if (attrSnap.exists) {
          const d = attrSnap.data();
          ga4ClientId    = d.ga4ClientId     || null;
          gclidAw        = d.gclid_aw        || null;
          ga4SessionId   = d.ga4SessionId    || null;
          ga4SessionNumber = d.ga4SessionNumber != null ? d.ga4SessionNumber : null;
        }
      } catch (e) { /* best-effort */ }

      await auth.setCustomUserClaims(uid, { ...existingClaims, enrolled: true });

      await db.collection('users').doc(uid).set(
        {
          enrolled:        true,
          enrolledAt:      admin.firestore.FieldValue.serverTimestamp(),
          email:           customerEmail,
          stripeSessionId: session.id,
          ...(gclidAw ? { gclid_aw: gclidAw } : {}),
        },
        { merge: true }
      );

      // Clear any stale pending record for this email (e.g. a Stripe retry
      // that arrived after the account was created and matched normally).
      db.collection('pending_enrollments').doc(customerEmail.toLowerCase()).delete().catch(() => {});

      console.log(`Enrolled: ${customerEmail} (${uid})`);
      fireGA4PurchaseEvent(session.id, ga4ClientId, uid, gclidAw, ga4SessionId, ga4SessionNumber).catch(() => {});
      return res.json({ ok: true, enrolled: uid });

    } catch (err) {
      console.error('Enrollment error:', err.message);
      releaseEvent(); return res.status(500).send(err.message);
    }
  }
);

// ── Claim a pending enrollment ────────────────────────────────────────────────
// POST /claim-enrollment
// Header: Authorization: Bearer <Firebase ID token>
//
// Covers the "paid before the account existed" gap: when the webhook above
// can't find a Firebase user for the checkout email, it stashes a pending
// enrollment keyed by that email. Once that person signs up or logs in, the
// client calls this endpoint with a verified ID token; if the token's email
// matches a pending record, we apply the enrollment (custom claim + Firestore)
// right then, exactly as the webhook would have.
app.post('/claim-enrollment', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const m = authHeader.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Missing bearer token' });

  let decoded;
  try {
    decoded = await auth.verifyIdToken(m[1]);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const uid   = decoded.uid;
  const email = (decoded.email || '').toLowerCase();
  if (!email) return res.json({ ok: true, enrolled: false });

  try {
    const pendingRef = db.collection('pending_enrollments').doc(email);
    const pendingDoc = await pendingRef.get();
    if (!pendingDoc.exists) {
      return res.json({ ok: true, enrolled: false });
    }

    // No email_verified gate. Stripe has already charged a card against this
    // address, and demanding a second proof of the same address stranded five
    // password sign-ups (Jul-Sep 2026) while Google sign-ups claimed instantly.
    // The impostor it guarded against (sign up under a buyer's address after
    // they pay, before they sign up) can already reach the same result in the
    // other order through the webhook's direct-enrol path, which has no such
    // check; and the real buyer recovers the account by password reset.
    // Logged, not blocked, so a dispute can be traced in the Render log.
    if (!decoded.email_verified) {
      console.log(`[claim] unverified account claiming pending enrollment: ${email} (${uid})`);
    }

    const pending        = pendingDoc.data();
    const userRecord     = await auth.getUser(uid);
    const existingClaims = userRecord.customClaims || {};

    // Read attribution data before the enrollment write so gclid_aw can be
    // included in the Firestore record (for Stripe→ad-click cross-referencing).
    let ga4ClientId    = null;
    let gclidAw        = null;
    let ga4SessionId   = null;
    let ga4SessionNumber = null;
    try {
      const attrSnap = await db.collection('users').doc(uid).get();
      if (attrSnap.exists) {
        const d = attrSnap.data();
        ga4ClientId    = d.ga4ClientId     || null;
        gclidAw        = d.gclid_aw        || null;
        ga4SessionId   = d.ga4SessionId    || null;
        ga4SessionNumber = d.ga4SessionNumber != null ? d.ga4SessionNumber : null;
      }
    } catch (e) { /* best-effort */ }

    await auth.setCustomUserClaims(uid, { ...existingClaims, enrolled: true });
    await db.collection('users').doc(uid).set(
      {
        enrolled:        true,
        enrolledAt:      admin.firestore.FieldValue.serverTimestamp(),
        email:           userRecord.email,
        stripeSessionId: pending.stripeSessionId || null,
        ...(gclidAw ? { gclid_aw: gclidAw } : {}),
      },
      { merge: true }
    );
    await pendingRef.delete();

    // Fire GA4 server-side purchase event for claimed pending enrollments.
    fireGA4PurchaseEvent(
      pending.stripeSessionId || ('claim_' + uid),
      ga4ClientId,
      uid,
      gclidAw,
      ga4SessionId,
      ga4SessionNumber
    ).catch(() => {});

    console.log(`Claimed pending enrollment: ${email} (${uid})`);
    return res.json({ ok: true, enrolled: true });

  } catch (err) {
    console.error('Claim-enrollment error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Purchase link request ───────────────────────────────────────────────
// Lifecycle: unreviewed -> linked (a human found the payment and enrolled them)
// or rejected (no matching payment, or not actionable). Mirrors
// PENDING_TERMINAL_STATUSES below deliberately rather than inventing a second
// vocabulary. Terminal states are reached only by a human decision — nothing in
// the request path writes one, and the route below no longer overwrites one.
const PURCHASE_LINK_TERMINAL_STATUSES = ['linked', 'rejected'];

// CALLER RESTORED 2026-09-16. Uncalled from 94dedc5 (25 Aug) until then: the
// client prompt that posts here was removed after three same-address false
// positives from rendering to every new signup. It is back in app.js
// (renderAlreadyPaidPrompt), gated on local evidence of a Stripe return, and
// the equality check below stops the same-address shape from alerting. A valid
// ID token and curl reach this route as they always did.
// POST /link-purchase-request
// Header: Authorization: Bearer <Firebase ID token>
// Body:   { checkoutEmail: string }
//
// The gap this exists to close. Every reconciliation path on this product joins
// a Stripe purchase to a Firebase account ON THE EMAIL ADDRESS: the webhook
// stashes pending_enrollments keyed by it, /claim-enrollment looks it up by it,
// and /pre-checkout blocks on the same key. When a guest checks out under one
// address and signs up under another, all three miss at once and nothing on the
// site ever acknowledges the payment. Four buyers in four months, every one this
// shape. Asking Stripe rather than Firestore does not help: it is the same
// string, so it misses too.
//
// The account holder is the only party who knows the other address. This
// collects it. GRANTS NOTHING — it writes one record for a human to act on and
// notifies the alert channel. Enrollment stays behind the manual review it has
// always been behind: a self-serve version would hand a paid product to anyone
// willing to name a stranger's address, and email_verified cannot help when both
// parties control their own inbox.
app.post('/link-purchase-request', express.json(), async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const m = authHeader.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Missing bearer token' });

  let decoded;
  try {
    decoded = await auth.verifyIdToken(m[1]);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const checkoutEmail = String((req.body || {}).checkoutEmail || '').trim().toLowerCase();
  if (!checkoutEmail || !checkoutEmail.includes('@') || checkoutEmail.length > 320) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const uid          = decoded.uid;
  const accountEmail = (decoded.email || '').toLowerCase();

  // Console first, same order as /diagnostic-email below: the Render log is the
  // one capture that survives a Firestore or Resend failure.
  console.log('PURCHASE_LINK_REQUEST', JSON.stringify({ uid, accountEmail, checkoutEmail }));

  const emailVerified = decoded.email_verified === true;
  const ref           = db.collection('purchase_link_requests').doc(uid);

  // Read before write, because two decisions below both need the prior state:
  // whether this record already carries a status a human set, and whether it has
  // already alerted inside the cooldown window. A read failure leaves both
  // unknown, and both unknowns resolve the same way — toward writing and toward
  // alerting, on the same "rather over-report than miss a paid buyer" rule
  // findStalePendingEnrollments runs on.
  let prior           = null;
  let priorReadFailed = false;
  try {
    const snap = await ref.get();
    prior = snap.exists ? snap.data() : null;
  } catch (err) {
    priorReadFailed = true;
    console.warn('[link-request] prior-record read failed, treating as new:', err.message);
  }

  // STATUS IS WRITTEN ON CREATION ONLY. It used to be set unconditionally under
  // {merge:true}, so a resubmission silently reset a record a human had already
  // actioned back to 'unreviewed'. That is 4f1cfa1's terminal-state problem in
  // the sibling collection, reintroduced here in the commit before it. An
  // existing value — terminal or not — is now left exactly as the human left it.
  // A record written before this field existed reads as unreviewed, which is
  // what it is.
  //
  // AND NOT WHEN THE READ FAILED. priorReadFailed means the prior state is
  // unknown, not absent — treating unknown as new would write 'unreviewed' over
  // a human's 'linked' and rebuild the whole defect on the error path, where a
  // clean dataset would never show it. Omitting the field is safe in both
  // directions: an existing status survives untouched, and a doc created without
  // one reads as unreviewed everywhere it is consumed.
  const writeStatus = !priorReadFailed && (!prior || prior.status == null);

  // createdAt IS A DIFFERENT CONDITION FROM writeStatus, AND DELIBERATELY SO.
  // status is a lifecycle field: a record written before it existed genuinely has
  // no lifecycle state, so setting it to its true opening value invents nothing.
  // createdAt is a HISTORICAL FACT. Writing it onto a document that already
  // exists would stamp "now" onto a record that first appeared weeks ago, which
  // is a fabricated timestamp, not a backfill. So this is gated on the document
  // being absent (!prior), not on the field being absent — the one live record
  // predates this commit and must keep no createdAt rather than acquire a false
  // one. Nothing sorts or filters on it, so its absence costs visibility nowhere.
  //
  // Why it is needed at all: requestedAt is overwritten on every submission and
  // status is now write-once, so without this nothing records when a record first
  // appeared, and the admin listing could show an open request without being able
  // to say whether it is an hour or three weeks old. That is precisely the
  // distinction 4f1cfa1 inverted the stale window to capture — stranded now
  // versus stranded long ago — and it would have been blind here.
  const writeCreatedAt = !priorReadFailed && !prior;

  // PER-DOCUMENT ALERT COOLDOWN, reusing the mechanism sendStaleEnrollmentAlert
  // already runs on: the same STALE_PENDING_ALERT_COOLDOWN_MS window and the
  // same lastAlertedAt field. Without it, N submissions against one document
  // produced N emails into the one channel that has already been trained into
  // being ignored once. (The constant is declared further down this file;
  // module evaluation completes long before any request runs.)
  //
  // A CHANGED ADDRESS ALWAYS ALERTS. The cooldown suppresses a repeat of the
  // same claim and never a new one — the write comment below already says a
  // second, different address is itself a signal, and swallowing a corrected
  // address would lose the single most useful thing this form collects.
  const lastAlertedMs =
    (prior && prior.lastAlertedAt && typeof prior.lastAlertedAt.toMillis === 'function')
      ? prior.lastAlertedAt.toMillis()
      : null;
  const sameClaim   = !!prior && prior.checkoutEmail === checkoutEmail;
  const inCooldown  = lastAlertedMs !== null &&
                      lastAlertedMs > Date.now() - STALE_PENDING_ALERT_COOLDOWN_MS;

  // THE EQUALITY CHECK, specified 25 Aug 2026 (calendar row 301) and built on
  // 16 Sep 2026. A visitor naming their own account address has told us nothing
  // a human can act on: the webhook already looked that address up when the
  // purchase came in, and /claim-enrollment looks it up on every page load.
  // Every one of ce058a2's three live firings was this shape, and the alerts
  // they produced are why the prompt was removed. Recorded, never alerted: the
  // record still lands (the admin listing surfaces sameAddress), the visitor
  // still gets ok, and the client copy still holds. A record whose two
  // addresses differ alerts exactly as before.
  const sameAddress = !!accountEmail && accountEmail === checkoutEmail;
  const shouldAlert = !sameAddress && (priorReadFailed || !sameClaim || !inCooldown);

  try {
    // Doc id = uid, so someone who submits twice overwrites their own record
    // instead of adding a second to the queue. attempts still counts the
    // submissions, because a second, different address is itself a signal.
    await ref.set(
      {
        uid,
        accountEmail,
        checkoutEmail,
        emailVerified,
        requestedAt: admin.firestore.FieldValue.serverTimestamp(),
        attempts:    admin.firestore.FieldValue.increment(1),
        ...(writeStatus    ? { status:    'unreviewed' } : {}),
        ...(writeCreatedAt ? { createdAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
      },
      { merge: true }
    );
  } catch (err) {
    // Already logged above, so the request is not lost. Still reported as ok to
    // the visitor: telling someone who has already paid once that their message
    // failed is how they decide to pay again.
    console.error('[link-request] Firestore write failed (still logged):', err.message);
  }

  if (shouldAlert) {
    // Stamped after the send resolves, the same order checkStalePendingEnrollments
    // AndAlert uses. sendPurchaseLinkAlert never throws on a delivery failure, so
    // this stamps on attempt rather than on confirmed delivery — identical to the
    // stale path, and the console line above is the capture either way.
    sendPurchaseLinkAlert({ uid, accountEmail, checkoutEmail, emailVerified })
      .then(() => ref.update({ lastAlertedAt: admin.firestore.FieldValue.serverTimestamp() })
        .catch(err => console.warn('[link-request] lastAlertedAt update failed for', uid, ':', err.message)))
      .catch(err => console.error('[link-request] alert failed:', err.message));
  } else if (sameAddress) {
    console.log(`[link-request] alert suppressed (checkout address equals account address): uid=${uid}`);
  } else {
    console.log(`[link-request] alert suppressed (same address, within cooldown): uid=${uid}`);
  }

  return res.json({ ok: true });
});

// Deliberately self-contained rather than sharing a helper with
// sendStaleEnrollmentAlert below. The two read the same env vars and that is
// duplication, but this is the one message that means "a paying customer is
// stuck right now", and it should not be able to break because the stale-alert
// digest was refactored underneath it. Same fallback contract as that function:
// if no channel is configured, or every configured channel fails, the data still
// lands in the Render log rather than disappearing.
async function sendPurchaseLinkAlert({ uid, accountEmail, checkoutEmail, emailVerified }) {
  const subject = '[CCA] Buyer says they paid under a different email';
  const summary = [
    'Someone signed up and told us they already paid under another address.',
    'Nothing has been granted — this needs a human to check Stripe and enroll',
    'them manually if it checks out.',
    '',
    '  Account email:       ' + (accountEmail || '(none on token)'),
    '  Claimed at checkout: ' + checkoutEmail,
    // Captured to Firestore since this endpoint shipped and left out of the
    // message, which is the field that lets a human weigh the claim: an
    // unverified account is one anybody can create under any address.
    '  Account verified:    ' + (emailVerified === true ? 'yes' : 'NO — inbox not proven'),
    '  Firebase uid:        ' + uid,
  ].join('\n');

  let delivered = false;

  if (process.env.ALERT_EMAIL_TO) {
    try {
      const ok = await sendViaResend({ to: process.env.ALERT_EMAIL_TO, subject, text: summary, kind: 'link_request_alert' });
      delivered = delivered || ok;
    } catch (err) {
      console.error('[link-request] email delivery threw:', err.message);
    }
  }

  if (process.env.ALERT_WEBHOOK_URL) {
    try {
      const resp = await fetch(process.env.ALERT_WEBHOOK_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: summary, content: summary }),
      });
      if (resp.ok) delivered = true;
      else console.error('[link-request] webhook delivery failed:', resp.status, await resp.text());
    } catch (err) {
      console.error('[link-request] webhook delivery threw:', err.message);
    }
  }

  if (!delivered) {
    console.warn('[link-request] no alert channel delivered — see PURCHASE_LINK_REQUEST above');
  }
}

// GET /admin/purchase-link-requests
// Header: x-admin-key: <ADMIN_API_KEY>
//
// The read path this collection shipped without. purchase_link_requests was
// written by the route above and read by NOTHING — one occurrence of the
// collection name across every tracked file in the repository — so a missed
// alert email left a paying customer's message invisible outside the Firestore
// console. pending_enrollments has GET /admin/stale-pending-enrollments; this is
// its counterpart, on the same ADMIN_API_KEY header, with an unset key returning
// 401 so the route cannot be hit with an empty or guessable value. Point the
// same external scheduler at it (see the box above that route).
//
// LISTS EVERYTHING, AND THE COOLDOWN NEVER DECIDES VISIBILITY. 4f1cfa1 put its
// aged bucket below its alert-cooldown guard, so a record alerted that morning
// fell out of every bucket and vanished from /admin — invisible on a clean
// dataset and caught only against live data. Nothing here reads lastAlertedAt,
// and a terminal status changes which list a record lands in, never whether it
// is listed at all.
//
// SENDS NOTHING. Unlike the stale route this is a listing, not a trigger: the
// alert for this collection fires at submission time, so a scheduler polling
// here must not be able to re-notify.
//
// Reads the whole collection rather than an ordered query on purpose. It holds
// one document per user who has ever submitted, and an orderBy would silently
// drop any document missing the sort field — the same "vanished from /admin"
// failure by a different route. Sorting happens in memory.
app.get('/admin/purchase-link-requests', async (req, res) => {
  if (!adminKeyMatches(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const snap = await db.collection('purchase_link_requests').get();
    const rows = snap.docs.map(doc => {
      const d  = doc.data();
      const ms = (d.requestedAt && typeof d.requestedAt.toMillis === 'function')
        ? d.requestedAt.toMillis()
        : null;
      // First-seen, reported alongside most-recent as a separate fact. Null for
      // any record written before this field existed, and null is reported as
      // null — never inferred from requestedAt, which is overwritten on every
      // submission and would read as "first seen today" for a three-week-old
      // request. Nothing filters or sorts on it.
      const cms = (d.createdAt && typeof d.createdAt.toMillis === 'function')
        ? d.createdAt.toMillis()
        : null;
      return {
        uid:           doc.id,
        accountEmail:  d.accountEmail  || null,
        checkoutEmail: d.checkoutEmail || null,
        emailVerified: d.emailVerified === true,
        // Both addresses identical means the visitor named their own account
        // address. Surfaced rather than filtered: it says more about how the
        // prompt reads than about the buyer, and it is the shape of the only
        // submission this endpoint has ever received.
        sameAddress:   !!d.accountEmail && d.accountEmail === d.checkoutEmail,
        status:        d.status || 'unreviewed',
        attempts:      d.attempts || 1,
        createdAt:     cms === null ? null : new Date(cms).toISOString(),
        firstSeenHours: cms === null ? null : Math.round((Date.now() - cms) / 3600000),
        requestedAt:   ms === null ? null : new Date(ms).toISOString(),
        ageHours:      ms === null ? null : Math.round((Date.now() - ms) / 3600000),
      };
    });
    // Newest first; a missing timestamp sorts last rather than disappearing.
    rows.sort((a, b) => (b.requestedAt || '').localeCompare(a.requestedAt || ''));

    const open   = rows.filter(r => !PURCHASE_LINK_TERMINAL_STATUSES.includes(r.status));
    const closed = rows.filter(r =>  PURCHASE_LINK_TERMINAL_STATUSES.includes(r.status));
    return res.json({
      ok:          true,
      count:       open.length,
      open,
      closedCount: closed.length,
      closed,
    });
  } catch (err) {
    console.error('[link-request] admin listing failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Pre-checkout enrollment guard ────────────────────────────────────────────
// POST /pre-checkout
// Header: Authorization: Bearer <Firebase ID token>
//
// Called by openPaymentModal() before the browser navigates to the Stripe
// Payment Link. Prevents an already-enrolled account from accidentally paying
// again, blocks checkout when this account's verified email already has an
// unclaimed pending_enrollments record (paid once, not yet reconciled — a
// second checkout would double-charge), and catches a duplicate in-flight
// checkout (same UID, started in the last 10 minutes). Returns one of:
//   { ok: false, reason: 'already_enrolled' }    — account has access; redirect to dashboard
//   { ok: false, reason: 'pending_purchase' }    — unclaimed purchase exists; verify email to unlock it instead
//   { ok: false, reason: 'recent_session', ageSeconds }  — checkout in progress; wait and reload
//   { ok: true }                                 — clear to proceed to Stripe
//
// Fails open on any error (including the pending_enrollments lookup) so that
// a network hiccup or Render cold start never blocks a legitimate first
// purchase — this makes the pending-purchase guard best-effort, same as the
// enrolled checks above it: a Firestore error here lets the request through
// to Stripe rather than blocking it. checkout_intents/{uid} is used as a
// lightweight in-flight tracker; records are overwritten on each cleared check
// so stale entries from abandoned carts don't accumulate.
app.post('/pre-checkout', express.json(), async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const m = authHeader.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Missing bearer token' });

  let decoded;
  try {
    decoded = await auth.verifyIdToken(m[1]);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const uid = decoded.uid;

  try {
    // Belt: custom claims — fastest; no extra Firestore read when claims are fresh.
    const userRecord = await auth.getUser(uid);
    if ((userRecord.customClaims || {}).enrolled === true) {
      console.log(`[pre-checkout] Blocked (claims): uid=${uid} already enrolled`);
      return res.json({ ok: false, reason: 'already_enrolled' });
    }

    // Suspenders: Firestore — catches the window between enrollment write and
    // claim propagation (claims can lag a few seconds after setCustomUserClaims).
    const userSnap = await db.collection('users').doc(uid).get();
    if (userSnap.exists && userSnap.data().enrolled === true) {
      console.log(`[pre-checkout] Blocked (FS): uid=${uid} already enrolled`);
      return res.json({ ok: false, reason: 'already_enrolled' });
    }

    // Durable first-click stamp for the checkout-abandoner sequence (freeze
    // exception 10, Build Schedule row 576). Written once and never cleared;
    // server-owned in firestore.rules. checkout_intents below cannot be the
    // trigger: it is overwritten by the next click and deleted when the modal
    // is dismissed. Inside this try on purpose: a failed write falls through to
    // the fail-open exit below and never blocks a checkout.
    if (!userSnap.exists || !userSnap.data().firstBuyClickAt) {
      await db.collection('users').doc(uid).set(
        { firstBuyClickAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    }

    // Belt-and-suspenders checks above only catch ENROLLED accounts. A guest
    // who already paid but hasn't signed up/verified yet is logged in here
    // with a fresh, unenrolled account and would otherwise sail through to a
    // second Stripe charge. Same lookup /claim-enrollment already uses
    // (doc id = lowercased email) — an email with no matching doc (the
    // common case: a brand-new buyer) falls straight through unaffected.
    const email = (decoded.email || '').toLowerCase();
    if (email) {
      const pendingSnap = await db.collection('pending_enrollments').doc(email).get();
      if (pendingSnap.exists) {
        console.log(`[pre-checkout] Blocked (pending): uid=${uid} email=${email}`);
        return res.json({ ok: false, reason: 'pending_purchase' });
      }
    }

    // Detect a duplicate in-flight checkout (same UID started < 10 min ago).
    const intentRef  = db.collection('checkout_intents').doc(uid);
    const intentSnap = await intentRef.get();
    if (intentSnap.exists) {
      const ts    = intentSnap.data().initiatedAt;
      const ageMs = ts ? Date.now() - ts.toMillis() : Infinity;
      if (ageMs < 10 * 60 * 1000) {
        const ageSeconds = Math.round(ageMs / 1000);
        console.log(`[pre-checkout] Recent session: uid=${uid} age=${ageSeconds}s`);
        return res.json({ ok: false, reason: 'recent_session', ageSeconds });
      }
    }

    // All clear — record intent and allow through.
    await intentRef.set({ uid, initiatedAt: admin.firestore.FieldValue.serverTimestamp() });
    console.log(`[pre-checkout] Cleared: uid=${uid}`);
    return res.json({ ok: true });

  } catch (err) {
    // Fail open — server error must not block a legitimate first checkout.
    console.warn(`[pre-checkout] Error for uid=${uid}, failing open:`, err.message);
    return res.json({ ok: true });
  }
});

// ── Stale pending-enrollment monitoring ───────────────────────────────────────
// pending_enrollments records are created when the webhook can't find a
// matching Firebase account (the customer paid before signing up — see the
// stash logic above). The expected reconciliation path is: they create or
// log into an account with the same email and /claim-enrollment applies the
// purchase (no email_verified gate since Sep 2026 — see that handler). A
// record still sitting here ~48h later usually means that path stalled —
// they never came back, or signed up with a different email.
// That's a real "paid and got nothing" situation that deserves a human to
// look at it (and possibly enroll them manually), not silent data rot.
//
// Render's free tier has no managed cron, so "scheduled job" here means an
// in-process interval — it only catches stale records while this instance
// happens to be awake, which for a low-traffic box is an honest limitation,
// not a guarantee. The admin endpoint below is the authoritative, on-demand
// counterpart: point an external uptime monitor at it on a daily schedule
// (which has the side benefit of keeping the instance warm) for a check that
// doesn't depend on this process's uptime.
// THE ALERT WINDOW, INVERTED. It used to report that a record was OLD, which
// stops being news: three records alerted daily for 130 days, were emailed
// twice, and none replied. An alert that is correct and useless trains the
// owner to ignore the channel, which is the state the next genuinely stranded
// buyer arrives in. It now reports a record that is NEW — someone stranded
// in the last 48 hours, while they are still reachable and before they dispute.
//
// The 2h floor matters as much as the 48h ceiling. "No Firebase account yet"
// is the NORMAL state for a guest who is about to sign up, so alerting from
// minute zero is the same noise problem inverted. Two hours is long enough
// that the ordinary reconciliation path has visibly stalled.
const NEW_STRANDED_MIN_AGE_MS       = 2  * 60 * 60 * 1000; // too new to act on
const STALE_PENDING_THRESHOLD_MS    = 48 * 60 * 60 * 1000; // past this, not news
const STALE_PENDING_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // min gap between alerts per doc
// Reached only by a human decision (scripts/mark-pending-contacted.js, or a
// future admin control). Nothing in the request path ever writes these.
const PENDING_TERMINAL_STATUSES = ['contacted', 'abandoned'];

// ── Alert delivery ────────────────────────────────────────────────────────
// Pure console.warn logging is easy to miss — Render's free tier doesn't
// push log alerts, so a stale record could sit unseen for weeks. This sends
// an actual notification, configured by env var (set either, both, or
// neither):
//
//   ALERT_EMAIL_TO     — an email address to notify. Reuses the existing
//                        Resend integration (and RESEND_API_KEY) above —
//                        nothing new to provision if that's already set up.
//   ALERT_WEBHOOK_URL  — a Slack or Discord "incoming webhook" URL. The
//                        payload below sends both `text` (which Slack reads)
//                        and `content` (which Discord requires) so the same
//                        code works for either without needing to know which
//                        one you're pointed at.
//
// If NEITHER is set — or every configured channel fails to deliver — this
// falls back to the original console.warn behavior, so a stale batch never
// goes completely unrecorded even with zero configuration.
async function sendStaleEnrollmentAlert(stale) {
  const plural  = stale.length === 1 ? '' : 's';
  const lines   = stale.map(s =>
    `• ${s.email} — Stripe session ${s.stripeSessionId || '(none)'} — ` +
    (s.ageHours === null ? 'age unknown (missing timestamp)' : `${s.ageHours}h old`)
  );
  // NO DURATION IN THE SUMMARY LINE. This previously read "paid in the last 48
  // hours and still has no course access" — the 48 was the window CEILING from
  // STALE_PENDING_THRESHOLD_MS, hardcoded, and it sat next to "no course access"
  // joined by a bare "and", so it parsed as "locked out for 48 hours". Every
  // alert this function sends is for a record 2–48h old, so every one of them
  // read as maximally stale and maximally urgent. The per-record bullets above
  // already state each age accurately; the summary does not need a bound, and a
  // bound restated here is one more thing that can drift from the constant.
  const summary =
    `${stale.length} NEW stranded buyer${plural} — paid recently, no course ` +
    `access yet. Reach them now, before they give up or dispute:\n\n` +
    lines.join('\n');

  let delivered = false;

  if (process.env.ALERT_EMAIL_TO) {
    try {
      const ok = await sendViaResend({
        to:      process.env.ALERT_EMAIL_TO,
        subject: `[CCA] ${stale.length} NEW stranded buyer${plural} — paid, no access`,
        text:    summary,
        kind:    'stranded_alert',
      });
      delivered = delivered || ok;
    } catch (err) {
      console.error('[alert] email delivery threw:', err.message);
    }
  }

  if (process.env.ALERT_WEBHOOK_URL) {
    try {
      const resp = await fetch(process.env.ALERT_WEBHOOK_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: summary, content: summary }),
      });
      if (resp.ok) {
        delivered = true;
      } else {
        console.error('[alert] webhook delivery failed:', resp.status, await resp.text());
      }
    } catch (err) {
      console.error('[alert] webhook delivery threw:', err.message);
    }
  }

  if (!delivered) {
    // Covers two cases at once: no channel env var was set at all, or every
    // configured channel failed above. Either way, the data still lands
    // somewhere durable (Render's log dashboard).
    //
    // This line said "older than 48h" — the pre-4f1cfa1 semantics, left behind
    // when the window inverted. It was not ambiguous like the summary above, it
    // was FALSE: this set is 2–48h old, so every record it described was younger
    // than 48h, not older. Records that really are past 48h go to `aged` and
    // reach neither this fallback nor any channel. No bound stated here either;
    // JSON.stringify(stale) already carries each record's age.
    console.warn(
      `[pending_enrollments] ${stale.length} unclaimed record(s) needing manual review ` +
      `(no alert channel configured or delivery failed; set ALERT_EMAIL_TO or ALERT_WEBHOOK_URL to get pinged):`,
      JSON.stringify(stale)
    );
  }
}

async function findStalePendingEnrollments() {
  const now         = Date.now();
  const youngest    = now - NEW_STRANDED_MIN_AGE_MS;    // newer than this: too soon
  const oldest      = now - STALE_PENDING_THRESHOLD_MS; // older than this: not news
  const alertCutoff = now - STALE_PENDING_ALERT_COOLDOWN_MS;
  const snap        = await db.collection('pending_enrollments').get();
  const stale   = []; // records that need a fresh alert
  const docRefs = []; // parallel Firestore refs for stale[] (for lastAlertedAt writes)
  const aged    = []; // non-terminal, past 48h: listed by /admin, never alerted
  const orphans = []; // zombie docs: enrolled user exists, pending record is dead weight

  for (const doc of snap.docs) {
    const data = doc.data();

    // ── Guard 0: terminal state ────────────────────────────────────────
    // A human has already acted on this record. Checked before everything
    // else so a contacted/abandoned doc costs no getUserByEmail and no users
    // read. An absent status means a doc written before the field existed —
    // read as unclaimed, which is what it is.
    if (PENDING_TERMINAL_STATUSES.includes(data.status)) continue;

    const createdAtMs = (data.createdAt && typeof data.createdAt.toMillis === 'function')
      ? data.createdAt.toMillis()
      : null;

    // A missing timestamp still falls through to the alert set: better to
    // over-report one record than silently miss a paid buyer.
    if (createdAtMs !== null && createdAtMs > youngest) continue; // too new to act on
    const tooOld = createdAtMs !== null && createdAtMs < oldest;

    const email = (data.email || doc.id).toLowerCase();

    // ── Guard 1: Enrollment cross-check ────────────────────────────────
    // If this email already has an enrolled Firebase account, the pending
    // doc is a zombie — the user signed up after the pending record was
    // stashed and access was granted via /claim-enrollment (or a manual
    // write), but the doc was never cleaned up.  Skip the alert and queue
    // the orphan for deletion so it stops appearing in future checks.
    try {
      const userRecord = await auth.getUserByEmail(email);
      const fsSnap     = await db.collection('users').doc(userRecord.uid).get();
      if (fsSnap.exists && fsSnap.data().enrolled === true) {
        orphans.push(doc.ref);
        console.log(
          `[pending_enrollments] zombie found for ${email}` +
          ` (enrolled uid=${userRecord.uid}) — queuing for cleanup`
        );
        continue; // skip alert for this doc
      }
    } catch (e) {
      if (e.code !== 'auth/user-not-found') {
        // Unexpected error — log but fall through so the record is not
        // silently skipped; we would rather over-alert than miss a real problem.
        console.warn(`[pending_enrollments] enrollment cross-check failed for ${email}:`, e.message);
      }
      // auth/user-not-found is the normal case: no account exists yet.
    }

    // ── Guard 2: past the window ───────────────────────────────────────
    // Still real, still visible to /admin, but it stops generating email.
    // ABOVE the cooldown guard deliberately: aged never sends anything, so a
    // 24h alert cooldown must not decide whether it is listed. With this
    // below the cooldown, a record alerted in the last 24h fell through both
    // branches and vanished from /admin entirely -- caught by the dry run,
    // where two of the three live records had been alerted two hours earlier.
    // This is the line that quiets the long-standing records even if nobody
    // marks them contacted.
    if (tooOld) {
      aged.push({
        email,
        stripeSessionId: data.stripeSessionId || null,
        ageHours:        createdAtMs === null ? null : Math.round((now - createdAtMs) / 3600000),
      });
      continue;
    }

    // ── Guard 3: Per-doc alert dedup (24 h cooldown) ───────────────────
    // Skip if an alert was already sent for this doc within the last 24 h.
    // Prevents the 6-hourly setInterval AND any external daily cron from
    // each firing independent alerts for the same unresolved record.
    // After the cooldown window, the doc surfaces again — one alert per day
    // until the customer gets access or the doc is otherwise resolved.
    const lastAlertedMs = (data.lastAlertedAt && typeof data.lastAlertedAt.toMillis === 'function')
      ? data.lastAlertedAt.toMillis()
      : null;
    if (lastAlertedMs !== null && lastAlertedMs > alertCutoff) {
      continue; // alerted within the last 24 h — skip this cycle
    }

    // ── Guard 4: a NEW stranded buyer, unenrolled, not alerted recently ─
    // They paid in the last 48h and have no course access. Reachable now.
    //
    // ONE DECIMAL, not Math.round to the hour. This is the only ageHours that
    // gets RENDERED to a human (sendStaleEnrollmentAlert's bullet). Rounding a
    // 2.4h record to "2h old" printed it AT the 2h admission floor, so the one
    // record a reader might sanity-check looked like it should not have fired.
    // Math.floor is no better — it prints "2h" for anything up to 2.9h, which
    // makes the same misreading systematic rather than occasional.
    // JS drops a trailing .0, so a record at exactly 3h still reads "3h old".
    //
    // Deliberately NOT applied to the `aged` copy above or the one at :747:
    // neither is rendered, and the three-way duplication of this expression is
    // logged as its own cleanup rather than widened into this commit.
    stale.push({
      email,
      stripeSessionId: data.stripeSessionId || null,
      ageHours:        createdAtMs === null ? null : Math.round((now - createdAtMs) / 3600000 * 10) / 10,
    });
    docRefs.push(doc.ref);
  }

  // Best-effort cleanup: delete zombie orphan docs.  Fire-and-forget —
  // failure is not fatal; the doc will be re-checked next cycle and
  // re-skipped by Guard 1.
  orphans.forEach(ref => ref.delete().catch(err =>
    console.warn('[pending_enrollments] orphan cleanup failed for', ref.id, ':', err.message)
  ));

  return { stale, aged, docRefs };
}

async function checkStalePendingEnrollmentsAndAlert() {
  try {
    const { stale, docRefs } = await findStalePendingEnrollments();
    if (stale.length) {
      await sendStaleEnrollmentAlert(stale);
      // Stamp lastAlertedAt on each alerted doc so Guard 2 suppresses
      // repeat alerts for the next 24 h (applies to both the setInterval
      // path here and the external-cron /admin endpoint below).
      const now = admin.firestore.FieldValue.serverTimestamp();
      docRefs.forEach(ref => ref.update({ lastAlertedAt: now }).catch(err =>
        console.warn('[pending_enrollments] lastAlertedAt update failed for', ref.id, ':', err.message)
      ));
    }
  } catch (err) {
    console.error('[pending_enrollments] stale check failed:', err.message);
  }
}

// Once shortly after boot (catches anything that piled up while this
// instance was asleep), then every 6 hours for as long as the process stays
// up. NOTE: on Render's free tier the dyno sleeps after ~15 minutes idle, so
// this interval is a best-effort backstop, not a reliable schedule — see the
// admin endpoint + external-scheduler note below for the dependable path.
setTimeout(checkStalePendingEnrollmentsAndAlert, 60 * 1000);
setInterval(checkStalePendingEnrollmentsAndAlert, 6 * 60 * 60 * 1000);

// GET /admin/stale-pending-enrollments
// Header: x-admin-key: <ADMIN_API_KEY>
//
// On-demand, authoritative listing of unclaimed pending_enrollments older
// than 48h — email, Stripe session ID, and age in hours for each — AND the
// trigger point that actually fires the alert (see sendStaleEnrollmentAlert)
// when the list is non-empty. Returns 401 (route effectively disabled) if
// ADMIN_API_KEY isn't set, so it can't be hit with an empty/guessable key.
//
// ┌─────────────────────────────────────────────────────────────────────┐
// │ SET THIS UP: point an external scheduler at this endpoint            │
// │                                                                       │
// │ The in-process interval above only runs while the dyno happens to    │
// │ be awake — on Render's free tier that's not guaranteed. For a        │
// │ dependable check, use a free service like https://cron-job.org (or   │
// │ UptimeRobot, Better Uptime, etc.) to send a periodic GET here, e.g.  │
// │ every 4-6 hours:                                                      │
// │                                                                       │
// │   URL:     https://claude-certified-architect.onrender.com/admin/    │
// │            stale-pending-enrollments                                 │
// │   Method:  GET                                                       │
// │   Header:  x-admin-key: <your ADMIN_API_KEY value>                   │
// │                                                                       │
// │ This does double duty: it surfaces stale records on a schedule you   │
// │ control (independent of this process's uptime), AND every hit keeps  │
// │ the instance warm — directly helping the cold-start problem this     │
// │ same audit flagged for the Stripe webhook and /claim-enrollment.     │
// └─────────────────────────────────────────────────────────────────────┘
app.get('/admin/stale-pending-enrollments', async (req, res) => {
  if (!adminKeyMatches(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { stale, aged, docRefs } = await findStalePendingEnrollments();
    if (stale.length) {
      // Awaited rather than fire-and-forget: this route is called by an
      // infrequent external scheduler — better to spend a moment ensuring
      // the alert was attempted than to risk losing it if the dyno idles.
      await sendStaleEnrollmentAlert(stale);
      // Stamp lastAlertedAt so Guard 2 deduplicates the next scheduler hit.
      const now = admin.firestore.FieldValue.serverTimestamp();
      docRefs.forEach(ref => ref.update({ lastAlertedAt: now }).catch(err =>
        console.warn('[pending_enrollments] lastAlertedAt update failed for', ref.id, ':', err.message)
      ));
    }
    // aged is reported but never alerted on: the authoritative listing must
    // still show a stranded buyer who slipped past the window, otherwise
    // inverting the alert would lose them rather than quiet them.
    return res.json({ ok: true, count: stale.length, stale, agedCount: aged.length, aged });
  } catch (err) {
    console.error('[pending_enrollments] admin listing failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Diagnostic email capture ──────────────────────────────────────────────────
// POST /diagnostic-email
// Body: { email: string, results: { estimatedScore, passScore, weakestDomain,
//          weakestDomainWeight, domains: [{ label, examWeight, correct, total, pct }] } }
//
// 1. Logs to console (guaranteed capture even if DB/email fails)
// 2. Persists to Firestore diagnostic_leads collection
// 3. Emails results via Resend (requires RESEND_API_KEY env var +
//    claudecertifiedarchitects.com domain verified in Resend dashboard)
//
app.post('/diagnostic-email', diagJson, async (req, res) => {
  // Order: per-IP limit first (cheapest), then the allowlist, then the
  // per-address limit, then the write and the send. A rejected request
  // writes nothing and sends nothing.
  const ip = clientIp(req);
  if (diagRateLimited('ip:' + ip, DIAG_LIMITS.ip)) {
    console.warn('[diagnostic-email] rate limited (ip):', ip);
    return res.status(429).json({ error: 'Too many requests' });
  }
  const v = validateDiagnosticPayload(req.body);
  if (!v.ok) {
    console.warn('[diagnostic-email] rejected:', v.error, 'ip:', ip);
    return res.status(400).json({ error: v.error });
  }
  const { email, results } = v;
  if (diagRateLimited('email:' + email.toLowerCase(), DIAG_LIMITS.email)) {
    console.warn('[diagnostic-email] rate limited (email):', email);
    return res.status(429).json({ error: 'Too many requests' });
  }

  // 1. Console log — always captured in Render logs
  console.log('DIAGNOSTIC_LEAD', JSON.stringify({
    email,
    estimatedScore: results?.estimatedScore,
    weakestDomain:  results?.weakestDomain,
  }));

  // 2. Persist to Firestore (non-blocking)
  // The unsubscribe token is issued here so the results email carries the same
  // link the nurture sequence reuses (runNurtureSequence step 7 keeps an
  // existing lead.unsubToken). Freeze exception 7, Build Schedule row 570.
  const unsubToken = crypto.randomBytes(20).toString('hex');
  const unsubUrl   = `https://claude-certified-architect.onrender.com/unsubscribe?token=${unsubToken}`;
  try {
    await db.collection('diagnostic_leads').add({
      email,
      results:     results || null,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      source:      'diagnostic',
      unsubToken,
    });
  } catch (err) {
    console.error('Firestore write failed (lead still logged):', err.message);
  }

  // 3. Send results email via Resend
  if (results) {
    const score    = results.estimatedScore || 0;
    const passMark = results.passScore || 720;
    const verdict  = score >= passMark
      ? '✅ Strong result: you look ready!'
      : score >= passMark * 0.85
        ? "🟡 Close: a bit more practice and you'll be there"
        : '🔴 Good start: let\'s fill those gaps';

    const domainRows = (results.domains || [])
      .map(d => `  • ${d.label}: ${d.correct}/${d.total} (${d.pct}%), ${d.examWeight}% of exam`)
      .join('\n');

    // A perfect sample (every domain correct equals its total) has no weakest
    // area. results.weakestDomain is the label the validator requires, not a
    // finding, so it is not named here. Freeze exception 3, 28 Sep 2026.
    const perfect = Array.isArray(results.domains) && results.domains.length > 0 &&
      results.domains.every(d => d.total > 0 && d.correct === d.total);
    const verdictOut  = perfect ? '✅ Strong result on this sample.' : verdict;
    const weakestLine = perfect
      ? "Weakest area: none on this sample. You answered all 10 questions correctly, but with two questions per domain, a sample this small can’t show whether you’re ready for the real exam’s 60 questions. Treat it as a strong start rather than a verdict."
      : `Weakest area: ${results.weakestDomain} (${results.weakestDomainWeight}% of the real exam)`;

    const text = `Hi,

Here are your CCA Diagnostic Quiz results:

${verdictOut}

Estimated score: ${score} / 1,000  (passing mark: ${passMark})

Domain breakdown:
${domainRows}

${weakestLine}

Want to close the gap? The full 400-question practice bank covers every domain at real exam weightings, with detailed explanations for every answer.

👉 ${nurtureCtaUrl('results')}

Good luck with your studies!
CCA Practice Platforms

CCA Practice Platforms, 361 Falls Rd #831, Grafton, WI 53024, USA
To stop receiving these emails: ${unsubUrl}`;

    await sendViaResend({
      to:      email,
      subject: `Your CCA Diagnostic Results: ${score}/1,000`,
      text,
      listUnsubscribeUrl: unsubUrl,
      kind:    'diagnostic_results',
    });
  }

  return res.json({ ok: true });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Webhook server running.'));

// ══════════════════════════════════════════════════════════════════════════════
// NURTURE SEQUENCE — 3 emails (D+1, D+3, D+7) for diagnostic leads who haven't
// purchased. Triggered once daily by an external cron (cron-job.org). All sends
// go via the existing sendViaResend() helper above.
// ══════════════════════════════════════════════════════════════════════════════

// Per-domain question counts. THE BANK IS THE SOURCE: q.d in app.js's QUESTIONS
// and in diagnostic/index.html's POOL, both 109/80/79/72/60 = 400 at HEAD, and
// diagnostic/index.html's DOMAIN_Q_COUNT mirrors them. Prompt Engineering read
// 80 here for three weeks after ed21c55 corrected the two Pages surfaces: this
// file was out of that commit's scope because it deploys to Render, not Pages.
const NURTURE_DOMAIN_Q_COUNT = {
  'Agentic Architecture & Orchestration':  109,
  'Claude Code Configuration':              80,
  'Prompt Engineering & Structured Output': 79,
  'Tool Design & MCP Integration':          72,
  'Context Management & Reliability':       60,
};

// The sequence reads back diagnostic_leads' stored `weakestDomain`, which
// diagnostic/index.html writes as the DOMAINS *label* rather than the bank key,
// and one label is not its key. Resolve it so no domain depends on a fallback.
// Applied to all three lookups (count, study tip, sample question). 2b60b22 scoped
// it to the count and left STUDY_TIPS and SAMPLE_QUESTIONS missing on purpose, so
// the Claude Code segment received the Agentic tip and sample from 19 Jun until the
// tip text had a documentation fetch behind it (the sample's came at d60eb36).
const NURTURE_DOMAIN_ALIASES = {
  'Claude Code Configuration & Workflows': 'Claude Code Configuration',
};
const nurtureDomainKey = d => own(NURTURE_DOMAIN_ALIASES, d) || d;

// Derived, so correcting one figure can never leave the total contradicting it.
const NURTURE_BANK_TOTAL = Object.values(NURTURE_DOMAIN_Q_COUNT).reduce((a, b) => a + b, 0);

// One specific, actionable study tip per domain
const STUDY_TIPS = {
  'Agentic Architecture & Orchestration':
    'Focus on where to place human-in-the-loop checkpoints: the exam tests this precisely. ' +
    'The rule: any action that is hard to reverse (writing data, spending money, scheduling ' +
    'real-world events) needs human approval before execution. Read-only calls are generally ' +
    'safe to run automatically. Practice sketching a ReAct loop (Reason → Act → ' +
    'Observe) and marking every write step with a checkpoint.',

  'Claude Code Configuration':
    'Know CLAUDE.md inside-out: what goes in it (project scope, allowed commands, ' +
    'never-touch files, conventions), how it differs from a system prompt, and which ' +
    'subagents load it. Also know where MCP servers are defined: project-scoped servers in ' +
    '.mcp.json at the project root; local- and user-scoped servers in ~/.claude.json. ' +
    'settings.json defines no servers, it only approves .mcp.json ones. Exam questions hinge ' +
    'on the configuration hierarchy: user vs. project settings vs. per-session overrides.',

  'Prompt Engineering & Structured Output':
    'The most-tested technique is separating reasoning from output. Use a planning step ' +
    'that asks Claude to think through the problem before producing the final answer, and ' +
    'capture that thinking in a scratchpad rather than letting it bleed into the response. ' +
    'For structured output, know when to use JSON schema enforcement (strict contracts with ' +
    'external systems) vs. plain prose, and always add post-processing validation as a ' +
    'second layer on top of prompt instructions.',

  'Tool Design & MCP Integration':
    'Memorize the three-field formula for any tool definition: (1) a verb-phrase name ' +
    '(get_user_profile, search_docs), (2) a natural-language description that tells Claude ' +
    'exactly when and why to call it, and (3) typed parameters with explicit required vs. ' +
    'optional flags and a description for each. Exam questions almost always hinge on ' +
    'whether a schema is complete enough for Claude to call the tool correctly without ' +
    'guessing intent.',

  'Context Management & Reliability':
    'The highest-yield insight: important constraints that must hold throughout a long ' +
    'conversation should be restated near the end of the context (recency effect), not ' +
    'just at the top. Understand how to summarize earlier turns while preserving key ' +
    'decisions, and know the difference between system prompt slots (persistent) and ' +
    'conversation turns (scrolled away). Model version pinning in production is also ' +
    'frequently tested.',
};

// One sample question per domain for Email 2 (index 10 in app.js — well clear of the
// 2-per-domain diagnostic pool)
const SAMPLE_QUESTIONS = {
  'Agentic Architecture & Orchestration': {
    q: 'A healthcare startup is building an agent that can schedule appointments and access patient records. At what point should the agent require human approval?',
    options: [
      'Never: full autonomy is the design goal, and an approval step on each action defeats it',
      'Before any action that modifies patient data or schedules real appointments',
      'Only when the patient explicitly asks to be handed over to a human',
      'Only when the model reports a confidence score below 50% for the action it proposes',
    ],
    correct: 1,
    explain: 'Human-in-the-loop checkpoints should be placed before any action with real-world consequences that are difficult or impossible to reverse, especially in sensitive domains like healthcare. Modifying patient data and scheduling real appointments are high-stakes actions that warrant human approval.',
  },
  'Claude Code Configuration': {
    q: 'You need to configure Claude Code to connect to a custom MCP server that provides access to your company\'s internal API documentation. Where do you add this configuration?',
    options: [
      'In a .mcp.json file at the project root, which claude mcp add --scope project writes for you',
      'In CLAUDE.md, as a tool description pointing at the documentation server',
      'In .claude/settings.json, under an mcpServers block that lists the server\'s command and transport',
      'In the system prompt of each conversation, as a description of the server and its endpoint',
    ],
    correct: 0,
    explain: 'Claude Code stores MCP server definitions by scope. A project-scoped server lives in a .mcp.json file at the project root, which claude mcp add --scope project creates or updates, and committing that file shares the server with everyone who clones the repository. Local- and user-scoped servers are stored in ~/.claude.json instead. .claude/settings.json holds no server definitions; its MCP keys, such as enabledMcpjsonServers, only control which .mcp.json servers are approved.',
  },
  'Prompt Engineering & Structured Output': {
    q: 'You want to prevent Claude from generating harmful content in a customer-facing chatbot. What is the most effective approach for output guardrails?',
    options: [
      'Append a standing disclaimer to each response and log the transcripts for weekly human review, so the outputs that cross a line are identified and corrected afterwards',
      'Set temperature to 0 so sampling becomes deterministic: the model is held to its highest-probability continuations, which constrains the wording it can produce',
      'Implement layered guardrails: system prompt instructions defining boundaries, plus post-processing validation that checks outputs against content policies before showing them to users',
      'Rely on a system prompt that enumerates the prohibited categories in detail, on the basis that a sufficiently specific instruction makes a separate check on the generated response redundant',
    ],
    correct: 2,
    explain: 'Layered guardrails provide defense in depth: system prompt instructions set behavioral boundaries, and post-processing validation acts as a safety net to catch anything that slips through. This two-layer approach is more robust than relying solely on either the model\'s built-in safety or prompt instructions alone.',
  },
  'Tool Design & MCP Integration': {
    q: 'What is MCP (Model Context Protocol) and why does it matter for building AI applications?',
    options: [
      'A proprietary Anthropic protocol, available only to Anthropic\'s own products, for wiring internal tools into Claude',
      'A compression scheme for context windows that encodes retrieved documents and tool output in a compact form so that more of them fit inside a model\'s token limit on each request',
      'A messaging format that lets several models exchange intermediate results with one another during a single multi-model workflow',
      'An open protocol that standardizes how AI applications connect to external data sources and tools, enabling interoperable integrations across different AI systems',
    ],
    correct: 3,
    explain: 'MCP (Model Context Protocol) is an open protocol that standardizes the connection between AI applications and external tools and data sources. It matters because it creates an interoperable ecosystem where tool integrations can be reused across different AI applications rather than requiring custom integrations for each one.',
  },
  'Context Management & Reliability': {
    q: 'Your team is concerned about a model update changing behavior in production. What deployment strategy minimizes risk?',
    options: [
      'Never update the model version in production, so that behaviour stays fixed for the life of the deployment and no regression is possible',
      'Let Anthropic decide when to update by leaving the model alias unpinned, since each release is checked for regressions before it reaches the alias',
      'Update every production system to the new version at once, and roll back to the previous version if error rates or complaints rise afterwards',
      'Use model version pinning in production and implement canary deployment: test the new version with a small percentage of traffic before full rollout',
    ],
    correct: 3,
    explain: 'Model version pinning locks your production to a specific model version, preventing unexpected behavior changes. Canary deployment tests new versions with a small traffic percentage, allowing you to detect issues before they affect all users. This combination provides stability while enabling controlled upgrades.',
  },
};

// Leads submitted before this date are NEVER pulled into the sequence.
// Override with SEQUENCE_START env var (ISO date string) on Render.
const SEQUENCE_START = new Date(process.env.SEQUENCE_START || '2026-06-19T00:00:00Z');

// Stage order and minimum lead age before each email is eligible
const STAGE_ORDER       = ['d1', 'd3', 'd7'];
const STAGE_MIN_AGE_MS  = { d1: 22 * 3600000, d3: 70 * 3600000, d7: 166 * 3600000 };

// Backlog safety (freeze exception 7, Build Schedule row 570). The daily send
// was off from 27 Sep to 8 Oct 2026, and a resumed run must not send a pile of
// stale emails or two emails to one person on consecutive days.
//   - A stage more than STAGE_MAX_LATE_MS past its minimum age is skipped, never
//     sent late, and the lead's sequence is closed: sequenceClosed records which
//     stage and why, and a closed lead is skipped on every later run.
//   - A later stage waits STAGE_MIN_GAP_MS after the previous send (step 2 is
//     48h after step 1 by design, step 3 is 96h after step 2), so a lead that
//     fell behind keeps the designed spacing instead of compressing it.
//   - One email per lead per run was already the case and is unchanged.
const STAGE_MAX_LATE_MS = 7 * 24 * 3600000;
const STAGE_MIN_GAP_MS  = { d1: 0, d3: 48 * 3600000, d7: 96 * 3600000 };

// ── Checkout-abandoner sequence (freeze exception 10, Build Schedule row 576) ──
// Two emails to an account holder who clicked Buy (users/{uid}.firstBuyClickAt,
// stamped by /pre-checkout) and did not pay: A at least 24h after the first
// click, B at least 96h after A, then nothing. State lives in the server-owned
// users/{uid}.abandoner map; every send also writes abandoner_sends/{uid}_{step}
// for the report script. Kill switch: ABANDONER_EMAILS_ENABLED must be the
// string "true" on Render; read at run time, default off. With the switch off
// a run logs "[abandoner] disabled" and reads nothing, EXCEPT a run carrying
// ?only= (a test send to named addresses), which proceeds for those alone, and
// a ?dryRun=true run, which sends and writes nothing and is the preview of
// what the next live run would send.
const ABANDONER_START        = new Date(process.env.ABANDONER_START || '2026-10-08T00:00:00Z');
const ABANDONER_MIN_AGE_MS   = { a: 24 * 3600000, b: 96 * 3600000 }; // a: after firstBuyClickAt; b: after A's send
const ABANDONER_MAX_LATE_MS  = 7 * 24 * 3600000;                       // past this a step is skipped and the sequence closed
const ABANDONER_WINDOW_MS    = 21 * 24 * 3600000;                      // A latest at +8d, B latest at +19d; nothing older can be due
const ABANDONER_DAILY_CAP    = 70;                                     // this process's sends per UTC day, all kinds, before an abandoner send
const ABANDONER_ONE_A_DAY_MS = 24 * 3600000;                           // no abandoner email within a day of a nurture email, and the reverse
const ABANDONER_FROM         = 'The CCA Practice team <team@claudecertifiedarchitects.com>';
const ABANDONER_REPLY_TO     = 'support@claudecertifiedarchitects.com';
const ABANDONER_REASON_LINE  = 'You are receiving this email because you created an account on claudecertifiedarchitects.com.';
const ABANDONER_POSTAL       = 'CCA Practice Platforms, 361 Falls Rd #831, Grafton, WI 53024, USA';
const ABANDONER_B_URL        = 'https://www.claudecertifiedarchitects.com/cca-practice-questions/?utm_source=email&utm_medium=nurture&utm_campaign=checkout-b-auto';
// Test-account markers: the two generic ones here; the personal addresses come
// from CCA_TEST_ACCOUNT_MARKERS on Render (this file is served publicly).
const ABANDONER_TEST_MARKERS = ['joshtest', '+ccatest']
  .concat((process.env.CCA_TEST_ACCOUNT_MARKERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const abandonerEnabled = () => process.env.ABANDONER_EMAILS_ENABLED === 'true';
const normEmail = e => String(e || '').trim().toLowerCase();
const tsMs = v => (v && typeof v.toMillis === 'function') ? v.toMillis()
            : (v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : 0));

// email_suppressions/{normalized address}: unsubscribed (every automated send
// checks it), replied (the abandoner sequence skips step B), manualCampaignA
// (received Email A in the October manual campaign; never gets the automated
// one). Deny-by-default rules keep it unreachable from any browser.
async function getSuppression(email) {
  const s = await db.collection('email_suppressions').doc(normEmail(email)).get();
  return s.exists ? s.data() : null;
}
async function suppressEmail(email, fields) {
  await db.collection('email_suppressions').doc(normEmail(email)).set(
    { email: normEmail(email), ...fields, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}
// Flags every diagnostic_leads doc under an address, exact and lower-cased
// (lead addresses are stored as typed), with the same stamp /unsubscribe writes.
// `emails` may be one address or an array of the forms known for the account
// (the Auth address and the users.email typed at signup).
function emailKeys(emails) {
  const list = Array.isArray(emails) ? emails : [emails];
  return new Set(list.flatMap(e => [String(e || '').trim(), normEmail(e)]).filter(Boolean));
}
async function stampLeadsUnsubscribed(emails) {
  const stamp = { unsubscribed: true, unsubscribedAt: admin.firestore.FieldValue.serverTimestamp() };
  const refs  = new Map();
  for (const key of emailKeys(emails)) {
    const snap = await db.collection('diagnostic_leads').where('email', '==', key).get();
    snap.forEach(d => refs.set(d.id, d.ref));
  }
  await Promise.all([...refs.values()].map(ref => ref.set(stamp, { merge: true })));
  return refs.size;
}
function abandonerSentWithin(ab, now, windowMs) {
  if (!ab) return false;
  return [ab.aSentAt, ab.bSentAt].some(t => { const m = tsMs(t); return m > 0 && now - m < windowMs; });
}
async function leadNurturedWithin(emails, now, windowMs) {
  for (const key of emailKeys(emails)) {
    const snap = await db.collection('diagnostic_leads').where('email', '==', key).get();
    for (const d of snap.docs) { const m = tsMs(d.data().lastNurtureAt); if (m > 0 && now - m < windowMs) return true; }
  }
  return false;
}

const SITE_URL    = 'https://www.claudecertifiedarchitects.com';
const OPT_LETTERS = ['A', 'B', 'C', 'D', 'E'];

function nurtureCtaUrl(stage) {
  return `${SITE_URL}/?hub=practice-tests&utm_source=email&utm_medium=nurture&utm_campaign=diagnostic_sequence&utm_content=${stage}`;
}

// ── Shared HTML email wrapper (table-based for email-client compatibility) ────
// `reasonLine` (optional) is the CAN-SPAM style "why you got this" sentence the
// checkout-abandoner emails carry; without it the output is byte-identical to
// the pre-row-576 wrapper, which the nurture emails rely on.
function emailWrap(bodyHtml, unsubUrl, reasonLine) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f5f3ea;font-family:Georgia,'Times New Roman',serif">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f3ea;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#ffffff;border:1px solid #d9d5ca;border-radius:8px;overflow:hidden">
  <tr><td style="background:#c4522c;padding:14px 28px">
    <span style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.78rem;font-weight:700;color:#ffffff;letter-spacing:.5px;text-transform:uppercase">CCA Practice Platforms</span>
  </td></tr>
  <tr><td style="padding:32px 28px 28px;color:#191918;line-height:1.7">
${bodyHtml}
  </td></tr>
  <tr><td style="border-top:1px solid #d9d5ca;padding:16px 28px;background:#f5f3ea">
    <p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.68rem;color:#6f6f66;margin:0 0 5px;line-height:1.5">
      CCA Practice Platforms: independent practice prep, not affiliated with or endorsed by Anthropic.<br>
      CCA Practice Platforms, 361 Falls Rd #831, Grafton, WI 53024, USA<br>
      Questions? <a href="mailto:support@claudecertifiedarchitects.com" style="color:#6f6f66">support@claudecertifiedarchitects.com</a>
    </p>
${reasonLine ? `    <p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.68rem;color:#6f6f66;margin:0 0 5px;line-height:1.5">${reasonLine}</p>
` : ''}    <p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.68rem;color:#6f6f66;margin:0">
      <a href="${unsubUrl}" style="color:#6f6f66;text-decoration:underline">Unsubscribe</a> from ${reasonLine ? 'these emails' : 'CCA study tips'}.
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function eP(text, extraStyle) {
  const s = extraStyle
    ? `font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.9rem;color:#191918;line-height:1.7;margin:0 0 16px;${extraStyle}`
    : `font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.9rem;color:#191918;line-height:1.7;margin:0 0 16px`;
  return `<p style="${s}">${text}</p>`;
}

function eBtn(label, url) {
  return `<div style="text-align:center;margin:28px 0">` +
    `<a href="${url}" style="display:inline-block;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;` +
    `font-size:.9rem;font-weight:700;color:#ffffff;background:#c4522c;padding:13px 30px;` +
    `border-radius:7px;text-decoration:none;letter-spacing:.1px">${label}</a></div>`;
}

// ── Email 1 (D+1): "What your CCA diagnostic actually told you" ───────────────
function buildEmail1(results, unsubUrl) {
  const score  = results.estimatedScore      || 0;
  const pass   = results.passScore           || 720;
  const gap    = pass - score;
  const above  = gap <= 0;
  const domain = results.weakestDomain       || 'Agentic Architecture & Orchestration';
  const weight = results.weakestDomainWeight || 27;
  const domainH = escHtml(domain), scoreH = escHtml(score), gapH = escHtml(gap), weightH = escHtml(weight); // HTML-safe copies
  // Perfect sample: every domain correct equals its total. No weakest area is
  // named, the bank paragraph is dropped (the copy below carries the offer), and the above-pass
  // weakest-area sentence is replaced. Freeze exception 3, 28 Sep 2026.
  const perfect = Array.isArray(results.domains) && results.domains.length > 0 &&
    results.domains.every(d => d.total > 0 && d.correct === d.total);
  const weightC  = own(DIAG_DOMAIN_WEIGHTS, domain) || weight;   // the label's published exam share
  const weightCH = escHtml(weightC);
  const perfectCopy = "You got every question right on the diagnostic. That’s a strong start, but it was 10 questions, two per domain. The real exam is 60 scenario-based questions in 120 minutes, and one strong run on a small sample doesn’t show how you’ll do across all of them. The full practice bank has " + NURTURE_BANK_TOTAL + " questions across all five domains, so you can find out where you really stand before exam day.";
  const N      = own(NURTURE_DOMAIN_Q_COUNT, nurtureDomainKey(domain)) || null;
  // An unresolved domain publishes the bank total, not a guessed per-domain
  // count. The old `|| 80` was exact for one domain and wrong for the other four.
  const bankPhrase     = N ? `${N} questions in ${domain} alone`
                           : `${NURTURE_BANK_TOTAL} questions across all five domains`;
  const bankPhraseHtml = N ? `<strong>${N} questions in ${domainH}</strong> alone`
                           : `<strong>${NURTURE_BANK_TOTAL} questions</strong> across all five domains`;
  const tip    = own(STUDY_TIPS, nurtureDomainKey(domain)) || STUDY_TIPS['Agentic Architecture & Orchestration'];
  const cta    = nurtureCtaUrl('d1');

  const subject = 'What your CCA diagnostic actually told you';

  // ── plain text ──
  const scoreLine = above
    ? `Your result: ${score}/1,000, above the 720 passing standard on a 10-question sample.\nYour weakest domain: ${domain} (${weight}% of the real exam).`
    : `Your result: ${score}/1,000, ${gap} points below the 720 passing standard.\nYour weakest domain: ${domain} (${weight}% of the real exam).`;
  const context = above
    ? `\nYour weakest area on the diagnostic was ${domain}, which makes up ${weightC}% of the real exam. It’s also worth knowing that two questions per domain is a small sample, so even a passing score here can’t show how you’ll do across the real exam’s 60 questions.\n`
    : `\n${domain} accounts for ${weight}% of your actual exam score. Closing that domain first gives you the biggest return on your study time.\n`;
  const scoreLineOut = perfect ? `Your result: ${score}/1,000, above the 720 passing standard on a 10-question sample.` : scoreLine;
  const contextOut   = perfect ? `\n${perfectCopy}\n` : context;
  const ctaCopy = above
    ? `The full bank has ${bankPhrase}. Run a timed simulation and confirm your readiness before you book.`
    : `The full bank has ${bankPhrase}, every answer fully explained. That’s where the gap closes: not from rereading docs, but from scenario-based practice exactly like the real exam.`;
  const ctaCopyOut = perfect ? null : ctaCopy;   // null lines are dropped from the array below

  const text = [
    'Hi,',
    '',
    'You took the CCA Foundations Diagnostic and asked for your results. Here’s what those numbers mean, plus one study tip worth more than the score alone.',
    '',
    scoreLineOut,
    contextOut,
    `── Study tip for ${domain} ──`,
    '',
    tip,
    '',
    '── What to do next ──',
    '',
    ctaCopyOut,
    (perfect ? null : ''),
    `Close the gap ($49):\n${cta}`,
    '',
    'Good luck,',
    'CCA Practice Platforms',
    '',
    '─────────────────────────────────────────',
    'CCA Practice Platforms: independent practice prep, not affiliated with or endorsed by Anthropic.',
    'CCA Practice Platforms, 361 Falls Rd #831, Grafton, WI 53024, USA',
    'Reply-To: support@claudecertifiedarchitects.com',
    `To stop receiving these emails: ${unsubUrl}`,
  ].filter(l => l !== null).join('\n');

  // ── HTML ──
  const scoreHtml = above
    ? eP(`Your result: <strong>${scoreH}/1,000</strong>, above the 720 passing standard on a 10-question sample. Your weakest domain: <strong>${domainH}</strong> (${weightH}% of the real exam).`)
    : eP(`Your result: <strong>${scoreH}/1,000</strong>, <strong>${gapH} points below</strong> the 720 passing standard. Your weakest domain: <strong>${domainH}</strong> (${weightH}% of the real exam).`);
  const contextHtml = above
    ? eP(`Your weakest area on the diagnostic was <strong>${domainH}</strong>, which makes up ${weightCH}% of the real exam. It’s also worth knowing that two questions per domain is a small sample, so even a passing score here can’t show how you’ll do across the real exam’s 60 questions.`)
    : eP(`${domainH} accounts for <strong>${weightH}%</strong> of your actual exam score. Closing that domain first gives you the biggest return on your study time.`);
  const scoreHtmlOut   = perfect ? eP(`Your result: <strong>${scoreH}/1,000</strong>, above the 720 passing standard on a 10-question sample.`) : scoreHtml;
  const contextHtmlOut = perfect ? eP(perfectCopy) : contextHtml;
  const tipBlock =
    `<div style="background:#f5f3ea;border-left:3px solid #c4522c;padding:14px 18px;margin:20px 0;border-radius:0 6px 6px 0">` +
    `<p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.68rem;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#b04928;margin:0 0 8px">Study tip: ${domainH}</p>` +
    `<p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.88rem;color:#191918;line-height:1.65;margin:0">${tip}</p>` +
    `</div>`;
  const ctaHtml = above
    ? eP(`The full bank has ${bankPhraseHtml}. Run a timed simulation before you book.`)
    : eP(`The full bank has ${bankPhraseHtml}, every answer fully explained. That’s where this gap closes.`);

  const bodyHtml =
    eP('Hi,') +
    eP('You took the CCA Foundations Diagnostic and asked for your results. Here’s what those numbers mean, plus one study tip worth more than the score alone.') +
    scoreHtmlOut + contextHtmlOut + tipBlock + (perfect ? '' : ctaHtml) +
    eBtn('Close the gap: $49', cta);

  return { subject, text, html: emailWrap(bodyHtml, unsubUrl) };
}

// ── Email 2 (D+3): "Why $49 beats a $125 retake" ─────────────────────────────
function buildEmail2(results, unsubUrl) {
  const score  = results.estimatedScore      || 0;
  const pass   = results.passScore           || 720;
  const gap    = pass - score;
  const above  = gap <= 0;
  const domain = results.weakestDomain       || 'Agentic Architecture & Orchestration';
  const domainH = escHtml(domain), gapH = escHtml(gap);   // HTML-safe copies; the text branches keep the raw values
  const sampleQ = own(SAMPLE_QUESTIONS, nurtureDomainKey(domain)) || SAMPLE_QUESTIONS['Agentic Architecture & Orchestration'];
  // Perfect sample: the question is presented as a sample from the exam's
  // largest domain, read from DIAG_DOMAIN_WEIGHTS, not as the candidate's
  // weakest area. Same question either way. Freeze exception 3, 28 Sep 2026.
  const perfect = Array.isArray(results.domains) && results.domains.length > 0 &&
    results.domains.every(d => d.total > 0 && d.correct === d.total);
  const [largestLabel, largestWeight] = Object.entries(DIAG_DOMAIN_WEIGHTS).reduce((a, b) => (b[1] > a[1] ? b : a));
  const largestLabelH = escHtml(largestLabel), largestWeightH = escHtml(largestWeight);
  const sampleLabel = perfect
    ? `── Sample question from ${largestLabel}, the largest domain on the exam at ${largestWeight}% ──`
    : `── Sample question (${domain}) ──`;
  const correctLetter = OPT_LETTERS[sampleQ.correct];
  const cta = nurtureCtaUrl('d3');

  const subject = 'Why $49 beats a $125 retake';

  // ── plain text ──
  const stakesPara = above
    ? `Your diagnostic showed you at passing level on a 10-question sample. The real exam is 60 questions at a harder difficulty curve, and it costs $125 (USD) to sit. A mandatory waiting period applies between attempts, so an underprepared attempt costs both the registration fee and weeks before you can retry.`
    : `You’re currently ${gap} points below the 720 passing standard. The real CCA Foundations exam costs $125 (USD), and a mandatory waiting period applies between attempts. Sitting it underprepared means losing both the fee and weeks before you can retry.`;
  const optText = sampleQ.options.map((o, i) => `  ${OPT_LETTERS[i]}. ${o}`).join('\n');

  const text = [
    'Hi,',
    '',
    stakesPara,
    '',
    '$49 for 400 practice questions is the straightforward hedge against that outcome. Here’s a taste of what those questions look like:',
    '',
    sampleLabel,
    '',
    sampleQ.q,
    '',
    optText,
    '',
    `Correct answer: ${correctLetter}. ${sampleQ.options[sampleQ.correct]}`,
    '',
    `Why: ${sampleQ.explain}`,
    '',
    '── The full bank ──',
    '',
    '400 questions exactly like this, across all five exam domains. Every answer includes a full explanation: not just what’s right, but why each wrong option is wrong.',
    '',
    '$49. 10-day money-back guarantee: if you are not satisfied, email us for a full refund.',
    '',
    `Unlock access:\n${cta}`,
    '',
    'CCA Practice Platforms',
    '',
    '─────────────────────────────────────────',
    'Independent practice prep, not affiliated with or endorsed by Anthropic.',
    'CCA Practice Platforms, 361 Falls Rd #831, Grafton, WI 53024, USA',
    'Reply-To: support@claudecertifiedarchitects.com',
    `To stop receiving these emails: ${unsubUrl}`,
  ].join('\n');

  // ── HTML ──
  const stakesHtml = above
    ? eP(`Your diagnostic showed you at passing level on a short sample. The real exam is 60 questions at a harder curve, and it costs <strong>$125 (USD)</strong>. A mandatory waiting period applies between attempts, so one underprepared attempt costs both the fee and weeks of time.`)
    : eP(`You’re currently <strong>${gapH} points below the 720 passing standard</strong>. The real CCA Foundations exam costs <strong>$125 (USD)</strong>, and a mandatory waiting period applies between attempts. Sitting it underprepared means losing both the fee and weeks before you can retry.`);

  const optRows = sampleQ.options.map((o, i) => {
    const isCorrect = i === sampleQ.correct;
    const bg  = isCorrect ? 'background:#f0fdf4;' : '';
    const col = isCorrect ? 'color:#1a4d3a;font-weight:600;' : 'color:#5a5a52;';
    const lCol = isCorrect ? '#1a4d3a' : '#6f6f66';
    const tick = isCorrect ? ' <span style="color:#2d7a5f;font-size:.72rem;margin-left:6px">✓ Correct</span>' : '';
    return `<tr><td style="padding:7px 12px;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.85rem;${bg}${col}border-radius:4px"><strong style="color:${lCol}">${OPT_LETTERS[i]}.</strong> ${o}${tick}</td></tr>`;
  }).join('');

  const questionBlock =
    `<div style="background:#f5f3ea;border:1px solid #d9d5ca;border-radius:8px;padding:20px;margin:24px 0">` +
    `<p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.68rem;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#b04928;margin:0 0 10px">Sample question: ${domainH}</p>` +
    `<p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.88rem;font-weight:600;color:#191918;line-height:1.6;margin:0 0 14px">${sampleQ.q}</p>` +
    `<table width="100%" cellpadding="0" cellspacing="4" border="0">${optRows}</table>` +
    `<p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.8rem;color:#5a5a52;line-height:1.55;margin:14px 0 0;border-top:1px solid #d9d5ca;padding-top:12px"><strong>Why:</strong> ${sampleQ.explain}</p>` +
    `</div>`;
  // The heading is swapped after the block is built so the non-perfect
  // heading line above stays exactly as it was.
  const questionBlockOut = perfect
    ? questionBlock.replace(/Sample question[^<]*<\/p>/, `Sample question from ${largestLabelH}, the largest domain on the exam at ${largestWeightH}%</p>`)
    : questionBlock;

  const bodyHtml =
    eP('Hi,') + stakesHtml +
    eP('$49 for 400 practice questions is the straightforward hedge. Here’s a taste:') +
    questionBlockOut +
    eP('400 questions like this, across all five domains. Every answer fully explained: not just what’s right, but why each wrong option is wrong.') +
    eP('$49. 10-day money-back guarantee: if you are not satisfied, email us for a full refund.', 'font-weight:700') +
    eBtn('Unlock access: $49', cta);

  return { subject, text, html: emailWrap(bodyHtml, unsubUrl) };
}

// ── Email 3 (D+7): "Your CCA gap is still open" ──────────────────────────────
function buildEmail3(results, unsubUrl) {
  const score  = results.estimatedScore      || 0;
  const pass   = results.passScore           || 720;
  const gap    = pass - score;
  const above  = gap <= 0;
  const domain = results.weakestDomain       || 'Agentic Architecture & Orchestration';
  const domainH = escHtml(domain), gapH = escHtml(gap);   // HTML-safe copies; the text branches keep the raw values
  const cta    = nurtureCtaUrl('d7');

  const subject = above ? 'One week on: is your CCA prep locked in?' : 'Your CCA gap is still open';

  // ── plain text ──
  const opening = above
    ? `When you took the diagnostic, you scored above the 720 passing standard on a short diagnostic sample.\n\nThe real exam is 60 questions: broader, harder, drawn from a much larger pool. A passing sample is a good sign, not a guarantee.`
    : `When you took the diagnostic, you were ${gap} points below the 720 passing standard, with ${domain} as your weakest area.\n\nThat gap doesn’t close on its own.`;

  const text = [
    'Hi,',
    '',
    opening,
    '',
    'If you’ve been studying, great. The full practice bank is the best thing you can add at this point: 400 scenario-based questions, domain-weighted exactly like the real exam, every answer fully explained.',
    '',
    `If now isn’t the right time, that’s fine. Come back when you’re ready:\n${cta}`,
    '',
    `If you want to close the gap: $49, 10-day money-back guarantee. Try it for a week. If you don’t feel more confident in ${domain}, email us within 10 days of purchase for a full refund.`,
    '',
    'Good luck with the exam.',
    'CCA Practice Platforms',
    '',
    '─────────────────────────────────────────',
    'Independent practice prep, not affiliated with or endorsed by Anthropic.',
    'CCA Practice Platforms, 361 Falls Rd #831, Grafton, WI 53024, USA',
    'Reply-To: support@claudecertifiedarchitects.com',
    `To stop receiving these emails: ${unsubUrl}`,
  ].join('\n');
  // Perfect sample: the guarantee names no domain. Swapped after the text is
  // built so the existing line stays as it was. Freeze exception 3, 28 Sep 2026.
  const perfect = Array.isArray(results.domains) && results.domains.length > 0 &&
    results.domains.every(d => d.total > 0 && d.correct === d.total);
  const textOut = perfect ? text.replace(`confident in ${domain},`, 'confident going into the exam,') : text;

  // ── HTML ──
  const openingHtml = above
    ? eP('When you took the diagnostic, you scored above the 720 passing standard on a short sample. The real exam is 60 questions: broader, harder, drawn from a much larger pool. A passing sample is a good sign, not a guarantee.')
    : eP(`When you took the diagnostic, you were <strong>${gapH} points below the 720 passing standard</strong>, with <strong>${domainH}</strong> as your weakest area.`) +
      eP('That gap doesn’t close on its own.');

  const riskBlock =
    `<div style="background:#f0fdf4;border:1.5px solid #a7f3d0;border-radius:8px;padding:18px 20px;margin:20px 0">` +
    `<p style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.88rem;color:#191918;line-height:1.65;margin:0">` +
    `<strong style="color:#1a4d3a">10-day money-back guarantee.</strong> Try the full 400-question bank for a week. ` +
    `If you don’t feel more confident in ${domainH}, get a full refund: email us within 10 days of purchase.</p>` +
    `</div>`;
  const riskBlockOut = perfect ? riskBlock.replace(`confident in ${domainH},`, 'confident going into the exam,') : riskBlock;

  const bodyHtml =
    eP('Hi,') + openingHtml +
    eP('The full practice bank is the best thing you can add at this stage: 400 scenario-based questions, domain-weighted exactly like the real exam, every answer fully explained.') +
    riskBlockOut +
    eP('If now isn’t the right time, come back when you’re ready. Good luck with the exam.') +
    eBtn('Close the gap: $49', cta);

  return { subject, text: textOut, html: emailWrap(bodyHtml, unsubUrl) };
}

// ── GET and POST /unsubscribe ─────────────────────────────────────────────────
// Finds the lead by unsubToken, sets unsubscribed:true, returns a confirmation
// page. Since row 576 it also records the address in email_suppressions, and a
// token no lead holds is tried against users/{uid}.abandoner.unsubToken (the
// checkout-abandoner emails; an indexed equality lookup, not a scan). POST is
// RFC 8058 one-click: mail clients POST to the List-Unsubscribe URL with the
// body List-Unsubscribe=One-Click. The token is in the query string, so one
// handler serves both; until row 576 that POST returned 404 for every nurture email.
async function handleUnsubscribe(req, res) {
  const token = (req.query.token || '').trim();
  if (!token) {
    return res.status(400).send(unsubPage('Missing or invalid unsubscribe link.', false));
  }
  try {
    const snap = await db.collection('diagnostic_leads')
      .where('unsubToken', '==', token)
      .limit(1)
      .get();
    if (snap.empty) {
      const users = await db.collection('users').where('abandoner.unsubToken', '==', token).limit(1).get();
      if (users.empty) {
        // Already unsubscribed or invalid token — treat as success to avoid leaking info
        return res.send(unsubPage('You are unsubscribed. You will not receive further emails from us.', true));
      }
      const uid = users.docs[0].id;
      let authEmail = null;
      try { authEmail = (await auth.getUser(uid)).email || null; } catch (_) {}
      const docEmail = users.docs[0].data().email || null;
      const email = authEmail || docEmail;
      let leadDocs = 0;
      if (email) {
        await suppressEmail(email, { unsubscribed: true, unsubscribedAt: admin.firestore.FieldValue.serverTimestamp(), source: 'abandoner_link' });
        if (docEmail && normEmail(docEmail) !== normEmail(email)) {
          await suppressEmail(docEmail, { unsubscribed: true, unsubscribedAt: admin.firestore.FieldValue.serverTimestamp(), source: 'abandoner_link' });
        }
        leadDocs = await stampLeadsUnsubscribed([authEmail, docEmail]);
      }
      console.log('[unsub] Unsubscribed abandoner token:', token, `(uid ${uid}, ${leadDocs} lead doc(s) under the address)`);
      return res.send(unsubPage('Done. You\'ve been unsubscribed. You won\'t receive any further emails from us.', true));
    }
    // Flag every lead doc under this address, not only the doc the token
    // belongs to: one submission per doc, so an address can hold several.
    const stamp   = { unsubscribed: true, unsubscribedAt: admin.firestore.FieldValue.serverTimestamp() };
    const first   = snap.docs[0];
    const targets = new Map([[first.id, first.ref]]);
    const rawEmail = first.data().email;
    if (typeof rawEmail === 'string' && rawEmail) {
      const siblings = await db.collection('diagnostic_leads').where('email', '==', rawEmail).get();
      siblings.forEach(d => targets.set(d.id, d.ref));
    }
    await Promise.all([...targets.values()].map(ref => ref.set(stamp, { merge: true })));
    if (typeof rawEmail === 'string' && rawEmail) {
      await suppressEmail(rawEmail, { unsubscribed: true, unsubscribedAt: admin.firestore.FieldValue.serverTimestamp(), source: 'lead_link' });
    }
    console.log('[unsub] Unsubscribed token:', token, `(${targets.size} lead doc(s) under the address)`);
    return res.send(unsubPage('Done. You\'ve been unsubscribed. You won\'t receive any further CCA study emails from us.', true));
  } catch (err) {
    console.error('[unsub] Error:', err.message);
    return res.status(500).send(unsubPage('Something went wrong. Email support@claudecertifiedarchitects.com to unsubscribe manually.', false));
  }
}
app.get('/unsubscribe', handleUnsubscribe);
app.post('/unsubscribe', express.urlencoded({ extended: false }), handleUnsubscribe);

function unsubPage(message, success) {
  const icon = success ? '✓' : '⚠';
  const title = success ? 'Unsubscribed' : 'Problem';
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title}: CCA Practice Platforms</title>
<style>
body{margin:0;padding:40px 20px;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;background:#f5f3ea;color:#191918;text-align:center}
.card{max-width:440px;margin:0 auto;background:#fff;border:1px solid #d9d5ca;border-radius:10px;padding:36px 32px}
h1{font-size:1.2rem;font-weight:700;margin:0 0 12px}
p{font-size:.9rem;color:#5a5a52;line-height:1.65;margin:0 0 16px}
a{color:#b04928}
.icon{font-size:2rem;margin-bottom:14px}
</style></head><body>
<div class="card">
  <div class="icon">${icon}</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <p><a href="${SITE_URL}/">← Back to CCA Practice Platforms</a></p>
  <p style="font-size:.72rem;color:#8a8a7f">Independent practice prep, not affiliated with or endorsed by Anthropic.</p>
</div>
</body></html>`;
}

// The sequence itself, run AFTER /nurture-send has responded. Logs a start
// line and a finish line with counts; a throw is logged by the caller's catch.
// `only`, when set, is a Set of lower-cased addresses: every other lead is
// skipped as not_in_only. Used for test sends to owner addresses.
async function runNurtureSequence(dryRun, only) {
  console.log(`[nurture] Run started — dryRun=${dryRun} only=${only ? only.size : 'all'} sequenceStart=${SEQUENCE_START.toISOString()}`);

  const result = { ok: true, dryRun, sent: 0, skipped: 0, errors: 0, details: [] };

  let snap;
  try {
    snap = await db.collection('diagnostic_leads').get();
  } catch (err) {
    console.error('[nurture] Failed to load diagnostic_leads:', err.message);
    throw new Error('DB read failed: ' + err.message);
  }

  const now = Date.now();

  // An address unsubscribes once. Several addresses hold more than one lead
  // doc (one submission per doc), so the skip is by address, not by doc.
  const unsubscribedEmails = new Set();
  snap.forEach(d => {
    const l = d.data();
    if (l.unsubscribed && l.email) unsubscribedEmails.add(String(l.email).toLowerCase().trim());
  });

  for (const doc of snap.docs) {
    const lead  = doc.data();
    const email = (lead.email || '').toLowerCase().trim();
    const tag   = `[nurture][${email || doc.id}]`;

    try {
      // 2. SEQUENCE_START cutoff — never touch old leads
      const submittedAt = lead.submittedAt ? lead.submittedAt.toDate() : null;
      if (!submittedAt || submittedAt < SEQUENCE_START) {
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: null, reason: 'before_cutoff' });
        continue;
      }

      // Validate email
      if (!email || !email.includes('@')) {
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: null, reason: 'invalid_email' });
        continue;
      }

      // Test sends: only the listed addresses are considered.
      if (only && !only.has(email)) {
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: null, reason: 'not_in_only' });
        continue;
      }

      // 3. Unsubscribed? By address, so a second lead doc under the same
      //    address is silent too.
      if (lead.unsubscribed || unsubscribedEmails.has(email)) {
        console.log(`${tag} skip: unsubscribed`);
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: null, reason: 'unsubscribed' });
        continue;
      }

      // 4. Find the earliest unsent stage that is now due, under the backlog
      //    rule above. Runs before the buyer lookups so those cost reads only
      //    for the few leads that are actually due.
      if (lead.sequenceClosed) {
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: null, reason: 'closed:' + lead.sequenceClosed });
        continue;
      }
      const ageMs      = now - submittedAt.getTime();
      const sentStages = lead.sequenceSent || [];
      const lastSentMs = (lead.lastNurtureAt && typeof lead.lastNurtureAt.toMillis === 'function') ? lead.lastNurtureAt.toMillis() : 0;
      let stageToSend  = null;
      let lateStage    = null;
      let tooSoonStage = null;

      for (const stage of STAGE_ORDER) {
        if (sentStages.includes(stage)) continue;
        if (ageMs < STAGE_MIN_AGE_MS[stage]) break;                                           // not due; no later stage can be
        if (ageMs - STAGE_MIN_AGE_MS[stage] > STAGE_MAX_LATE_MS) { lateStage = stage; break; } // overdue: skip and close
        if (lastSentMs && now - lastSentMs < STAGE_MIN_GAP_MS[stage]) { tooSoonStage = stage; break; }
        stageToSend = stage;
        break;
      }

      if (lateStage) {
        const lateDays = ((ageMs - STAGE_MIN_AGE_MS[lateStage]) / 86400000).toFixed(1);
        console.log(`${tag} skip: overdue (${lateStage} is ${lateDays}d past due; sequence closed)`);
        if (!dryRun) {
          await doc.ref.set({
            sequenceClosed:   'overdue:' + lateStage,
            sequenceClosedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: lateStage, reason: 'overdue' });
        continue;
      }
      if (tooSoonStage) {
        const sinceH = Math.round((now - lastSentMs) / 3600000);
        console.log(`${tag} skip: too_soon (${tooSoonStage} waits ${STAGE_MIN_GAP_MS[tooSoonStage] / 3600000}h after the previous send; ${sinceH}h so far)`);
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: tooSoonStage, reason: 'too_soon' });
        continue;
      }
      if (!stageToSend) {
        const ageH = Math.round(ageMs / 3600000);
        console.log(`${tag} skip: no_due_stage (age=${ageH}h sent=[${sentStages.join(',')}])`);
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: null, reason: 'no_due_stage' });
        continue;
      }

      // 5. Buyer suppression: pending_enrollments, then users.enrolled by the
      //    stored address, then the Auth custom claim. The claim lives on the
      //    account, and the webhook overwrites users.email with the checkout
      //    address at enrolment, so a buyer whose checkout address differs from
      //    the address on the lead is caught by the claim lookup.
      //    email_suppressions first (row 576): an address that unsubscribed
      //    through an abandoner email, or was flagged from a Resend export, is
      //    silent here too. diagnostic_leads.unsubscribed above keeps working.
      const suppression = await getSuppression(email);
      if (suppression && suppression.unsubscribed) {
        console.log(`${tag} skip: suppressed`);
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: null, reason: 'suppressed' });
        continue;
      }
      const pendingDoc = await db.collection('pending_enrollments').doc(email).get();
      if (pendingDoc.exists) {
        console.log(`${tag} skip: buyer_pending`);
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: null, reason: 'buyer_pending' });
        continue;
      }
      // users.email is written as typed at signup, so when the lower-cased
      // form finds nothing the address as the lead typed it is tried too (row 576).
      let usersSnap = await db.collection('users').where('email', '==', email).limit(1).get();
      const typedEmail = String(lead.email || '').trim();
      if (usersSnap.empty && typedEmail && typedEmail !== email) {
        usersSnap = await db.collection('users').where('email', '==', typedEmail).limit(1).get();
      }
      if (!usersSnap.empty && usersSnap.docs[0].data().enrolled === true) {
        console.log(`${tag} skip: buyer_enrolled`);
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: null, reason: 'buyer_enrolled' });
        continue;
      }
      // One email a day across the two sequences (row 576): an abandoner email
      // in the last 24h defers this stage to the next run. Best effort, since
      // this joins on users.email as the buyer check above does.
      if (!usersSnap.empty && abandonerSentWithin(usersSnap.docs[0].data().abandoner, now, ABANDONER_ONE_A_DAY_MS)) {
        console.log(`${tag} skip: abandoner_recent (deferred to the next run)`);
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: stageToSend, reason: 'abandoner_recent' });
        continue;
      }
      let claimEnrolled = false;
      try {
        const authUser = await auth.getUserByEmail(email);
        claimEnrolled = !!(authUser.customClaims && authUser.customClaims.enrolled === true);
      } catch (err) {
        if (err.code !== 'auth/user-not-found') throw err;   // no account is the normal case
      }
      if (claimEnrolled) {
        console.log(`${tag} skip: buyer_claim`);
        result.skipped++;
        result.details.push({ email, action: 'skip', stage: null, reason: 'buyer_claim' });
        continue;
      }

      // 6. Dry-run: log intent without sending or writing state
      if (dryRun) {
        console.log(`${tag} would_send: ${stageToSend}`);
        result.sent++;
        result.details.push({ email, action: 'would_send', stage: stageToSend, reason: null });
        continue;
      }

      // 7. Ensure unsubscribe token exists
      let unsubToken = lead.unsubToken;
      if (!unsubToken) {
        unsubToken = crypto.randomBytes(20).toString('hex');
      }
      const unsubUrl = `https://claude-certified-architect.onrender.com/unsubscribe?token=${unsubToken}`;

      // 8. Build email content
      const emailContent =
        stageToSend === 'd1' ? buildEmail1(lead.results || {}, unsubUrl) :
        stageToSend === 'd3' ? buildEmail2(lead.results || {}, unsubUrl) :
                               buildEmail3(lead.results || {}, unsubUrl);

      // 9. Send via Resend
      const ok = await sendViaResend({
        to:                 lead.email,
        subject:            emailContent.subject,
        text:               emailContent.text,
        html:               emailContent.html,
        replyTo:            'support@claudecertifiedarchitects.com',
        listUnsubscribeUrl: unsubUrl,
        kind:               'nurture_' + stageToSend,
      });

      if (ok) {
        // 10. Write state ONLY after confirmed send
        await doc.ref.set({
          sequenceSent:  admin.firestore.FieldValue.arrayUnion(stageToSend),
          unsubToken,
          lastNurtureAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        console.log(`${tag} sent: ${stageToSend}`);
        result.sent++;
        result.details.push({ email, action: 'sent', stage: stageToSend, reason: null });
      } else {
        console.error(`${tag} resend_rejected: ${stageToSend}`);
        result.errors++;
        result.details.push({ email, action: 'error', stage: stageToSend, reason: 'resend_rejected' });
      }

    } catch (err) {
      // Per-lead isolation: one failure must never abort the run
      console.error(`${tag} error:`, err.message);
      result.errors++;
      result.details.push({ email, action: 'error', stage: null, reason: err.message });
    }
  }

  console.log(`[nurture] Run complete — sent=${result.sent} skipped=${result.skipped} errors=${result.errors} dryRun=${dryRun}`);
  return result;
}

// ── Checkout-abandoner emails (freeze exception 10, row 576) ──────────────────
// Both carry the postal address, the reason line and the unsubscribe URL in
// the text and the HTML. The preview text is a hidden preheader span (a
// transactional send has no preview field).
function abandonerPreheader(text) {
  return `<span style="display:none;font-size:1px;color:#f5f3ea;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${text}</span>`;
}
function abandonerTextFooter(unsubUrl) {
  return [
    '',
    '─────────────────────────────────────────',
    'CCA Practice Platforms: independent practice prep, not affiliated with or endorsed by Anthropic.',
    ABANDONER_POSTAL,
    ABANDONER_REASON_LINE,
    'Reply-To: ' + ABANDONER_REPLY_TO,
    `To stop receiving these emails: ${unsubUrl}`,
  ].join('\n');
}

// Email A: the manual campaign's question, with the first paragraph reworded
// for the automated trigger (owner, 9 Oct 2026). No link in the body.
function buildAbandonerA(unsubUrl) {
  const subject = 'A quick question about your CCAR-F prep';
  const preview = 'Did something stop you at checkout? One quick question.';
  const text = [
    'Hi,',
    '',
    "You created an account on Claude Certified Architects and started to buy the CCAR-F practice bank, but didn't complete the purchase.",
    '',
    "That's completely fine, and this isn't a sales push. We'd genuinely like to know what stopped you, so we can fix it if the problem is on our side.",
    '',
    'Was it:',
    '',
    '1. The price',
    '2. The payment options at checkout',
    "3. Timing: your exam isn't coming up yet",
    '4. Something else',
    '',
    'Just reply with the number, or a line if it was something else. We read every reply.',
    '',
    'The CCA Practice team',
    abandonerTextFooter(unsubUrl),
  ].join('\n');
  const li = s => `<li style="margin:0 0 6px">${s}</li>`;
  const bodyHtml =
    abandonerPreheader(preview) +
    eP('Hi,') +
    eP("You created an account on Claude Certified Architects and started to buy the CCAR-F practice bank, but didn't complete the purchase.") +
    eP("That's completely fine, and this isn't a sales push. We'd genuinely like to know what stopped you, so we can fix it if the problem is on our side.") +
    eP('Was it:', 'margin:0 0 8px') +
    `<ol style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:.9rem;color:#191918;line-height:1.7;margin:0 0 16px;padding-left:24px">` +
    li('The price') + li('The payment options at checkout') + li("Timing: your exam isn't coming up yet") + li('Something else') +
    '</ol>' +
    eP('Just reply with the number, or a line if it was something else. We read every reply.') +
    eP('The CCA Practice team', 'margin:0');
  return { subject, text, html: emailWrap(bodyHtml, unsubUrl, ABANDONER_REASON_LINE) };
}

// Email B: straight answers, one button to the practice-questions page.
// Every claim verified against the product on 9 Oct 2026 (Phase A report);
// Google Pay dropped because no charge on the account has ever used it.
function buildAbandonerB(unsubUrl) {
  const subject = 'The exam costs $125. Practice costs $49.';
  const preview = 'Straight answers before you decide.';
  const QA = [
    ['"Is it worth $49?"',
     'The exam costs $125 per attempt, and a retake costs the full $125 again. The practice bank is a single $49 payment for 400 scenario-based questions across all five exam domains, every one with a written explanation, plus a full 60-question mock exam. If it helps you pass on your first attempt, it costs less than half of a retake.'],
    ['"Can I try it first?"',
     'Yes. The free diagnostic and the free Quick Sprint use questions from the same bank, so you can see the style and difficulty before you pay.'],
    ['"My payment didn\'t go through."',
     'Checkout accepts cards and, depending on your device and country, wallets such as Apple Pay and UPI, and shows prices in your local currency where available. If your card was declined or something looked wrong, reply to this email and tell us what happened. We\'ll help.'],
    ['"My exam is months away."',
     'Your free account stays open. When your date gets closer, the free diagnostic is a quick way to see which domains need the most work.'],
    ['"Is this the official Anthropic site?"',
     'No. We\'re an independent exam-prep site. The practice bank covers all five domains in Anthropic\'s published exam guide, and registration for the exam itself happens through Anthropic Partner Academy.'],
    ['"What if it isn\'t for me?"',
     'There\'s a 10-day money-back guarantee: if you\'re not satisfied, request a full refund within 10 days of purchase.'],
  ];
  const intro = "If you're working toward the Claude Certified Architect credential, here are straight answers to common questions about the practice bank.";
  const independence = 'Claude Certified Architects is an independent exam-prep site, not affiliated with Anthropic.';
  const text = [
    'Hi,',
    '',
    intro,
    '',
    ...QA.flatMap(([q, a]) => [q, a, '']),
    `See the practice questions:\n${ABANDONER_B_URL}`,
    '',
    'The CCA Practice team',
    '',
    independence,
    abandonerTextFooter(unsubUrl),
  ].join('\n');
  const bodyHtml =
    abandonerPreheader(preview) +
    eP('Hi,') +
    eP(intro) +
    QA.map(([q, a]) => eP(`<strong>${escHtml(q)}</strong><br>${escHtml(a)}`)).join('') +
    eBtn('See the practice questions', ABANDONER_B_URL) +
    eP('The CCA Practice team') +
    eP(independence, 'font-size:.8rem;color:#6f6f66;margin:0');
  return { subject, text, html: emailWrap(bodyHtml, unsubUrl, ABANDONER_REASON_LINE) };
}

// The abandoner runner, chained after runNurtureSequence by /nurture-send so
// its one-a-day check sees today's nurture sends. Same dryRun and only
// semantics as the nurture runner. Decision order per candidate, each exit
// logged with its reason; "closed" writes users/{uid}.abandoner.closed and are
// terminal, "skip" writes nothing and the candidate is looked at again next run.
async function runAbandonerSequence(dryRun, only) {
  const enabled = abandonerEnabled();
  if (!enabled && !only && !dryRun) {
    console.log('[abandoner] disabled (ABANDONER_EMAILS_ENABLED is not "true"); nothing read, nothing sent');
    return { ok: true, disabled: true, sent: 0, skipped: 0, closed: 0, errors: 0, details: [] };
  }
  const now = Date.now();
  console.log(`[abandoner] Run started, dryRun=${dryRun} only=${only ? only.size : 'all'} enabled=${enabled} start=${ABANDONER_START.toISOString()}`);
  const result = { ok: true, dryRun, sent: 0, skipped: 0, closed: 0, errors: 0, details: [] };

  // Volume guard: this process's sends so far today (UTC), all kinds.
  let sentToday = 0;
  try {
    const c = await sendCountRef(new Date(now)).get();
    sentToday = (c.exists && Number(c.data().total)) || 0;
  } catch (err) {
    console.warn('[abandoner] send counter unreadable, assuming 0:', err.message);
  }

  const since = new Date(Math.max(ABANDONER_START.getTime(), now - ABANDONER_WINDOW_MS));
  let snap;
  try {
    // Single-field range: documents without firstBuyClickAt are not in the
    // index, so this is not a collection scan (primer section 26).
    snap = await db.collection('users').where('firstBuyClickAt', '>=', since).get();
  } catch (err) {
    console.error('[abandoner] Failed to load candidates:', err.message);
    throw new Error('DB read failed: ' + err.message);
  }
  console.log(`[abandoner] candidates since ${since.toISOString()}: ${snap.size}; sent today before this run: ${sentToday}`);

  for (const doc of snap.docs) {
    const uid  = doc.id;
    const data = doc.data();
    const ab   = data.abandoner || {};
    let email  = normEmail(data.email);
    let tag    = `[abandoner][${email || uid}]`;
    const note = (action, step, reason) => { result.details.push({ email, uid, action, step, reason }); };
    const close = async (reason, step) => {
      console.log(`${tag} closed: ${reason}`);
      if (!dryRun) {
        await doc.ref.set({ abandoner: { closed: reason, closedAt: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });
      }
      result.closed++; note('close', step || null, reason);
    };
    const skip = (reason, step) => { console.log(`${tag} skip: ${reason}`); result.skipped++; note('skip', step || null, reason); };

    try {
      if (ab.closed) { result.skipped++; note('skip', null, 'closed:' + ab.closed); continue; }

      // The Auth record: the address to send to (users.email is overwritten by
      // the checkout address at enrolment) and the enrolled claim.
      let authUser = null;
      try { authUser = await auth.getUser(uid); }
      catch (err) { if (err.code !== 'auth/user-not-found') throw err; }
      if (!authUser) {
        // A test run (only=) must not write to accounts it was not given.
        if (only) { result.skipped++; note('skip', null, 'not_in_only'); continue; }
        await close('no_account'); continue;
      }
      const rawEmail = authUser.email || data.email || '';
      email = normEmail(rawEmail);
      tag   = `[abandoner][${email || uid}]`;
      if (!email || !email.includes('@')) { await close('no_email'); continue; }

      if (only) {
        if (!only.has(email)) { result.skipped++; note('skip', null, 'not_in_only'); continue; }
      } else if (ABANDONER_TEST_MARKERS.some(m => email.includes(m))) {
        await close('test_account'); continue;
      }

      const step = !ab.aSentAt ? 'a' : (!ab.bSentAt ? 'b' : null);
      if (!step) { await close('done'); continue; }
      const basis = step === 'a' ? tsMs(data.firstBuyClickAt) : tsMs(ab.aSentAt);
      if (!basis) { await close('no_basis:' + step, step); continue; }
      const dueAt = basis + ABANDONER_MIN_AGE_MS[step];
      if (now < dueAt) { skip('not_due:' + step, step); continue; }
      if (now - dueAt > ABANDONER_MAX_LATE_MS) { await close('overdue:' + step, step); continue; }

      // Buyer: the claim, the field, or a paid-but-unclaimed record.
      const claimEnrolled = !!(authUser.customClaims && authUser.customClaims.enrolled === true);
      if (claimEnrolled || data.enrolled === true) { await close('buyer', step); continue; }
      const pendingDoc = await db.collection('pending_enrollments').doc(email).get();
      if (pendingDoc.exists) { await close('buyer_pending', step); continue; }

      const suppression = await getSuppression(email);
      if (suppression && suppression.unsubscribed)      { await close('unsubscribed', step); continue; }
      if (suppression && suppression.manualCampaignA)   { await close('manual_campaign', step); continue; }
      if (step === 'b' && suppression && suppression.replied) { await close('replied', step); continue; }

      // One email a day across the two sequences: defer, never close.
      if (await leadNurturedWithin([rawEmail, data.email], now, ABANDONER_ONE_A_DAY_MS)) { skip('nurture_recent:' + step, step); continue; }

      if (sentToday + result.sent >= ABANDONER_DAILY_CAP) {
        console.log(`[abandoner] daily-guard: ${sentToday} sent today before this run + ${result.sent} this run, cap ${ABANDONER_DAILY_CAP}; stopping, the rest wait for tomorrow`);
        note('skip', step, 'daily-guard');
        break;
      }

      if (dryRun) { console.log(`${tag} would_send: ${step}`); result.sent++; note('would_send', step, null); continue; }

      const unsubToken = ab.unsubToken || crypto.randomBytes(20).toString('hex');
      const unsubUrl   = `https://claude-certified-architect.onrender.com/unsubscribe?token=${unsubToken}`;
      const content    = step === 'a' ? buildAbandonerA(unsubUrl) : buildAbandonerB(unsubUrl);
      const ok = await sendViaResend({
        to:                 rawEmail,
        from:               ABANDONER_FROM,
        subject:            content.subject,
        text:               content.text,
        html:               content.html,
        replyTo:            ABANDONER_REPLY_TO,
        listUnsubscribeUrl: unsubUrl,
        kind:               'abandoner_' + step,
      });
      if (!ok) { console.error(`${tag} resend_rejected: ${step}`); result.errors++; note('error', step, 'resend_rejected'); continue; }

      // State ONLY after a confirmed send. Merge is deep for the map.
      const stamp = { unsubToken, [step + 'SentAt']: admin.firestore.FieldValue.serverTimestamp() };
      if (step === 'b') { stamp.closed = 'done'; stamp.closedAt = admin.firestore.FieldValue.serverTimestamp(); }
      await doc.ref.set({ abandoner: stamp }, { merge: true });
      await db.collection('abandoner_sends').doc(`${uid}_${step}`).set({
        uid, email, step,
        sentAt:          admin.firestore.FieldValue.serverTimestamp(),
        firstBuyClickAt: data.firstBuyClickAt || null,
        dueAt:           new Date(dueAt),
      });
      console.log(`${tag} sent: ${step}`);
      result.sent++; note('sent', step, null);
    } catch (err) {
      // Per-candidate isolation: one failure must never abort the run
      console.error(`${tag} error:`, err.message);
      result.errors++; note('error', null, err.message);
    }
  }

  console.log(`[abandoner] Run complete, sent=${result.sent} skipped=${result.skipped} closed=${result.closed} errors=${result.errors} dryRun=${dryRun}`);
  return result;
}

// ── POST /nurture-send ─────────────────────────────────────────────────────
// Called once daily by cron-job.org. Auth: ?secret= (what the job uses today,
// deprecated because it lands in request logs) or the x-nurture-secret header.
// Dry-run: add ?dryRun=true to log decisions without sending or writing state.
// Test sends: add ?only=a@x.com,b@y.com to consider those addresses alone.
//
// RESPONDS FIRST, THEN PROCESSES. cron-job.org's free plan times out at 30 s and
// a cold-start run takes ~100 s, so the job reported "Failed (timeout)" daily
// for a run that succeeded. After this the dashboard will always say success;
// the start/finish log lines and lastNurtureAt on the leads are the evidence.
//
// Required env vars: NURTURE_CRON_SECRET
// Optional env var:  SEQUENCE_START (ISO date — defaults to 2026-06-19)
app.post('/nurture-send', express.json(), async (req, res) => {
  // 1. Authenticate — BEFORE the 200. Constant-time compare via secretMatches().
  const viaQuery = typeof req.query.secret === 'string' && req.query.secret.length > 0;
  const provided = String(req.query.secret || req.headers['x-nurture-secret'] || '').trim();
  if (!process.env.NURTURE_CRON_SECRET || !secretMatches(provided, process.env.NURTURE_CRON_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (viaQuery) {
    console.warn('[nurture] DEPRECATED: secret supplied as ?secret= (it lands in request logs). Move the cron job to the x-nurture-secret header; the query form still works until then.');
  }
  const dryRun = req.query.dryRun === 'true' || req.query.dryRun === '1';
  // only=a@x.com,b@y.com restricts the run to those addresses (test sends).
  let only = null;
  if (typeof req.query.only === 'string' && req.query.only.trim()) {
    // A literal + in a query string decodes to a space; an address never
    // contains one, so a space is put back as the + it was (9 Oct 2026 test).
    only = new Set(req.query.only.split(',').map(s => s.toLowerCase().trim().replace(/ /g, '+')).filter(s => s.includes('@')));
    if (only.size === 0) only = null;
  }

  // 2. Respond now. Nothing after this line reaches the caller.
  res.json({ ok: true, started: true, dryRun, only: only ? only.size : null });

  // 3. Run. The catch is what stops a throw in the background portion from
  //    becoming an unhandled rejection that takes the process down.
  runNurtureSequence(dryRun, only)
    .catch(err => console.error('[nurture] FAILED after response —', (err && err.message) || err))
    // Checkout-abandoner sequence (freeze exception 10, row 576), AFTER the
    // nurture run so its one-a-day check sees today's nurture sends. Its own
    // catch, so a throw here is never read as a nurture failure.
    .then(() => runAbandonerSequence(dryRun, only))
    .catch(err => console.error('[abandoner] FAILED after response,', (err && err.message) || err));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Stripe webhook server listening on port ${PORT}`));
