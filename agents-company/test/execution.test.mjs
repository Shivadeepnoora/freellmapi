import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Company } from '../src/company.mjs';
import { CompanyMemory } from '../src/memory.mjs';
import { ApprovalQueue } from '../src/approvals.mjs';
import { MockLLMClient } from '../src/mock-llm.mjs';
import { normaliseTasks, slugify, stripFences } from '../src/execution.mjs';
import { FILE_AGENTS } from '../src/agents/action-roles.mjs';
import { toMarkdown } from '../src/report.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'agents-exec-'));
const config = (dataDir, o = {}) => ({ focus: 'f', opportunities: 3, concurrency: 2, act: true, executeTop: 2, dataDir, ...o });

async function runCompany(dir, o, llm = new MockLLMClient()) {
  const approvals = new ApprovalQueue(dir);
  const run = await new Company({ llm, memory: new CompanyMemory(dir), approvals, config: config(dir, o) }).run();
  return { run, approvals, llm };
}

test('top opportunities get deliverables, a plan, and external actions queued', async () => {
  const dir = tmp();
  const { run, approvals } = await runCompany(dir);

  assert.equal(run.execution.length, 2);
  for (const e of run.execution) {
    for (const a of FILE_AGENTS) assert.ok(existsSync(join(e.workspace, a.file)), `${a.file} missing`);
    assert.ok(existsSync(join(e.workspace, 'plan.json')));
    assert.equal(e.failures.length, 0);
  }
  // Code fences from the model are stripped before writing.
  const html = readFileSync(join(run.execution[0].workspace, 'landing-page.html'), 'utf8');
  assert.match(html, /^<!doctype html>/);

  // The mock plan has 1 internal + 3 external-ish tasks per opportunity.
  const pending = approvals.list('pending');
  assert.equal(pending.length, 6);
  assert.ok(pending.every((p) => p.kind !== 'internal'));
  assert.match(toMarkdown(run), /## Actions taken/);
});

test('--no-act skips execution entirely', async () => {
  const { run, approvals, llm } = await runCompany(tmp(), { act: false });
  assert.deepEqual(run.execution, []);
  assert.equal(approvals.list().length, 0);
  assert.ok(!llm.calls.some((c) => c.system.includes('ROLE: product_builder')));
});

test('a failing action agent is recorded and the rest still run', async () => {
  const llm = new MockLLMClient();
  const original = llm.chat.bind(llm);
  llm.chat = async (messages, o) => {
    if (messages[0].content.includes('ROLE: sales_rep')) throw new Error('model timeout');
    return original(messages, o);
  };
  const { run } = await runCompany(tmp(), { executeTop: 1 }, llm);
  const [e] = run.execution;
  assert.deepEqual(e.failures, [{ agent: 'sales_rep', error: 'model timeout' }]);
  assert.equal(e.deliverables.length, FILE_AGENTS.length - 1);
  assert.ok(e.tasks.length > 0);
});

test('normaliseTasks fails safe: money or unknown external kinds need approval', () => {
  const tasks = normaliseTasks({ tasks: [
    { title: 'Write draft', type: 'internal', kind: 'internal' },
    { title: 'Buy ads', type: 'internal', kind: 'internal', cost_usd: 50 },
    { title: 'Send emails', type: 'internal', kind: 'send_email' },
    { title: 'Mystery', type: 'external', kind: 'teleport' },
    { title: '' },
  ] });
  assert.deepEqual(tasks.map((t) => [t.title, t.type, t.kind]), [
    ['Write draft', 'internal', 'internal'],
    ['Buy ads', 'external', 'spend_money'],
    ['Send emails', 'external', 'send_email'],
    ['Mystery', 'external', 'other_external'],
  ]);
});

test('approval queue: approve, reject, and guard against double decisions', () => {
  const q = new ApprovalQueue(tmp());
  const a = q.add({ title: 'A', kind: 'publish' });
  const b = q.add({ title: 'B', kind: 'post_social' });
  q.add({ title: 'C', kind: 'send_email' });
  q.decide([a.id], 'approved', 'looks good');
  q.decide([b.id], 'rejected');
  assert.throws(() => q.decide([a.id], 'rejected'), /already approved/);
  assert.throws(() => q.decide(['act-9999'], 'approved'), /No action/);
  assert.equal(q.decide(['all'], 'approved').length, 1);
  assert.equal(new ApprovalQueue(q.file.replace(/approvals\.json$/, '')).list('approved').length, 2);
});

test('dispatch only sends approved items, and handles webhook errors', async () => {
  const q = new ApprovalQueue(tmp());
  const ok = q.add({ title: 'ok', kind: 'publish' });
  const bad = q.add({ title: 'bad', kind: 'publish' });
  const pending = q.add({ title: 'pending', kind: 'publish' });
  q.decide([ok.id, bad.id], 'approved');

  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.action.id);
    assert.equal(init.headers['x-agents-secret'], 's3cret');
    return new Response('', { status: body.action.id === bad.id ? 500 : 200 });
  };
  await q.dispatch({ webhookUrl: 'http://hook', webhookSecret: 's3cret', fetchImpl });

  assert.deepEqual(sent, [ok.id, bad.id]);
  assert.equal(q.get(ok.id).status, 'executed');
  assert.equal(q.get(bad.id).status, 'failed');
  assert.equal(q.get(pending.id).status, 'pending');
});

test('dispatch without a webhook marks approved items for manual action', async () => {
  const q = new ApprovalQueue(tmp());
  const a = q.add({ title: 'x', kind: 'publish' });
  q.decide([a.id], 'approved');
  await q.dispatch({ webhookUrl: '', fetchImpl: () => assert.fail('must not call fetch') });
  assert.equal(q.get(a.id).status, 'manual');
});

test('the CEO sees the status of earlier actions on the next run', async () => {
  const dir = tmp();
  const first = await runCompany(dir);
  first.approvals.decide(['act-0001'], 'approved');
  const { llm } = await runCompany(dir);
  const ceoCall = llm.calls.find((c) => c.system.includes('ROLE: ceo'));
  assert.match(ceoCall.user, /"id":"act-0001","status":"approved"/);
});

test('slugify and stripFences', () => {
  assert.equal(slugify('Micro-SaaS for Small Agencies!'), 'micro-saas-for-small-agencies');
  assert.equal(slugify('../../etc'), 'etc');
  assert.equal(stripFences('```js\nconsole.log(1)\n```'), 'console.log(1)\n');
  assert.equal(stripFences('plain'), 'plain\n');
});
