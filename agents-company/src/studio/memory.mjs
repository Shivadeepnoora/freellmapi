// What the channel has made and how each video did: results come from YouTube
// Analytics (studio-sync) or are typed in with `studio-results`.
//
// Several parts of a running daemon (the studio, the YouTube uploader, the
// analytics sync, the scheduler) each hold a StudioMemory for the same file,
// so every change re-reads the file first and writes straight back. One
// part saving an old copy can never erase another part's change.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RESULT_FIELDS = ['views', 'likes', 'comments', 'subscribers', 'viewedPct', 'avgViewSeconds'];

export class StudioMemory {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'studio-memory.json');
    this.reload();
  }

  reload() {
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { videos: [] };
    this.state.videos ??= [];
    return this;
  }

  // Read the latest file, apply the change, write it back.
  #mutate(fn) {
    this.reload();
    const out = fn(this.state);
    this.save();
    return out;
  }

  topicsMade() {
    return this.state.videos.map((v) => v.topic);
  }

  addVideo(video) {
    this.#mutate((s) => { s.videos.push({ ...video, createdAt: new Date().toISOString(), results: null }); });
  }

  // The daemon's studio schedule (last run, last failure).
  updateSchedule(patch) {
    return this.#mutate((s) => {
      s.schedule = { ...(s.schedule ?? {}), ...patch };
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete s.schedule[k];
      return s.schedule;
    });
  }

  schedule() {
    return this.reload().state.schedule ?? {};
  }

  find(slug) {
    return this.state.videos.find((v) => v.slug === slug) ?? null;
  }

  recordResults(slug, results, at = new Date().toISOString()) {
    const clean = {};
    for (const k of RESULT_FIELDS) {
      if (results[k] === undefined || results[k] === null || results[k] === '') continue;
      const n = Number(results[k]);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a non-negative number`);
      clean[k] = n;
    }
    if (!Object.keys(clean).length) throw new Error(`Give at least one of: ${RESULT_FIELDS.map((f) => `--${kebab(f)}`).join(', ')}`);
    return this.#mutate(() => {
      const v = this.find(slug);
      if (!v) throw new Error(`No video "${slug}" (see \`studio-list\`)`);
      // Analytics numbers replace hand-typed ones field by field; `source` says where they came from.
      v.results = { ...(v.results ?? {}), ...clean, at, source: results.source === 'youtube-analytics' ? 'youtube-analytics' : 'manual' };
      if (results.youtubeUrl) v.youtubeUrl = String(results.youtubeUrl);
      return v;
    });
  }

  // Called by the YouTube executor after a successful upload.
  linkUpload(slug, { videoId, youtubeUrl, privacy }) {
    return this.#mutate(() => {
      const v = this.find(slug);
      if (!v) return null;
      Object.assign(v, { videoId, youtubeUrl, privacy, uploadedAt: new Date().toISOString() });
      return v;
    });
  }

  // Ranks videos that have results by a simple score: views, weighted up by
  // retention and by subscribers gained per 1,000 views.
  ranked() {
    return this.state.videos
      .filter((v) => v.results?.views != null)
      .map((v) => ({ ...v, score: performanceScore(v.results) }))
      .sort((a, b) => b.score - a.score);
  }

  // Email- and noise-free summary for the Topic Researcher.
  summaryForPrompt() {
    const r = this.ranked();
    if (!r.length) return 'No published results yet. Make varied, specific topics so the channel learns what works.';
    const line = (v) => `- "${v.title}" (topic: ${v.topic}): ${v.results.views} views` +
      `${v.results.viewedPct != null ? `, ${v.results.viewedPct}% viewed` : ''}` +
      `${v.results.subscribers != null ? `, +${v.results.subscribers} subs` : ''}`;
    const best = r.slice(0, 3).map(line).join('\n');
    const worst = r.length > 3 ? `\nWeakest:\n${r.slice(-3).map(line).join('\n')}` : '';
    return `Past Shorts results (real data from YouTube Studio):\nBest:\n${best}${worst}`;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }
}

export function performanceScore(r) {
  const views = r.views ?? 0;
  const retention = r.viewedPct != null ? Math.min(150, r.viewedPct) / 100 : 0.7;
  const subsPer1k = views > 0 && r.subscribers != null ? (r.subscribers / views) * 1000 : 0;
  return Math.round(Math.log10(1 + views) * retention * (1 + subsPer1k / 10) * 100) / 100;
}

function kebab(s) {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
