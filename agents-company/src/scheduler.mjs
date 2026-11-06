// The daemon's scheduler. Every check (default 10 minutes) it runs, in order,
// each job that is due. Jobs run one at a time, a failing job never stops the
// others, and a check that starts while the previous one is still running is
// skipped.

export function isDue(lastAt, intervalMs, now = Date.now()) {
  if (!lastAt) return true;
  const t = new Date(lastAt).getTime();
  return !Number.isFinite(t) || now - t >= intervalMs;
}

export class Scheduler {
  // jobs: [{name, due: () => bool, run: async () => any}]
  constructor({ jobs, log = () => {} }) {
    this.jobs = jobs;
    this.log = log;
    this.running = false;
  }

  async tick() {
    if (this.running) {
      this.log('Previous check still running; skipping this one');
      return [];
    }
    this.running = true;
    const ran = [];
    try {
      for (const job of this.jobs) {
        let due = false;
        try { due = await job.due(); } catch (err) { this.log(`[${job.name}] could not check schedule: ${err.message}`); }
        if (!due) continue;
        try {
          await job.run();
          ran.push(job.name);
        } catch (err) {
          this.log(`[${job.name}] failed: ${err.message}`);
          ran.push(`${job.name} (failed)`);
        }
      }
    } finally {
      this.running = false;
    }
    return ran;
  }
}
