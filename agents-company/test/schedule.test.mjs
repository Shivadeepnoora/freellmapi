import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler, isDue } from '../src/scheduler.mjs';
import { createStudioJob, pendingReviews } from '../src/studio/schedule.mjs';
import { StudioMemory } from '../src/studio/memory.mjs';
import { ApprovalQueue } from '../src/approvals.mjs';
import { loadConfig, daemonPlan } from '../src/config.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'agents-sched-'));
const H = 36e5;

test('isDue', () => {
  assert.equal(isDue(null, H, 0), true);
  assert.equal(isDue('2026-11-06T00:00:00Z', H, Date.parse('2026-11-06T00:59:00Z')), false);
  assert.equal(isDue('2026-11-06T00:00:00Z', H, Date.parse('2026-11-06T01:00:00Z')), true);
  assert.equal(isDue('garbage', H, 0), true);
});

test('Scheduler runs due jobs in order, isolates failures, and skips overlapping checks', async () => {
  const order = [];
  const logs = [];
  let release;
  const slow = new Promise((r) => { release = r; });
  const s = new Scheduler({
    log: (m) => logs.push(m),
    jobs: [
      { name: 'a', due: () => true, run: async () => { order.push('a'); await slow; } },
      { name: 'boom', due: () => true, run: async () => { order.push('boom'); throw new Error('provider down'); } },
      { name: 'not-due', due: () => false, run: async () => order.push('never') },
      { name: 'bad-check', due: () => { throw new Error('cannot read'); }, run: async () => order.push('never') },
      { name: 'c', due: async () => true, run: async () => order.push('c') },
    ],
  });
  const first = s.tick();
  assert.deepEqual(await s.tick(), [], 'a check during a running check is skipped');
  release();
  assert.deepEqual(await first, ['a', 'boom (failed)', 'c']);
  assert.deepEqual(order, ['a', 'boom', 'c']);
  assert.ok(logs.some((l) => /\[boom\] failed: provider down/.test(l)));
  assert.ok(logs.some((l) => /\[bad-check\] could not check schedule/.test(l)));
  assert.ok(logs.some((l) => /still running/.test(l)));
});

function setup({ pending = 0 } = {}) {
  const dir = tmp();
  const memory = new StudioMemory(dir);
  const approvals = new ApprovalQueue(dir);
  for (let i = 0; i < pending; i++) approvals.add({ kind: 'publish_video', platform: 'youtube', title: `v${i}` });
  approvals.add({ kind: 'publish', title: 'a landing page' }); // other kinds don't count toward the backlog
  return { dir, memory, approvals };
}

test('studio job: runs when due, saves the run so a restart does not repeat it, then waits a full interval', async () => {
  const { dir, memory, approvals } = setup();
  let now = Date.parse('2026-11-06T08:00:00Z');
  let runs = 0;
  const makeStudio = () => ({ run: async () => { runs++; return { videos: [{}, {}], skipped: [] }; } });
  const job = createStudioJob({ makeStudio, memory, approvals, intervalMs: 24 * H, now: () => now });
  assert.equal(job.due(), true);
  await job.run();
  assert.equal(runs, 1);
  assert.equal(new StudioMemory(dir).schedule().lastRunAt, '2026-11-06T08:00:00.000Z');
  assert.deepEqual(new StudioMemory(dir).schedule().lastResult, { videos: 2, skipped: 0 });

  // "Restart": a fresh job reading the same files.
  const restarted = createStudioJob({ makeStudio, memory: new StudioMemory(dir), approvals, intervalMs: 24 * H, now: () => now });
  now += 23 * H;
  assert.equal(restarted.due(), false);
  now += 1 * H;
  assert.equal(restarted.due(), true);
});

