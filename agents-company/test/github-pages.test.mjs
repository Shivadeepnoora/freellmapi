import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubPagesPublisher } from '../src/executors/github-pages.mjs';
import { createWebhookServer, handleAction } from '../src/executors/webhook-server.mjs';
import { buildExecutors } from '../src/executors/index.mjs';
import { ApprovalQueue } from '../src/approvals.mjs';

// In-memory stand-in for the parts of the GitHub REST API the publisher uses.
function fakeGitHub({ branches = ['main'], pages = null, empty = false, failPages = false } = {}) {
  const state = { branches: new Set(branches), pages, files: new Map(), requests: [] };
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    state.requests.push({ method, pathname, body, auth: init.headers?.authorization });
    const rest = pathname.replace(/^\/repos\/alice\/site/, '');
    if (rest === pathname) return json(404, { message: 'Not Found' });

    if (method === 'GET' && rest === '') return json(200, { default_branch: 'main' });
    let m;
    if (method === 'GET' && (m = /^\/branches\/(.+)$/.exec(rest))) return state.branches.has(m[1]) ? json(200, { name: m[1] }) : json(404, {});
    if (method === 'GET' && (m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      if (empty) return json(409, { message: 'Git Repository is empty.' });
      return json(200, { object: { sha: 'base-sha' } });
    }
    if (method === 'POST' && rest === '/git/refs') { state.branches.add(body.ref.replace('refs/heads/', '')); return json(201, {}); }
    if (method === 'GET' && rest === '/pages') return state.pages ? json(200, state.pages) : json(404, {});
    if (method === 'POST' && rest === '/pages') {
      if (failPages) return json(403, { message: 'Resource not accessible by personal access token' });
      state.pages = { source: body.source };
      return json(201, state.pages);
    }
    if ((m = /^\/contents\/(.+)$/.exec(rest))) {
      const key = `${searchParams.get('ref') ?? body?.branch}:${m[1]}`;
      if (method === 'GET') return state.files.has(key) ? json(200, { sha: state.files.get(key).sha }) : json(404, {});
      if (method === 'PUT') {
        const prev = state.files.get(key);
        if (prev && body.sha !== prev.sha) return json(409, { message: 'sha mismatch' });
        if (!prev && body.sha) return json(422, { message: 'sha given for new file' });
        const sha = `sha-${state.requests.length}`;
        state.files.set(key, { sha, content: Buffer.from(body.content, 'base64').toString('utf8'), message: body.message });
        return json(prev ? 200 : 201, { commit: { sha: `commit-${sha}` } });
      }
    }
    return json(404, { message: `unhandled ${method} ${rest}` });
  };
  return { state, fetchImpl };
}

const publisher = (gh, o = {}) => new GitHubPagesPublisher({ repo: 'alice/site', token: 'tok', fetchImpl: gh.fetchImpl, ...o });

test('first publish creates the branch, enables Pages, commits the page', async () => {
  const gh = fakeGitHub();
  const result = await publisher(gh).publish({ path: 'my-idea/index.html', content: '<h1>Hi</h1>', message: 'Publish' });

  assert.ok(gh.state.branches.has('gh-pages'));
  assert.deepEqual(gh.state.pages.source, { branch: 'gh-pages', path: '/' });
  assert.equal(gh.state.files.get('gh-pages:my-idea/index.html').content, '<h1>Hi</h1>');
  assert.equal(result.url, 'https://alice.github.io/site/my-idea/');
  assert.equal(result.updated, false);
  assert.ok(gh.state.requests.every((r) => r.auth === 'Bearer tok'));
});

test('republishing updates the existing file with its sha, and setup runs once', async () => {
  const gh = fakeGitHub({ branches: ['main', 'gh-pages'], pages: { source: { branch: 'gh-pages' } } });
  const p = publisher(gh);
  await p.publish({ path: 'a/index.html', content: 'v1' });
  const second = await p.publish({ path: 'a/index.html', content: 'v2' });
  assert.equal(second.updated, true);
  assert.equal(gh.state.files.get('gh-pages:a/index.html').content, 'v2');
  assert.equal(gh.state.requests.filter((r) => r.pathname.endsWith('/pages')).length, 1);
  assert.ok(!gh.state.requests.some((r) => r.method === 'POST'));
});

test('if Pages cannot be enabled, the commit still lands and a warning is logged', async () => {
  const gh = fakeGitHub({ failPages: true });
  const logs = [];
  const result = await publisher(gh, { log: (m) => logs.push(m) }).publish({ path: 'x/index.html', content: 'ok' });
  assert.ok(result.url);
  assert.ok(logs.some((l) => /could not enable Pages/.test(l)));
});

test('an empty repository gives a clear error', async () => {
  const gh = fakeGitHub({ empty: true });
  await assert.rejects(publisher(gh).publish({ path: 'x/index.html', content: 'ok' }), /no commits yet/);
});

test('user/org sites use the root URL', () => {
  const p = new GitHubPagesPublisher({ repo: 'Alice/alice.github.io', token: 't', fetchImpl: async () => {} });
  assert.equal(p.pagesUrl('idea/index.html'), 'https://alice.github.io/idea/');
});

