import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectSignup, stripScripts, privacyPage, validateSignupUrl } from '../src/site/signup.mjs';
import { MetricsStore, RemoteMetrics, metricsFromConfig } from '../src/feedback/metrics.mjs';
import { evaluateTraction, collectResults, resultsForPrompt } from '../src/feedback/traction.mjs';
import { createWebhookServer, publishLandingPage } from '../src/executors/webhook-server.mjs';
import { ApprovalQueue } from '../src/approvals.mjs';
import { CompanyMemory, combinedScore } from '../src/memory.mjs';
import { Company } from '../src/company.mjs';
import { MockLLMClient } from '../src/mock-llm.mjs';
import { loadConfig, validateConfig, signupOrigins } from '../src/config.mjs';
import { toMarkdown } from '../src/report.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'agents-feedback-'));

// ---- page preparation ----------------------------------------------------

test('injectSignup strips model-written scripts and adds exactly one signup script', () => {
  const html = '<html><body><a href="javascript:steal()">x</a><script>evil()</script><script src="https://x.io/t.js"></script><form data-signup><input type="email" name="email"></form></body></html>';
  const out = injectSignup(html, { endpoint: 'https://signup.example.com/', page: 'my-idea' });
  assert.ok(!out.includes('evil()'));
  assert.ok(!out.includes('x.io/t.js'));
  assert.ok(!out.includes('javascript:'));
  assert.equal(out.match(/<script/g).length, 1);
  assert.match(out, /var E="https:\/\/signup\.example\.com",P="my-idea"/);
  assert.match(out, /<\/script>\n<\/body><\/html>$/);
  // Without a closing body tag the script is appended.
  assert.match(injectSignup('<p>hi</p>', { endpoint: 'https://s.io', page: 'p' }), /<p>hi<\/p>\n<script data-agents-company>/);
});

test('injectSignup validates the endpoint and page id', () => {
  assert.throws(() => injectSignup('<p>', { endpoint: 'http://insecure.example.com', page: 'p' }), /https/);
  assert.doesNotThrow(() => validateSignupUrl('http://localhost:8787'));
  assert.throws(() => injectSignup('<p>', { endpoint: 'https://s.io', page: '../x' }), /Invalid page/);
  assert.equal(stripScripts('<SCRIPT type="x">a</SCRIPT >ok'), 'ok');
});

test('privacyPage escapes operator-provided text', () => {
  const html = privacyPage({ businessName: '<b>Acme</b>', contactEmail: 'a@b.co', opportunity: 'X & Y' });
  assert.match(html, /&lt;b&gt;Acme&lt;\/b&gt;/);
  assert.match(html, /mailto:a@b\.co/);
  assert.match(html, /X &amp; Y/);
});

// ---- metrics store -------------------------------------------------------

test('MetricsStore counts views per day, dedupes signups, keeps emails out of stats, and erases on request', async () => {
  const dir = tmp();
  const m = new MetricsStore(dir);
  m.recordView('idea', new Date('2026-11-01T10:00:00Z'));
  m.recordView('idea', new Date('2026-11-01T11:00:00Z'));
  m.recordView('idea', new Date('2026-11-02T10:00:00Z'));
  const first = m.addSignup('idea', ' Ann@Example.com ');
  assert.equal(first.added, true);
  assert.equal(first.signup.email, 'ann@example.com');
  assert.deepEqual(m.addSignup('idea', 'ann@example.com'), { added: false, reason: 'duplicate' });
  assert.deepEqual(m.addSignup('idea', 'not-an-email'), { added: false, reason: 'invalid email' });
  m.addSignup('idea', 'bob@example.com');
  assert.throws(() => m.recordView('../bad'), /invalid page/);

  const stats = await new MetricsStore(dir).stats();
  assert.equal(stats.idea.views, 3);
  assert.deepEqual(stats.idea.viewsByDay, { '2026-11-01': 2, '2026-11-02': 1 });
  assert.equal(stats.idea.signups, 2);
  assert.ok(!JSON.stringify(stats).includes('@'));
  assert.ok(!readFileSync(join(dir, 'metrics.json'), 'utf8').includes('@'));

  assert.equal(m.deleteEmail('ANN@example.com'), 1);
  assert.equal((await m.stats()).idea.signups, 1);
  assert.deepEqual(m.exportSignups().map((s) => s.email), ['bob@example.com']);
});

