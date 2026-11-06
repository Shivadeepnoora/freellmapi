// HTTP server for the company's outside-facing work. Point AGENTS_WEBHOOK_URL
// at it for approved actions, and AGENTS_SIGNUP_URL at its public address so
// published landing pages can collect signups.
//
//   POST /         approved action (needs x-agents-secret). Publishes landing
//                  pages to GitHub Pages; anything else → {"status":"ignored"}.
//   POST /signup   public: {page, email, consent:true, website:""} from a page
//   POST /event    public: {page, type:"view"} anonymous page-view beacon
//   GET  /stats    per-page counts, no emails (needs x-agents-secret)
//   GET  /healthz
//
// Public endpoints accept only allowed origins, are rate limited per client,
// ignore honeypot submissions, and require explicit consent.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { slugify } from '../execution.mjs';
import { injectSignup, privacyPage } from '../site/signup.mjs';
import { PAGE_RE } from '../feedback/metrics.mjs';

const MAX_BODY_BYTES = 2_000_000;
const MAX_PUBLIC_BODY_BYTES = 4_000;

export function createWebhookServer({
  publisher,
  secret,
  metrics = null,
  allowedOrigins = [],
  site = {},
  trustProxy = false,
  rateLimit = { windowMs: 60 * 60_000, signups: 10, events: 300 },
  log = () => {},
}) {
  if (!secret || secret.length < 16) throw new Error('webhook-server needs AGENTS_WEBHOOK_SECRET of at least 16 characters');
  const expected = Buffer.from(secret);
  const origins = new Set(allowedOrigins.map((o) => o.replace(/\/$/, '').toLowerCase()));
  const limiter = new RateLimiter(rateLimit.windowMs);
  const authorised = (req) => {
    const given = Buffer.from(String(req.headers['x-agents-secret'] ?? ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  return createServer(async (req, res) => {
    const origin = String(req.headers.origin ?? '').toLowerCase();
    const originAllowed = origins.has(origin);
    const reply = (status, body, cors = false) => {
      const headers = { 'content-type': 'application/json' };
      if (cors && originAllowed) Object.assign(headers, { 'access-control-allow-origin': origin, vary: 'Origin' });
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && path === '/healthz') {
        return reply(200, { ok: true, githubPages: Boolean(publisher), signups: Boolean(metrics) });
      }

      // ---- public endpoints used by published pages -------------------------
      if (path === '/signup' || path === '/event') {
        if (req.method === 'OPTIONS') {
          if (!originAllowed) return reply(403, { error: 'origin not allowed' });
          res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'Origin' });
          return res.end();
        }
        if (req.method !== 'POST') return reply(405, { error: 'method not allowed' });
        if (!metrics) return reply(503, { error: 'signups are not enabled' }, true);
        if (!originAllowed) return reply(403, { error: 'origin not allowed' });
        const client = clientId(req, trustProxy);
        const kind = path === '/signup' ? 'signups' : 'events';
        if (!limiter.take(`${kind}:${client}`, rateLimit[kind])) return reply(429, { error: 'Too many requests, please try again later.' }, true);

        let body;
        try { body = JSON.parse(await readBody(req, MAX_PUBLIC_BODY_BYTES)); } catch { return reply(400, { error: 'invalid request' }, true); }
        if (!PAGE_RE.test(String(body?.page ?? ''))) return reply(400, { error: 'invalid page' }, true);

        if (path === '/event') {
          if (body.type === 'view') metrics.recordView(body.page);
          return reply(200, { ok: true }, true);
        }
        // Honeypot filled in: pretend success so bots learn nothing.
        if (body.website) return reply(200, { ok: true }, true);
        if (body.consent !== true) return reply(400, { error: 'Please tick the consent box.' }, true);
        const result = metrics.addSignup(body.page, body.email);
        if (!result.added && result.reason === 'invalid email') return reply(400, { error: 'Please enter a valid email address.' }, true);
        log(`[signup] ${body.page}${result.added ? '' : ' (duplicate)'}`);
        return reply(200, { ok: true }, true);
      }

      // ---- authenticated endpoints -------------------------------------------
      if (req.method === 'GET' && path === '/stats') {
        if (!authorised(req)) return reply(401, { error: 'bad secret' });
        return reply(200, { pages: metrics ? await metrics.stats() : {} });
      }
      if (req.method !== 'POST' || path !== '/') return reply(404, { error: 'not found' });
      if (!authorised(req)) return reply(401, { error: 'bad secret' });

      let body;
      try { body = JSON.parse(await readBody(req, MAX_BODY_BYTES)); } catch (err) {
        return reply(err.message === 'too large' ? 413 : 400, { error: err.message === 'too large' ? 'payload too large' : 'invalid JSON' });
      }
      const result = await handleAction(body, publisher, site);
      log(`[webhook] ${body?.action?.id ?? '?'} -> ${result.status}${result.url ? ` ${result.url}` : ''}`);
      return reply(200, result);
    } catch (err) {
      log(`[webhook] error: ${err.message}`);
      return reply(502, { error: err.message });
    }
  });
}

export async function handleAction(body, publisher, site = {}) {
  const action = body?.action;
  if (!action?.id) return { status: 'ignored', reason: 'no action in payload' };
  if (action.status !== 'approved') return { status: 'ignored', reason: `action is ${action.status}, not approved` };
  if (!publisher) return { status: 'ignored', reason: 'GitHub Pages is not configured on this webhook server' };
  if (!publisher.canHandle(action)) return { status: 'ignored', reason: `no executor for kind "${action.kind}"` };
  if (typeof body.content !== 'string') return { status: 'ignored', reason: 'payload has no page content' };
  return publishLandingPage(publisher, action, body.content, site);
}

// Publishes <slug>/index.html (with signup capture when signupUrl is set) and
// <slug>/privacy.html. Returns the page id so results can be matched later.
export async function publishLandingPage(publisher, action, content, site = {}) {
  const page = slugify(action.opportunity ?? action.title ?? 'page');
  const label = action.opportunity ?? action.title;
  const html = site.signupUrl ? injectSignup(content, { endpoint: site.signupUrl, page }) : content;
  await publisher.publish({
    path: `${page}/privacy.html`,
    content: privacyPage({ businessName: site.businessName, contactEmail: site.contactEmail, opportunity: label }),
    message: `Privacy notice: ${label} (${action.id})`,
  });
  const { url, commitSha } = await publisher.publish({
    path: `${page}/index.html`,
    content: html,
    message: `Publish landing page: ${label} (${action.id})`,
  });
  return { status: 'executed', executor: 'github-pages', url, commitSha, page, signupCapture: Boolean(site.signupUrl) };
}

class RateLimiter {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  take(key, limit, now = Date.now()) {
    const entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      if (this.hits.size > 10_000) this.#prune(now);
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
  }

  #prune(now) {
    for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
  }
}

// Only trust X-Forwarded-For when told the server sits behind a proxy;
// otherwise any client could pick its own rate-limit bucket.
function clientId(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
