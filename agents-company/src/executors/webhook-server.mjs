// A small HTTP receiver for approved actions. Point AGENTS_WEBHOOK_URL at it.
// It checks the shared secret, publishes approved landing pages to GitHub Pages,
// and answers {"status":"ignored"} for actions it does not handle, which the
// sender then marks for manual follow-up.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { slugify } from '../execution.mjs';

const MAX_BODY_BYTES = 2_000_000;

export function createWebhookServer({ publisher, secret, log = () => {} }) {
  if (!secret || secret.length < 16) throw new Error('webhook-server needs AGENTS_WEBHOOK_SECRET of at least 16 characters');
  const expected = Buffer.from(secret);

  return createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/healthz') return reply(200, { ok: true, githubPages: Boolean(publisher) });
      if (req.method !== 'POST' || req.url !== '/') return reply(404, { error: 'not found' });

      const given = Buffer.from(String(req.headers['x-agents-secret'] ?? ''));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply(401, { error: 'bad secret' });

      let body;
      try { body = JSON.parse(await readBody(req)); } catch (err) {
        return reply(err.message === 'too large' ? 413 : 400, { error: err.message === 'too large' ? 'payload too large' : 'invalid JSON' });
      }
      const result = await handleAction(body, publisher);
      log(`[webhook] ${body?.action?.id ?? '?'} -> ${result.status}${result.url ? ` ${result.url}` : ''}`);
      return reply(200, result);
    } catch (err) {
      log(`[webhook] error: ${err.message}`);
      return reply(502, { error: err.message });
    }
  });
}

export async function handleAction(body, publisher) {
  const action = body?.action;
  if (!action?.id) return { status: 'ignored', reason: 'no action in payload' };
  if (action.status !== 'approved') return { status: 'ignored', reason: `action is ${action.status}, not approved` };
  if (!publisher) return { status: 'ignored', reason: 'GitHub Pages is not configured on this webhook server' };
  if (!publisher.canHandle(action)) return { status: 'ignored', reason: `no executor for kind "${action.kind}"` };
  if (typeof body.content !== 'string') return { status: 'ignored', reason: 'payload has no page content' };
  return publishLandingPage(publisher, action, body.content);
}

export async function publishLandingPage(publisher, action, content) {
  const path = `${slugify(action.opportunity ?? action.title ?? 'page')}/index.html`;
  const { url, commitSha } = await publisher.publish({
    path,
    content,
    message: `Publish landing page: ${action.opportunity ?? action.title} (${action.id})`,
  });
  return { status: 'executed', executor: 'github-pages', url, commitSha };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
