import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResendMailer, mailerFromConfig } from '../src/email/resend.mjs';
import { parseNewsletter, markdownToHtml, markdownToText, broadcastEmail, confirmationEmail, welcomeEmail } from '../src/email/templates.mjs';
import { sendBroadcast, canBroadcast } from '../src/email/broadcast.mjs';
import { MetricsStore } from '../src/feedback/metrics.mjs';
import { createWebhookServer, handleAction, humanize } from '../src/executors/webhook-server.mjs';
import { buildExecutors, subscribersAreLocal } from '../src/executors/index.mjs';
import { ApprovalQueue } from '../src/approvals.mjs';
import { loadConfig, validateConfig } from '../src/config.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'agents-email-'));
const noSleep = async () => {};
const SITE = { signupUrl: 'https://signup.example.com', businessName: 'Acme', contactEmail: 'hi@acme.co', postalAddress: '1 Main St, Springfield' };

function fakeMailer({ failBatches = [] } = {}) {
  const m = { sent: [], batches: [] };
  m.send = async (msg) => { m.sent.push(msg); return { id: `e${m.sent.length}` }; };
  m.sendBatch = async (msgs, opts) => {
    const n = m.batches.length;
    m.batches.push({ msgs, key: opts?.idempotencyKey });
    if (failBatches.includes(n)) throw new Error('Resend 500');
    return { ids: msgs.map((_, i) => `b${i}`) };
  };
  return m;
}

// ---- Resend client --------------------------------------------------------

test('ResendMailer sends the documented request shape with an idempotency key', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return Response.json({ id: 'em_1' }); };
  const mailer = new ResendMailer({ apiKey: 're_key', from: 'Acme <hi@acme.co>', replyTo: 'me@acme.co', fetchImpl, sleep: noSleep });
  const r = await mailer.send({ to: 'a@b.co', subject: 'S', text: 'T', html: '<p>H</p>', headers: { 'List-Unsubscribe': '<u>' } }, { idempotencyKey: 'k1' });
  assert.equal(r.id, 'em_1');
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].headers.authorization, 'Bearer re_key');
  assert.equal(calls[0].headers['idempotency-key'], 'k1');
  assert.deepEqual(calls[0].body, { from: 'Acme <hi@acme.co>', to: ['a@b.co'], subject: 'S', text: 'T', html: '<p>H</p>', reply_to: 'me@acme.co', headers: { 'List-Unsubscribe': '<u>' } });
});

test('ResendMailer batches to /emails/batch, caps batch size, retries 429 but not 422', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    if (calls === 1) return new Response('{"message":"rate limited"}', { status: 429, headers: { 'retry-after': '1' } });
    assert.equal(url, 'https://api.resend.com/emails/batch');
    assert.equal(JSON.parse(init.body).length, 2);
    return Response.json({ data: [{ id: 'x' }, { id: 'y' }] });
  };
  const waits = [];
  const mailer = new ResendMailer({ apiKey: 'k', from: 'a@b.co', fetchImpl, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual((await mailer.sendBatch([{ to: '1@x.co' }, { to: '2@x.co' }])).ids, ['x', 'y']);
  assert.deepEqual(waits, [1000]);
  await assert.rejects(mailer.sendBatch(Array.from({ length: 101 }, () => ({ to: 'a@b.co' }))), /limited to 100/);

  calls = 0;
  const bad = new ResendMailer({ apiKey: 'k', from: 'a@b.co', fetchImpl: async () => { calls++; return new Response('{"message":"The from domain is not verified"}', { status: 422 }); }, sleep: noSleep });
  await assert.rejects(bad.send({ to: 'a@b.co' }), /422: The from domain is not verified/);
  assert.equal(calls, 1);
  assert.throws(() => new ResendMailer({ apiKey: 'k' }), /AGENTS_EMAIL_FROM/);
  assert.equal(mailerFromConfig({}), null);
});

// ---- templates ------------------------------------------------------------

