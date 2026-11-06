// The studio's daemon job: makes a new batch of Shorts every
// AGENTS_STUDIO_EVERY, unless too many videos are already waiting for your
// review. The last run is saved in studio memory, so restarting the daemon
// doesn't make an extra batch; after a failure it retries an hour later
// (or sooner if the interval is shorter) instead of hammering the providers.
import { isDue } from '../scheduler.mjs';

const RETRY_MS = 60 * 60_000;

export function pendingReviews(approvals) {
  return approvals.list('pending').filter((a) => a.kind === 'publish_video').length;
}

export function createStudioJob({ makeStudio, memory, approvals, intervalMs, maxPending = 4, now = () => Date.now(), log = () => {} }) {
  let backlogNoted = false;
  return {
    name: 'studio',
    due() {
      const s = memory.schedule();
      if (s.lastFailureAt && new Date(s.lastFailureAt) > new Date(s.lastRunAt ?? 0)) {
        return isDue(s.lastFailureAt, Math.min(RETRY_MS, intervalMs), now());
      }
      if (!isDue(s.lastRunAt, intervalMs, now())) return false;
      const waiting = pendingReviews(approvals);
      if (waiting >= maxPending) {
        // Not marked as run: production resumes as soon as you review the backlog.
        if (!backlogNoted) log(`[studio] due, but ${waiting} Shorts are waiting for your review (limit ${maxPending}); run \`approvals\` to catch up`);
        backlogNoted = true;
        return false;
      }
      backlogNoted = false;
      return true;
    },
    async run() {
      const started = new Date(now()).toISOString();
      try {
        const r = await makeStudio().run();
        memory.updateSchedule({ lastRunAt: started, lastResult: { videos: r.videos.length, skipped: r.skipped.length }, lastError: undefined });
        log(`[studio] scheduled run made ${r.videos.length} Short(s) for review${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}; next in about ${Math.round(intervalMs / 36e5)}h`);
        return r;
      } catch (err) {
        memory.updateSchedule({ lastFailureAt: started, lastError: err.message });
        throw err;
      }
    },
  };
}
