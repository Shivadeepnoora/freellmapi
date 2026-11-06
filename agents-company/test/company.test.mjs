import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Company, normaliseOpportunities, scoreOpportunity } from '../src/company.mjs';
import { CompanyMemory } from '../src/memory.mjs';
import { MockLLMClient } from '../src/mock-llm.mjs';
import { LLMClient, extractJSON } from '../src/llm.mjs';
import { DEPARTMENTS } from '../src/agents/roles.mjs';
import { writeReports } from '../src/report.mjs';
import { runPool } from '../src/pool.mjs';
import { parseInterval } from '../src/config.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'agents-company-'));
const config = (o = {}) => ({ focus: 'test focus', opportunities: 3, concurrency: 2, ...o });

test('a run researches, distributes to every department, ranks and decides', async () => {
  const llm = new MockLLMClient();
  const memory = new CompanyMemory(tmp());
  const run = await new Company({ llm, memory, config: config() }).run();

  assert.equal(run.ranked.length, 3);
  for (const r of run.ranked) assert.deepEqual(Object.keys(r.reports).sort(), DEPARTMENTS.map((d) => d.id).sort());
  // 1 research + 3*5 department tasks + 1 CEO
  assert.equal(llm.calls.length, 1 + 3 * DEPARTMENTS.length + 1);
  assert.ok(run.decision.executive_summary);
  for (let i = 1; i < run.ranked.length; i++) assert.ok(run.ranked[i - 1].totalScore >= run.ranked[i].totalScore);
});

test('memory persists and the next run is told to avoid known ideas', async () => {
  const dir = tmp();
  const first = await new Company({ llm: new MockLLMClient(), memory: new CompanyMemory(dir), config: config() }).run();
  const llm = new MockLLMClient();
  const second = await new Company({ llm, memory: new CompanyMemory(dir), config: config() }).run();

  assert.match(llm.calls[0].user, /Already researched/);
  const firstNames = new Set(first.ranked.map((r) => r.name));
  assert.ok(second.ranked.every((r) => !firstNames.has(r.name)));
  assert.equal(new CompanyMemory(dir).state.runs.length, 2);
});

test('a failing department is recorded and does not stop the run', async () => {
  const llm = new MockLLMClient();
  const original = llm.chatJSON.bind(llm);
  llm.chatJSON = async (messages, o) => {
    if (messages[0].content.includes('ROLE: risk_officer')) throw new Error('provider down');
    return original(messages, o);
  };
  const run = await new Company({ llm, memory: new CompanyMemory(tmp()), config: config() }).run();
  assert.ok(run.ranked.every((r) => r.failures.length === 1 && !r.reports.risk_officer));
});

test('scoring averages over all departments and clamps', () => {
  const s = scoreOpportunity({ reports: { a: { score: 10 }, b: { score: 50 }, c: { score: 'x' } }, failures: [] });
  assert.equal(s.totalScore, Math.round((20 / DEPARTMENTS.length) * 10) / 10);
});

test('normaliseOpportunities dedupes, trims and caps', () => {
  const out = normaliseOpportunities({ opportunities: [{ name: ' A ' }, { name: 'a' }, { name: '' }, { name: 'B' }, { name: 'C' }] }, 2);
  assert.deepEqual(out.map((o) => o.name), ['A', 'B']);
  assert.deepEqual(out.map((o) => o.id), ['opp-1', 'opp-2']);
});

test('extractJSON handles fences and surrounding prose', () => {
  assert.deepEqual(extractJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJSON('Sure! {"a":[1,2]} hope that helps'), { a: [1, 2] });
  assert.throws(() => extractJSON('no json here'));
});

test('LLMClient retries 429 then succeeds, and sends the bearer key', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(url, 'http://x/v1/chat/completions');
    assert.equal(init.headers.authorization, 'Bearer k');
    if (calls < 3) return new Response('rate limited', { status: 429 });
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  };
  const llm = new LLMClient({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'auto', retries: 3, fetchImpl, sleep: async () => {} });
  assert.deepEqual(await llm.chatJSON([{ role: 'user', content: 'hi' }]), { ok: true });
  assert.equal(calls, 3);
});

test('LLMClient does not retry a 400', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('bad', { status: 400 }); };
  const llm = new LLMClient({ baseUrl: 'http://x', model: 'auto', retries: 3, fetchImpl, sleep: async () => {} });
  await assert.rejects(llm.chat([]), /HTTP 400/);
  assert.equal(calls, 1);
});

test('runPool respects the concurrency limit and keeps order', async () => {
  let active = 0, peak = 0;
  const out = await runPool([1, 2, 3, 4, 5], 2, async (n) => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    if (n === 3) throw new Error('boom');
    return n * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(out.map((r) => r.value ?? r.error.message), [2, 4, 'boom', 8, 10]);
});

test('reports are written as JSON and Markdown', async () => {
  const dir = tmp();
  const run = await new Company({ llm: new MockLLMClient(), memory: new CompanyMemory(dir), config: config() }).run();
  const { json, md } = writeReports(run, dir);
  assert.ok(existsSync(json) && existsSync(join(dir, 'reports', 'latest.md')));
  assert.match(readFileSync(md, 'utf8'), /## CEO decision/);
});

test('parseInterval', () => {
  assert.equal(parseInterval('30m'), 1_800_000);
  assert.equal(parseInterval('1d'), 86_400_000);
  assert.throws(() => parseInterval('soon'));
});