test('metricsFromConfig picks remote when a signup URL and secret are set, and RemoteMetrics sends the secret', async () => {
  const dir = tmp();
  assert.ok(metricsFromConfig({ dataDir: dir }) instanceof MetricsStore);
  assert.ok(metricsFromConfig({ dataDir: dir, signupUrl: 'https://s.io', webhookSecret: 'x', metricsSource: 'local' }) instanceof MetricsStore);
  let seen;
  const remote = metricsFromConfig({ dataDir: dir, signupUrl: 'https://s.io/', webhookSecret: 'sek' }, {
    fetchImpl: async (url, init) => { seen = [url, init.headers['x-agents-secret']]; return Response.json({ pages: { p: { views: 5, signups: 1 } } }); },
  });
  assert.ok(remote instanceof RemoteMetrics);
  assert.deepEqual(await remote.stats(), { p: { views: 5, signups: 1 } });
  assert.deepEqual(seen, ['https://s.io/stats', 'sek']);
});

// ---- traction scoring ----------------------------------------------------

test('evaluateTraction thresholds', () => {
  const opts = { minViews: 100, targetConversion: 0.05 };
  assert.equal(evaluateTraction({ views: 99, signups: 50 }, opts).verdict, 'collecting data');
  assert.equal(evaluateTraction({ views: 99, signups: 50 }, opts).tractionScore, null);
  assert.deepEqual(pick(evaluateTraction({ views: 200, signups: 10 }, opts)), [0.05, 10, 'scale']);
  assert.deepEqual(pick(evaluateTraction({ views: 200, signups: 8 }, opts)), [0.04, 8, 'scale']);
  assert.deepEqual(pick(evaluateTraction({ views: 200, signups: 4 }, opts)), [0.02, 4, 'iterate']);
  assert.deepEqual(pick(evaluateTraction({ views: 500, signups: 2 }, opts)), [0.004, 0.8, 'kill']);
  assert.equal(evaluateTraction({ views: 100, signups: 100 }, opts).tractionScore, 10);
});
const pick = (r) => [r.conversion, r.tractionScore, r.verdict];

function launchedQueue(dir, pages) {
  const q = new ApprovalQueue(dir);
  for (const [page, opportunity, executedAt] of pages) {
    const a = q.add({ kind: 'publish', title: 'Publish', opportunity });
    Object.assign(a, { status: 'executed', page, resultUrl: `https://me.github.io/site/${page}/`, executedAt });
  }
  q.add({ kind: 'post_social', title: 'not a page', opportunity: 'x' }).status = 'executed';
  q.save();
  return q;
}

test('collectResults matches launched pages with counts, using the latest publish', async () => {
  const dir = tmp();
  const q = launchedQueue(dir, [
    ['newsletter', 'Newsletter', '2026-11-01T00:00:00Z'],
    ['newsletter', 'Newsletter', '2026-11-03T00:00:00Z'],
    ['saas', 'SaaS', '2026-11-02T00:00:00Z'],
  ]);
  const metrics = { stats: async () => ({ newsletter: { views: 300, signups: 30 }, saas: { views: 40, signups: 1 } }) };
  const results = await collectResults({ approvals: q, metrics, config: { minViews: 100, targetConversion: 0.05 }, now: new Date('2026-11-06T00:00:00Z') });
  assert.deepEqual(results.map((r) => [r.page, r.verdict, r.daysLive]), [['newsletter', 'scale', 3], ['saas', 'collecting data', 4]]);
  assert.match(resultsForPrompt(results), /Newsletter: 300 views, 30 signups \(10\.0%\), 3 days live → scale/);

  const broken = { stats: async () => { throw new Error('server down'); } };
  assert.deepEqual(await collectResults({ approvals: q, metrics: broken, config: {} }), []);
  assert.match(resultsForPrompt([]), /No landing pages are live yet/);
});

// ---- feedback inside a run ----------------------------------------------