test('studio job: pauses while too many Shorts wait for review, and resumes when you catch up', async () => {
  const { memory, approvals } = setup({ pending: 4 });
  const logs = [];
  const job = createStudioJob({ makeStudio: () => assert.fail('must not produce'), memory, approvals, intervalMs: 24 * H, maxPending: 4, log: (m) => logs.push(m) });
  assert.equal(pendingReviews(approvals), 4);
  assert.equal(job.due(), false);
  assert.equal(job.due(), false);
  assert.equal(logs.filter((l) => /waiting for your review/.test(l)).length, 1, 'backlog is mentioned once, not every check');
  approvals.decide(['act-0001'], 'approved');
  assert.equal(job.due(), true, 'one reviewed → below the limit → production resumes');
  assert.equal(memory.schedule().lastRunAt, undefined, 'a paused run is not recorded as done');
});

test('studio job: after a failure it retries in an hour, not every check and not a day later', async () => {
  const { memory, approvals } = setup();
  let now = Date.parse('2026-11-06T08:00:00Z');
  let fail = true;
  const job = createStudioJob({ makeStudio: () => ({ run: async () => { if (fail) throw new Error('speech model unavailable'); return { videos: [{}], skipped: [] }; } }), memory, approvals, intervalMs: 24 * H, now: () => now });
  await assert.rejects(job.run(), /speech model unavailable/);
  assert.equal(memory.schedule().lastError, 'speech model unavailable');
  now += 10 * 60_000;
  assert.equal(job.due(), false);
  now += 50 * 60_000;
  assert.equal(job.due(), true);
  fail = false;
  await job.run();
  const s = memory.schedule();
  assert.equal(s.lastError, undefined);
  assert.equal(s.lastRunAt, new Date(now).toISOString());
  now += 2 * H;
  assert.equal(job.due(), false, 'back on the normal 24h schedule after a success');
});

test('studio memory: separate instances never erase each other\'s changes', () => {
  const dir = tmp();
  const studio = new StudioMemory(dir);   // the studio
  const uploader = new StudioMemory(dir); // the YouTube executor
  const scheduler = new StudioMemory(dir); // the daemon job
  studio.addVideo({ slug: 'a', title: 'A', topic: 't' });
  uploader.linkUpload('a', { videoId: 'vidAAAAAAAA', youtubeUrl: 'u', privacy: 'public' });
  scheduler.updateSchedule({ lastRunAt: 'now' }); // its in-memory copy predates the upload
  studio.addVideo({ slug: 'b', title: 'B', topic: 't2' });
  const final = new StudioMemory(dir);
  assert.equal(final.find('a').videoId, 'vidAAAAAAAA');
  assert.equal(final.schedule().lastRunAt, 'now');
  assert.deepEqual(final.state.videos.map((v) => v.slug), ['a', 'b']);
});

test('daemonPlan: company always, studio when a niche is set, explicit --jobs wins, and safe limits', () => {
  assert.deepEqual(daemonPlan(loadConfig({}, {})).jobs, ['company']);
  const auto = daemonPlan(loadConfig({}, { AGENTS_CHANNEL_NICHE: 'x' }));
  assert.deepEqual([auto.jobs, auto.explicit, auto.studioIntervalMs], [['company', 'studio'], false, 24 * H]);
  assert.deepEqual(daemonPlan(loadConfig({}, { AGENTS_CHANNEL_NICHE: 'x', AGENTS_STUDIO_EVERY: 'off' })).jobs, ['company']);
  const only = daemonPlan(loadConfig({ jobs: 'studio', studioEvery: '12h' }, { AGENTS_CHANNEL_NICHE: 'x' }));
  assert.deepEqual([only.jobs, only.explicit, only.studioIntervalMs], [['studio'], true, 12 * H]);
  assert.match(daemonPlan(loadConfig({ jobs: 'studio,tiktok' }, {})).errors[0], /Unknown daemon job/);
  assert.match(daemonPlan(loadConfig({ jobs: 'studio', studioEvery: '30m' }, {})).errors[0], /at least 1h/);
  assert.match(daemonPlan(loadConfig({ jobs: 'studio', studioEvery: 'off' }, {})).errors[0], /AGENTS_STUDIO_EVERY=off/);
  assert.match(daemonPlan(loadConfig({ check: '10s' }, {})).errors[0], /at least 1m/);
  assert.equal(loadConfig({}, {}).checkMs, 10 * 60_000);
  assert.equal(loadConfig({}, {}).studioMaxPending, 4);
});