test('the publisher validates its inputs', async () => {
  assert.throws(() => new GitHubPagesPublisher({ repo: 'not a repo', token: 't' }), /owner\/name/);
  assert.throws(() => new GitHubPagesPublisher({ repo: 'a/b', token: '' }), /token/);
  const p = publisher(fakeGitHub());
  await assert.rejects(p.publish({ path: '../evil/index.html', content: 'x' }), /unexpected path/);
  await assert.rejects(p.publish({ path: 'ok/index.html', content: '  ' }), /empty/);
  await assert.rejects(p.publish({ path: 'ok/index.html', content: 'x'.repeat(1_000_001) }), /1 MB/);
});

function queueWithPage(html = '<h1>Launch</h1>') {
  const dir = mkdtempSync(join(tmpdir(), 'agents-pages-'));
  const ws = join(dir, 'workspace', 'run-1', 'niche-newsletter');
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'landing-page.html'), html);
  const q = new ApprovalQueue(dir);
  const publish = q.add({ opportunity: 'Niche Newsletter', kind: 'publish', title: 'Publish landing page', artifact: join(ws, 'landing-page.html') });
  const post = q.add({ opportunity: 'Niche Newsletter', kind: 'post_social', title: 'Post thread', artifact: null });
  return { dir, q, publish, post };
}

test('execute: approved landing pages go to GitHub Pages, other actions to the webhook', async () => {
  const gh = fakeGitHub();
  const { q, publish, post } = queueWithPage();
  q.decide(['all'], 'approved');
  const executors = buildExecutors({ githubPagesRepo: 'alice/site', githubToken: 'tok', githubPagesBranch: 'gh-pages', githubApiUrl: 'https://api.github.com' }, { fetchImpl: gh.fetchImpl });

  const webhookCalls = [];
  const webhookFetch = async (url, init) => { webhookCalls.push(JSON.parse(init.body)); return Response.json({ status: 'ignored', reason: 'no executor' }); };
  await q.dispatch({ webhookUrl: 'http://hook', executors, fetchImpl: webhookFetch });

  assert.equal(q.get(publish.id).status, 'executed');
  assert.equal(q.get(publish.id).resultUrl, 'https://alice.github.io/site/niche-newsletter/');
  assert.equal(gh.state.files.get('gh-pages:niche-newsletter/index.html').content, '<h1>Launch</h1>');
  assert.deepEqual(webhookCalls.map((c) => c.action.id), [post.id]);
  assert.equal(q.get(post.id).status, 'manual');
});

test('execute refuses artifacts outside the workspace', async () => {
  const { q } = queueWithPage();
  const evil = q.add({ opportunity: 'x', kind: 'publish', title: 'steal', artifact: '/etc/passwd.html' });
  q.decide([evil.id], 'approved');
  const executors = buildExecutors({ githubPagesRepo: 'alice/site', githubToken: 'tok', githubPagesBranch: 'gh-pages', githubApiUrl: 'https://api.github.com' }, { fetchImpl: fakeGitHub().fetchImpl });
  await q.dispatch({ executors });
  assert.equal(q.get(evil.id).status, 'failed');
  assert.match(q.get(evil.id).error, /outside the workspace/);
});

test('handleAction only publishes approved publish actions with content', async () => {
  const p = publisher(fakeGitHub());
  const base = { id: 'act-1', kind: 'publish', status: 'approved', artifact: '/w/landing-page.html', opportunity: 'Idea' };
  assert.equal((await handleAction({ action: { ...base, status: 'pending' }, content: 'x' }, p)).status, 'ignored');
  assert.equal((await handleAction({ action: { ...base, kind: 'send_email' }, content: 'x' }, p)).status, 'ignored');
  assert.equal((await handleAction({ action: base }, p)).status, 'ignored');
  assert.equal((await handleAction({ action: base, content: 'x' }, null)).status, 'ignored');
  const ok = await handleAction({ action: base, content: '<p>hi</p>' }, p);
  assert.deepEqual([ok.status, ok.url], ['executed', 'https://alice.github.io/site/idea/']);
});

test('webhook server end to end: secret check, publish, then the queue records the URL', async () => {
  const gh = fakeGitHub();
  const secret = 'a-long-shared-secret-123';
  const server = createWebhookServer({ publisher: publisher(gh), secret });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const bad = await fetch(url, { method: 'POST', headers: { 'x-agents-secret': 'wrong' }, body: '{}' });
    assert.equal(bad.status, 401);
    const health = await (await fetch(`${url}healthz`)).json();
    assert.deepEqual(health, { ok: true, githubPages: true });

    const { q, publish } = queueWithPage('<h1>Via webhook</h1>');
    q.decide([publish.id], 'approved');
    await q.dispatch({ webhookUrl: url, webhookSecret: secret });
    assert.equal(q.get(publish.id).status, 'executed');
    assert.equal(q.get(publish.id).resultUrl, 'https://alice.github.io/site/niche-newsletter/');
    assert.equal(gh.state.files.get('gh-pages:niche-newsletter/index.html').content, '<h1>Via webhook</h1>');
  } finally {
    server.close();
  }
});

test('webhook server refuses to start with a weak secret', () => {
  assert.throws(() => createWebhookServer({ publisher: null, secret: 'short' }), /at least 16/);
});