test('newsletter parsing and safe Markdown rendering', () => {
  assert.deepEqual(parseNewsletter('Subject: Hello there\n\nBody **text**'), { subject: 'Hello there', body: 'Body **text**' });
  assert.throws(() => parseNewsletter('No subject line\n\nbody'), /Subject/);
  assert.throws(() => parseNewsletter('Subject: x\n\n'), /subject and a body/);

  const html = markdownToHtml('# Title\n\nHi <script>alert(1)</script> **bold** [ok](https://a.co/x?a=1&b=2) [bad](javascript:alert(1))\n\n- one\n- two');
  assert.match(html, /<h2>Title<\/h2>/);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<a href="https:\/\/a\.co\/x\?a=1&amp;b=2">ok<\/a>/);
  assert.ok(!html.includes('href="javascript'));
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.equal(markdownToText('**a** [b](https://c.co)'), 'a b (https://c.co)');
});

test('broadcast and welcome emails carry unsubscribe link, one-click headers, sender and postal address', () => {
  const e = broadcastEmail({ to: 'a@b.co', subject: 'S', body: 'Hello', unsubscribeUrl: 'https://s.io/unsubscribe?t=abc', site: SITE });
  assert.deepEqual(e.headers, { 'List-Unsubscribe': '<https://s.io/unsubscribe?t=abc>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  for (const part of [e.text, e.html]) {
    assert.match(part, /unsubscribe\?t=abc/i);
    assert.match(part, /Acme, 1 Main St, Springfield/);
  }
  const w = welcomeEmail({ to: 'a@b.co', opportunity: 'Idea', unsubscribeUrl: 'https://s.io/unsubscribe?t=abc', site: SITE });
  assert.match(w.subject, /Idea/);
  assert.ok(w.headers['List-Unsubscribe']);
  const c = confirmationEmail({ to: 'a@b.co', opportunity: '<b>Idea</b>', confirmUrl: 'https://s.io/confirm?t=xyz', site: SITE });
  assert.match(c.html, /href="https:\/\/s\.io\/confirm\?t=xyz"/);
  assert.match(c.html, /&lt;b&gt;Idea/);
});

// ---- subscriber lifecycle ---------------------------------------------------

test('double opt-in: pending until confirmed; unsubscribe is permanent; legacy records count as confirmed', async () => {
  const store = new MetricsStore(tmp());
  const { signup } = store.addSignup('idea', 'a@b.co', new Date(), { doubleOptIn: true });
  assert.equal(signup.status, 'pending');
  assert.match(signup.confirmToken, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(store.subscribers('idea'), []);

  assert.equal(store.confirm('wrong-token'), null);
  assert.equal(store.confirm(signup.confirmToken).changed, true);
  assert.equal(store.confirm(signup.confirmToken).changed, false);
  assert.deepEqual(store.subscribers('idea').map((s) => s.email), ['a@b.co']);

  assert.equal(store.unsubscribe(signup.unsubToken).changed, true);
  assert.deepEqual(store.subscribers('idea'), []);
  assert.equal(store.confirm(signup.confirmToken), null, 'confirm link stops working after unsubscribing');

  store.signups.push({ page: 'idea', email: 'old@b.co', consent: true, at: 'then' }); // pre-status record
  assert.deepEqual(store.subscribers('idea').map((s) => s.email), ['old@b.co']);
  const stats = (await store.stats()).idea;
  assert.deepEqual([stats.confirmed, stats.pending, stats.unsubscribed], [1, 0, 1]);
  const exported = store.exportSignups('idea');
  assert.ok(exported.every((s) => !('unsubToken' in s) && !('confirmToken' in s)));
  assert.deepEqual(exported.map((s) => s.status), ['unsubscribed', 'confirmed']);
});

// ---- signup server with email -----------------------------------------------

const SECRET = 'a-long-shared-secret-123';
const ORIGIN = 'https://me.github.io';

async function withServer(opts, fn) {
  const metrics = new MetricsStore(tmp());
  const mailer = opts.mailer === undefined ? fakeMailer() : opts.mailer;
  const server = createWebhookServer({ publisher: null, secret: SECRET, metrics, allowedOrigins: [ORIGIN], site: SITE, ...opts, mailer });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const signup = (email) => fetch(`${base}/signup`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: ORIGIN }, body: JSON.stringify({ page: 'niche-newsletter', email, consent: true }) });
  try { await fn({ base, signup, metrics, mailer }); } finally { server.close(); }
}