test('a run reads live results, tells the Research Director and CEO, stores them, and reports them', async () => {
  const dir = tmp();
  const approvals = launchedQueue(dir, [['winner', 'Winner idea', '2026-11-01T00:00:00Z'], ['loser', 'Loser idea', '2026-11-01T00:00:00Z']]);
  const metrics = { stats: async () => ({ winner: { views: 400, signups: 40 }, loser: { views: 400, signups: 1 } }) };
  const memory = new CompanyMemory(dir);
  memory.state.opportunities['winner idea'] = { name: 'Winner idea', category: 'content', lastScore: 5, timesSeen: 1 };
  memory.state.opportunities['loser idea'] = { name: 'Loser idea', category: 'software', lastScore: 9, timesSeen: 1 };
  const llm = new MockLLMClient();
  const run = await new Company({ llm, memory, approvals, metrics, config: { focus: 'f', opportunities: 2, concurrency: 2, minViews: 100, targetConversion: 0.05 } }).run();

  assert.deepEqual(run.results.map((r) => [r.opportunity, r.verdict]), [['Winner idea', 'scale'], ['Loser idea', 'kill']]);
  for (const role of ['research_director', 'ceo']) {
    const call = llm.calls.find((c) => c.system.includes(`ROLE: ${role}`));
    assert.match(call.user, /Winner idea: 400 views, 40 signups \(10\.0%\).*→ scale/);
    assert.match(call.user, /Loser idea: 400 views, 1 signups.*→ kill/);
  }
  // Market results flip the long-term ranking: the "9/10 on paper" idea that nobody wanted drops.
  const top = new CompanyMemory(dir).topOpportunities(10);
  const order = top.map((o) => o.name).filter((n) => /Winner|Loser/.test(n));
  assert.deepEqual(order, ['Winner idea', 'Loser idea']);
  assert.equal(top.find((o) => o.name === 'Winner idea').combinedScore, 7.5);
  assert.equal(top.find((o) => o.name === 'Winner idea').traction.verdict, 'scale');
  assert.ok(!('tractionHistory' in top[0]));
  const md = toMarkdown(run);
  assert.match(md, /## Live results/);
  assert.match(md, /\| Winner idea \| \[winner\]\(https:\/\/me\.github\.io\/site\/winner\/\) \| \d+ \| 400 \| 40 \| 10\.0% \| 10 \| 🟢 scale \|/);
});

test('recordRun keeps traction recorded earlier', () => {
  const memory = new CompanyMemory(tmp());
  memory.recordResults([{ opportunity: 'Idea', views: 200, signups: 10, conversion: 0.05, tractionScore: 10, verdict: 'scale', url: 'u' }]);
  memory.recordRun({ id: 'r', focus: 'f', finishedAt: 'now', ranked: [{ name: 'Idea', category: 'c', totalScore: 6 }], execution: [] });
  const o = memory.state.opportunities.idea;
  assert.equal(o.traction.verdict, 'scale');
  assert.equal(o.lastScore, 6);
  assert.equal(combinedScore(o), 8);
  assert.equal(combinedScore({ lastScore: 6 }), 6);
});

// ---- signup server -------------------------------------------------------

const SECRET = 'a-long-shared-secret-123';
const ORIGIN = 'https://me.github.io';

async function withServer(opts, fn) {
  const metrics = opts.metrics === undefined ? new MetricsStore(tmp()) : opts.metrics;
  const server = createWebhookServer({ publisher: null, secret: SECRET, metrics, allowedOrigins: [ORIGIN], ...opts, metrics });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, origin = ORIGIN) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'text/plain', ...(origin ? { origin } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try { await fn({ base, post, metrics }); } finally { server.close(); }
}

test('signup endpoint: origin, consent, honeypot, email validation, CORS', async () => {
  await withServer({}, async ({ post, metrics }) => {
    const ok = await post('/signup', { page: 'idea', email: 'ann@example.com', consent: true, website: '' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);

    assert.equal((await post('/signup', { page: 'idea', email: 'x@y.co', consent: true }, 'https://evil.example')).status, 403);
    assert.equal((await post('/signup', { page: 'idea', email: 'x@y.co', consent: true }, null)).status, 403);
    const noConsent = await post('/signup', { page: 'idea', email: 'x@y.co', consent: false });
    assert.equal(noConsent.status, 400);
    assert.match((await noConsent.json()).error, /consent/);
    assert.equal((await post('/signup', { page: 'idea', email: 'nope', consent: true })).status, 400);
    assert.equal((await post('/signup', { page: '../etc', email: 'x@y.co', consent: true })).status, 400);
    assert.equal((await post('/signup', 'not json')).status, 400);
    assert.equal((await post('/signup', { page: 'idea', email: 'bot@spam.co', consent: true, website: 'http://spam' })).status, 200);
    assert.equal((await post('/signup', { page: 'idea', email: 'ann@example.com', consent: true })).status, 200); // duplicate

    assert.deepEqual(metrics.exportSignups().map((s) => s.email), ['ann@example.com']);
  });
});

test('event endpoint counts views; stats needs the secret; preflight is answered for allowed origins', async () => {
  await withServer({}, async ({ base, post }) => {
    await post('/event', { page: 'idea', type: 'view' });
    await post('/event', { page: 'idea', type: 'view' });
    await post('/event', { page: 'idea', type: 'click' });
    assert.equal((await fetch(`${base}/stats`)).status, 401);
    const stats = await (await fetch(`${base}/stats`, { headers: { 'x-agents-secret': SECRET } })).json();
    assert.equal(stats.pages.idea.views, 2);

    const pre = await fetch(`${base}/signup`, { method: 'OPTIONS', headers: { origin: ORIGIN } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal((await fetch(`${base}/signup`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/signup`)).status, 405);
  });
});

test('signup endpoint is rate limited per client', async () => {
  await withServer({ rateLimit: { windowMs: 60_000, signups: 2, events: 100 } }, async ({ post }) => {
    const send = (n) => post('/signup', { page: 'idea', email: `u${n}@example.com`, consent: true });
    assert.equal((await send(1)).status, 200);
    assert.equal((await send(2)).status, 200);
    assert.equal((await send(3)).status, 429);
  });
});

test('signup endpoints answer 503 when the server has no metrics store', async () => {
  await withServer({ metrics: null }, async ({ post }) => {
    assert.equal((await post('/signup', { page: 'idea', email: 'a@b.co', consent: true })).status, 503);
  });
});

test('publishLandingPage publishes a privacy page and a signup-wired index, and returns the page id', async () => {
  const published = [];
  const publisher = { publish: async ({ path, content }) => { published.push({ path, content }); return { url: `https://me.github.io/site/${path.replace('index.html', '')}`, commitSha: 'c' }; } };
  const site = { signupUrl: 'https://signup.example.com', businessName: 'Acme', contactEmail: 'hi@acme.co' };
  const result = await publishLandingPage(publisher, { id: 'act-1', opportunity: 'My Idea' }, '<body><form data-signup><input type="email" name="email"></form><script>x()</script></body>', site);
  assert.deepEqual(published.map((p) => p.path), ['my-idea/privacy.html', 'my-idea/index.html']);
  assert.match(published[0].content, /Acme/);
  assert.match(published[1].content, /signup\.example\.com/);
  assert.ok(!published[1].content.includes('x()'));
  assert.deepEqual([result.page, result.signupCapture, result.url], ['my-idea', true, 'https://me.github.io/site/my-idea/']);

  const plain = await publishLandingPage(publisher, { id: 'act-2', opportunity: 'Other' }, '<p>hi</p>', {});
  assert.equal(plain.signupCapture, false);
  assert.equal(published.at(-1).content, '<p>hi</p>');
});

test('dispatch records the page id so results can be matched later', async () => {
  const dir = tmp();
  const ws = join(dir, 'workspace', 'r', 'idea');
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'landing-page.html'), '<p>x</p>');
  const q = new ApprovalQueue(dir);
  const a = q.add({ kind: 'publish', title: 'Publish', opportunity: 'Idea', artifact: join(ws, 'landing-page.html') });
  q.decide([a.id], 'approved');
  const executor = { canHandle: () => true, execute: async () => ({ executor: 'github-pages', url: 'https://u/', page: 'idea', signupCapture: true }) };
  await q.dispatch({ executors: [executor] });
  assert.deepEqual([q.get(a.id).page, q.get(a.id).signupCapture, q.get(a.id).resultUrl], ['idea', true, 'https://u/']);
});

// ---- configuration -------------------------------------------------------

test('signup configuration checks', () => {
  const base = { AGENTS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'k', AGENTS_MODEL: 'm', TAVILY_API_KEY: 't', AGENTS_GITHUB_PAGES_REPO: 'Me/site' };
  const noSignup = validateConfig(loadConfig({}, base));
  assert.ok(noSignup.warnings.some((w) => /AGENTS_SIGNUP_URL is not set/.test(w)));
  const prodNoSignup = validateConfig(loadConfig({}, { ...base, AGENTS_ENV: 'production' }));
  assert.ok(prodNoSignup.errors.some((e) => /AGENTS_SIGNUP_URL is not set/.test(e)));
  const insecure = validateConfig(loadConfig({}, { ...base, AGENTS_SIGNUP_URL: 'http://signup.example.com' }));
  assert.ok(insecure.errors.some((e) => /https/.test(e)));
  const noContact = validateConfig(loadConfig({}, { ...base, AGENTS_ENV: 'production', AGENTS_SIGNUP_URL: 'https://s.example.com' }));
  assert.ok(noContact.errors.some((e) => /AGENTS_CONTACT_EMAIL/.test(e)));
  const good = validateConfig(loadConfig({}, { ...base, AGENTS_ENV: 'production', AGENTS_SIGNUP_URL: 'https://s.example.com', AGENTS_BUSINESS_NAME: 'Acme', AGENTS_CONTACT_EMAIL: 'a@acme.co', RESEND_API_KEY: 're_x', AGENTS_EMAIL_FROM: 'Acme <hi@acme.co>', AGENTS_POSTAL_ADDRESS: '1 Main St, Springfield' }));
  assert.deepEqual([good.errors, good.warnings], [[], []]);

  assert.deepEqual(signupOrigins(loadConfig({}, base)), ['https://me.github.io']);
  assert.deepEqual(signupOrigins(loadConfig({}, { ...base, AGENTS_SIGNUP_ALLOWED_ORIGINS: 'https://a.com, https://b.com' })), ['https://a.com', 'https://b.com']);
});
