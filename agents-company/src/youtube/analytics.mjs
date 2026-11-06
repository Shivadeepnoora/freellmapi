// Pulls per-video stats from the YouTube Analytics API v2 for the Shorts the
// studio uploaded, and stores them as each video's results (the same place
// `studio-results` writes), so the Topic Researcher learns from real numbers.
//
//   GET https://youtubeanalytics.googleapis.com/v2/reports
//       ?ids=channel==MINE&dimensions=video&filters=video==ID1,ID2
//       &metrics=views,likes,comments,subscribersGained,averageViewPercentage,averageViewDuration
//       &startDate=…&endDate=…&sort=-views&maxResults=…
//
// Analytics data usually lags 1-3 days, so fresh uploads show as "waiting".

import { GoogleAuth, refreshTokenFrom } from './oauth.mjs';
import { youtubeAnalyticsGranted } from '../config.mjs';

const REPORTS_URL = 'https://youtubeanalytics.googleapis.com/v2/reports';

// Null unless YouTube is connected, analytics is on, and the sign-in granted it.
export function analyticsFromConfig(config, { fetchImpl } = {}) {
  if (!config.youtubeAutoUpload || !config.youtubeAnalytics || !youtubeAnalyticsGranted(config)) return null;
  const auth = new GoogleAuth({ clientId: config.youtubeClientId, clientSecret: config.youtubeClientSecret, refreshToken: refreshTokenFrom(config), fetchImpl });
  return new YouTubeAnalytics({ auth, fetchImpl });
}
const METRICS = ['views', 'likes', 'comments', 'subscribersGained', 'averageViewPercentage', 'averageViewDuration'];
const BATCH = 200; // video-dimension reports return at most 200 rows
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

export class AnalyticsScopeError extends Error {}

export class YouTubeAnalytics {
  constructor({ auth, fetchImpl = globalThis.fetch }) {
    this.auth = auth;
    this.fetch = fetchImpl;
  }

  // Returns Map(videoId → {views, likes, comments, subscribers, viewedPct, avgViewSeconds}).
  async videoStats(videoIds, { startDate, endDate }) {
    const ids = [...new Set(videoIds)].filter((id) => VIDEO_ID_RE.test(id));
    const out = new Map();
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const url = new URL(REPORTS_URL);
      url.search = new URLSearchParams({
        ids: 'channel==MINE',
        startDate,
        endDate,
        metrics: METRICS.join(','),
        dimensions: 'video',
        filters: `video==${batch.join(',')}`,
        sort: '-views',
        maxResults: String(batch.length),
      }).toString();
      const data = await this.#get(url.toString());
      const col = Object.fromEntries((data.columnHeaders ?? []).map((h, idx) => [h.name, idx]));
      for (const row of data.rows ?? []) {
        const num = (name) => (col[name] === undefined ? undefined : Number(row[col[name]]));
        out.set(String(row[col.video]), {
          views: num('views'),
          likes: num('likes'),
          comments: num('comments'),
          subscribers: num('subscribersGained'),
          viewedPct: num('averageViewPercentage') != null ? Math.round(num('averageViewPercentage') * 10) / 10 : undefined,
          avgViewSeconds: num('averageViewDuration'),
        });
      }
    }
    return out;
  }

  async #get(url) {
    for (let refreshed = false; ;) {
      const res = await this.fetch(url, { headers: { authorization: `Bearer ${await this.auth.accessToken({ force: refreshed })}` } });
      if (res.ok) return res.json();
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && !refreshed) { refreshed = true; continue; }
      const reason = data?.error?.errors?.[0]?.reason ?? data?.error?.status ?? '';
      if (res.status === 403 && /insufficient|PERMISSION_DENIED|forbidden/i.test(`${reason} ${data?.error?.message ?? ''}`)) {
        throw new AnalyticsScopeError('YouTube Analytics access was not granted: run `youtube-auth` again and allow "View YouTube Analytics reports"');
      }
      throw new Error(`YouTube Analytics request failed (${res.status} ${reason}): ${data?.error?.message ?? ''}`.trim());
    }
  }
}

// Updates studio memory with the latest numbers for every uploaded Short.
// Returns {updated, waiting, uploaded} for logging.
export async function syncStudioStats({ analytics, memory, now = new Date(), log = () => {} }) {
  const uploaded = memory.reload().state.videos.filter((v) => v.videoId && VIDEO_ID_RE.test(v.videoId));
  if (!uploaded.length) return { updated: [], waiting: [], uploaded: 0 };
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  const startDate = day(Math.min(...uploaded.map((v) => new Date(v.uploadedAt ?? v.createdAt ?? now).getTime())));
  const stats = await analytics.videoStats(uploaded.map((v) => v.videoId), { startDate, endDate: day(now) });
  const updated = [];
  const waiting = [];
  for (const v of uploaded) {
    const s = stats.get(v.videoId);
    if (!s || s.views == null) { waiting.push(v.slug); continue; }
    const clean = Object.fromEntries(Object.entries(s).filter(([, n]) => Number.isFinite(n) && n >= 0));
    memory.recordResults(v.slug, { ...clean, source: 'youtube-analytics' }, now.toISOString());
    updated.push(v.slug);
  }
  log(`[YouTube Analytics] updated ${updated.length} video(s)${waiting.length ? `, ${waiting.length} waiting for data (Analytics lags 1-3 days)` : ''}`);
  return { updated, waiting, uploaded: uploaded.length };
}