const tokenFrom = (text, kind) => new RegExp(`/${kind}\\?t=([A-Za-z0-9_-]{32})`).exec(text)?.[1];

test('signup sends a confirmation email; GET shows a button, POST confirms and sends the welcome email', async () => {
  await withServer({}, async ({ base, signup, metrics, mailer }) => {
    const res = await signup('ann@example.com');
    assert.match((await res.json()).message, /Check your inbox/);
    assert.equal(mailer.sent.length, 1);
    const confirm = mailer.sent[0];
    assert.equal(confirm.to, 'ann@example.com');
    assert.match(confirm.subject, /confirm.*Niche newsletter/i);
    const t = tokenFrom(confirm.text, 'confirm');
    assert.ok(t);

    // A link scanner opening the URL must not confirm anything.
    const page = await fetch(`${base}/confirm?t=${t}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<form method="post" action="\/confirm\?t=/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(metrics.subscribers('niche-newsletter').length, 0);

    const done = await fetch(`${base}/confirm?t=${t}`, { method: 'POST' });
    assert.match(await done.text(), /You&#39;re confirmed/);
    assert.equal(metrics.subscribers('niche-newsletter').length, 1);
    assert.equal(mailer.sent.length, 2);
    assert.match(mailer.sent[1].subject, /on the list/);
    assert.ok(mailer.sent[1].headers['List-Unsubscribe-Post']);

    // Confirming twice sends no second welcome.
    await fetch(`${base}/confirm?t=${t}`, { method: 'POST' });
    assert.equal(mailer.sent.length, 2);
    assert.equal((await fetch(`${base}/confirm?t=${'x'.repeat(32)}`)).status, 404);
    assert.equal((await fetch(`${base}/confirm?t=short`)).status, 404);
  });
});

test('unsubscribe: GET asks, POST (button or one-click header) unsubscribes', async () => {
  await withServer({ doubleOptIn: false }, async ({ base, signup, metrics, mailer }) => {
    await signup('bob@example.com');
    assert.match(mailer.sent[0].subject, /on the list/, 'single opt-in sends the welcome email right away');
    const t = tokenFrom(mailer.sent[0].text, 'unsubscribe');
    assert.equal(metrics.subscribers('niche-newsletter').length, 1);

    assert.match(await (await fetch(`${base}/unsubscribe?t=${t}`)).text(), /Stop receiving emails/);
    assert.equal(metrics.subscribers('niche-newsletter').length, 1);

    const oneClick = await fetch(`${base}/unsubscribe?t=${t}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(oneClick.status, 200);
    assert.equal(metrics.subscribers('niche-newsletter').length, 0);
    assert.match(await (await fetch(`${base}/unsubscribe?t=${t}`)).text(), /You&#39;re unsubscribed/);
  });
});

test('without an email service, signups are single opt-in and no email is attempted', async () => {
  await withServer({ mailer: null }, async ({ signup, metrics }) => {
    const res = await signup('c@example.com');
    assert.match((await res.json()).message, /on the list/);
    assert.equal(metrics.subscribers('niche-newsletter').length, 1);
  });
});

test('an email failure does not lose the signup', async () => {
  const broken = { send: async () => { throw new Error('Resend down'); } };
  const logs = [];
  await withServer({ mailer: broken, log: (m) => logs.push(m) }, async ({ signup, metrics }) => {
    assert.equal((await signup('d@example.com')).status, 200);
    assert.equal(metrics.exportSignups().length, 1);
    assert.ok(logs.some((l) => /confirmation failed: Resend down/.test(l)));
  });
});

// ---- newsletters --------------------------------------------------------------

function storeWith(dir) {
  const store = new MetricsStore(dir);
  for (let i = 0; i < 150; i++) store.addSignup('niche-newsletter', `fan${i}@example.com`);
  store.addSignup('niche-newsletter', 'pending@example.com', new Date(), { doubleOptIn: true });
  const { signup } = store.addSignup('niche-newsletter', 'gone@example.com');
  store.unsubscribe(signup.unsubToken);
  store.addSignup('other-page', 'other@example.com');
  return store;
}

const NEWSLETTER = 'Subject: Big news\n\nWe built it. **Reply** and tell us what you think.';
const action = { id: 'act-0042', kind: 'send_email', opportunity: 'Niche newsletter', artifact: '/w/run/niche-newsletter/newsletter.md' };

test('a newsletter goes only to confirmed subscribers of that page, in batches of 100 with idempotency keys', async () => {
  const store = storeWith(tmp());
  const mailer = fakeMailer();
  const result = await sendBroadcast({ store, mailer, action, content: NEWSLETTER, site: SITE });
  assert.deepEqual([result.sent, result.recipients, result.page], [150, 150, 'niche-newsletter']);
  assert.deepEqual(mailer.batches.map((b) => [b.msgs.length, b.key]), [[100, 'act-0042-batch-0'], [50, 'act-0042-batch-1']]);
  const to = mailer.batches.flatMap((b) => b.msgs.map((m) => m.to));
  assert.ok(!to.includes('pending@example.com') && !to.includes('gone@example.com') && !to.includes('other@example.com'));
  const first = mailer.batches[0].msgs[0];
  assert.equal(first.subject, 'Big news');
  assert.match(first.html, /<strong>Reply<\/strong>/);
  assert.match(first.text, /signup\.example\.com\/unsubscribe\?t=[A-Za-z0-9_-]{32}/);
  // Every person gets their own unsubscribe link.
  assert.equal(new Set(to.map((_, i) => mailer.batches[Math.floor(i / 100)].msgs[i % 100].headers['List-Unsubscribe'])).size, 150);
});

test('newsletter safety checks', async () => {
  const store = storeWith(tmp());
  await assert.rejects(sendBroadcast({ store, mailer: fakeMailer(), action, content: NEWSLETTER, site: { ...SITE, postalAddress: '' } }), /POSTAL_ADDRESS/);
  await assert.rejects(sendBroadcast({ store, mailer: fakeMailer(), action, content: NEWSLETTER, site: { ...SITE, signupUrl: '' } }), /SIGNUP_URL/);
  await assert.rejects(sendBroadcast({ store, mailer: null, action, content: NEWSLETTER, site: SITE }), /RESEND_API_KEY/);
  await assert.rejects(sendBroadcast({ store, mailer: fakeMailer(), action, content: NEWSLETTER, site: SITE, maxRecipients: 100 }), /exceeds AGENTS_EMAIL_MAX_RECIPIENTS/);
  await assert.rejects(sendBroadcast({ store, mailer: fakeMailer({ failBatches: [1] }), action, content: NEWSLETTER, site: SITE }), /sent 100 of 150/);
  const none = await sendBroadcast({ store: new MetricsStore(tmp()), mailer: fakeMailer(), action, content: NEWSLETTER, site: SITE });
  assert.deepEqual([none.status, none.sent], ['executed', 0]);

  assert.equal(canBroadcast(action), true);
  assert.equal(canBroadcast({ ...action, artifact: '/w/outreach.md' }), false, 'cold outreach is never sent automatically');
  assert.equal(canBroadcast({ ...action, kind: 'publish' }), false);
});

test('webhook server sends approved newsletters it receives', async () => {
  const store = storeWith(tmp());
  const mailer = fakeMailer();
  const r = await handleAction({ action: { ...action, status: 'approved' }, content: NEWSLETTER }, null, SITE, { mailer, metrics: store });
  assert.equal(r.sent, 150);
  const off = await handleAction({ action: { ...action, status: 'approved' }, content: NEWSLETTER }, null, SITE, {});
  assert.equal(off.status, 'ignored');
  assert.equal(humanize('niche-newsletter'), 'Niche newsletter');
});

test('built-in executor sends an approved newsletter from the workspace when subscribers are local', async () => {
  const dir = tmp();
  storeWith(dir);
  const ws = join(dir, 'workspace', 'run-1', 'niche-newsletter');
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'newsletter.md'), NEWSLETTER);
  const q = new ApprovalQueue(dir);
  const a = q.add({ ...action, artifact: join(ws, 'newsletter.md') });
  q.decide([a.id], 'approved');

  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, n: JSON.parse(init.body).length }); return Response.json({ data: [] }); };
  const config = { dataDir: dir, resendApiKey: 're_x', emailFrom: 'Acme <hi@acme.co>', ...SITE, emailMaxRecipients: 1000 };
  const executors = buildExecutors(config, { fetchImpl });
  assert.deepEqual(executors.map((e) => e.name), ['email-broadcast']);
  await q.dispatch({ executors });
  assert.equal(q.get(a.id).status, 'executed');
  assert.deepEqual(calls.map((c) => [c.url, c.n]), [['https://api.resend.com/emails/batch', 100], ['https://api.resend.com/emails/batch', 50]]);

  assert.equal(subscribersAreLocal({ signupUrl: 'https://s.io', webhookSecret: 'x' }), false);
  assert.deepEqual(buildExecutors({ ...config, webhookSecret: 'x'.repeat(20) }).map((e) => e.name), [], 'remote server: newsletters go through the webhook');
});

// ---- configuration -------------------------------------------------------------

test('email configuration checks', () => {
  const base = { AGENTS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'k', AGENTS_MODEL: 'm', TAVILY_API_KEY: 't', AGENTS_SIGNUP_URL: 'https://s.example.com', AGENTS_BUSINESS_NAME: 'Acme', AGENTS_CONTACT_EMAIL: 'a@acme.co', AGENTS_SIGNUP_ALLOWED_ORIGINS: 'https://me.github.io' };
  assert.ok(validateConfig(loadConfig({}, base)).warnings.some((w) => /RESEND_API_KEY is not set/.test(w)));
  assert.ok(validateConfig(loadConfig({}, { ...base, RESEND_API_KEY: 're_x' })).errors.some((e) => /AGENTS_EMAIL_FROM is not/.test(e)));
  assert.ok(validateConfig(loadConfig({}, { ...base, RESEND_API_KEY: 're_x', AGENTS_EMAIL_FROM: 'nonsense' })).errors.some((e) => /doesn't look like/.test(e)));
  const noPostal = validateConfig(loadConfig({}, { ...base, RESEND_API_KEY: 're_x', AGENTS_EMAIL_FROM: 'Acme <hi@acme.co>' }));
  assert.ok(noPostal.warnings.some((w) => /AGENTS_POSTAL_ADDRESS/.test(w)));
  const prodNoPostal = validateConfig(loadConfig({}, { ...base, AGENTS_ENV: 'production', RESEND_API_KEY: 're_x', AGENTS_EMAIL_FROM: 'hi@acme.co' }));
  assert.ok(prodNoPostal.errors.some((e) => /AGENTS_POSTAL_ADDRESS/.test(e)));
  const cfg = loadConfig({}, { ...base, AGENTS_DOUBLE_OPT_IN: '0', AGENTS_EMAIL_MAX_RECIPIENTS: '50' });
  assert.deepEqual([cfg.doubleOptIn, cfg.emailMaxRecipients], [false, 50]);
  assert.equal(loadConfig({}, base).doubleOptIn, true);
});
