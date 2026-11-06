import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YouTubeAnalytics, AnalyticsScopeError, syncStudioStats, analyticsFromConfig } from '../src/youtube/analytics.mjs';
import { startAuth, finishAuth, grantedScopes, SCOPE, ANALYTICS_SCOPE } from '../src/youtube/oauth.mjs';
import { StudioMemory } from '../src/studio/memory.mjs';
import { Studio } from '../src/studio/studio.mjs';
import { MockMediaClient } from '../src/studio/media.mjs';
import { MockLLMClient } from '../src/mock-llm.mjs';
import { hasFfmpeg } from '../src/studio/ffmpeg.mjs';
import { loadConfig, validateYouTubeConfig, youtubeAnalyticsGranted } from '../src/config.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'agents-yta-'));
const FFMPEG = await hasFfmpeg();
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const HEADERS = ['video', 'views', 'likes', 'comments', 'subscribersGained', 'averageViewPercentage', 'averageViewDuration'].map((name) => ({ name }));

function staticAuth() {
  const a = { calls: [] };
  a.accessToken = async ({ force } = {}) => { a.calls.push(Boolean(force)); return force ? 'fresh' : 'cached'; };
  return a;
}

test('videoStats requests a per-video report for the given ids and parses rows', async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push({ url: new URL(url), auth: init.headers.authorization });
    return json(200, { columnHeaders: HEADERS, rows: [['abcDEF12345', 1500, 90, 7, 12, 81.234, 24]] });
  };
  const stats = await new YouTubeAnalytics({ auth: staticAuth(), fetchImpl }).videoStats(['abcDEF12345', 'bad id!', 'abcDEF12345'], { startDate: '2026-11-01', endDate: '2026-11-06' });
  const u = urls[0].url;
  assert.equal(u.origin + u.pathname, 'https://youtubeanalytics.googleapis.com/v2/reports');
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    ids: 'channel==MINE', startDate: '2026-11-01', endDate: '2026-11-06',
    metrics: 'views,likes,comments,subscribersGained,averageViewPercentage,averageViewDuration',
    dimensions: 'video', filters: 'video==abcDEF12345', sort: '-views', maxResults: '1',
  });
  assert.equal(urls[0].auth, 'Bearer cached');
  assert.deepEqual(stats.get('abcDEF12345'), { views: 1500, likes: 90, comments: 7, subscribers: 12, viewedPct: 81.2, avgViewSeconds: 24 });
});

test('videoStats batches large id lists, refreshes a stale token once, and explains a missing permission', async () => {
  const ids = Array.from({ length: 450 }, (_, i) => `vid${String(i).padStart(8, '0')}`);
  const batches = [];
  const many = new YouTubeAnalytics({ auth: staticAuth(), fetchImpl: async (url) => {
    batches.push(new URL(url).searchParams.get('filters').replace('video==', '').split(',').length);
    return json(200, { columnHeaders: HEADERS, rows: [] });
  } });
  await many.videoStats(ids, { startDate: '2026-01-01', endDate: '2026-11-06' });
  assert.deepEqual(batches, [200, 200, 50]);

  const auth = staticAuth();
  let n = 0;
  const stale = new YouTubeAnalytics({ auth, fetchImpl: async () => (++n === 1 ? json(401, { error: { message: 'expired' } }) : json(200, { columnHeaders: HEADERS, rows: [] })) });
  await stale.videoStats(['abcDEF12345'], { startDate: 'a', endDate: 'b' });
  assert.deepEqual(auth.calls, [false, true]);

  const noScope = new YouTubeAnalytics({ auth: staticAuth(), fetchImpl: async () => json(403, { error: { message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } }) });
  await assert.rejects(noScope.videoStats(['abcDEF12345'], { startDate: 'a', endDate: 'b' }), AnalyticsScopeError);
  const broken = new YouTubeAnalytics({ auth: staticAuth(), fetchImpl: async () => json(500, { error: { message: 'backend error' } }) });
  await assert.rejects(broken.videoStats(['abcDEF12345'], { startDate: 'a', endDate: 'b' }), /500.*backend error/);
});

test('syncStudioStats stores analytics as results, keeps fresh uploads waiting, and feeds topic research', async () => {
  const dir = tmp();
  const memory = new StudioMemory(dir);
  memory.addVideo({ slug: 'old', title: 'Old', topic: 'topic old' });
  memory.addVideo({ slug: 'fresh', title: 'Fresh', topic: 'topic fresh' });
  memory.addVideo({ slug: 'local', title: 'Never uploaded', topic: 'topic local' });
  memory.linkUpload('old', { videoId: 'oldVIDEO001', youtubeUrl: 'https://youtube.com/shorts/oldVIDEO001', privacy: 'public' });
  memory.linkUpload('fresh', { videoId: 'newVIDEO002', youtubeUrl: 'https://youtube.com/shorts/newVIDEO002', privacy: 'public' });
  memory.find('old').uploadedAt = '2026-10-20T10:00:00.000Z';
  memory.recordResults('old', { views: 10 }); // hand-typed earlier

  let asked;
  const analytics = { videoStats: async (ids, range) => { asked = { ids, range }; return new Map([['oldVIDEO001', { views: 3200, likes: 140, comments: 12, subscribers: 21, viewedPct: 88.5, avgViewSeconds: 31 }]]); } };
  const r = await syncStudioStats({ analytics, memory, now: new Date('2026-11-06T09:00:00Z') });

  assert.deepEqual(asked.ids, ['oldVIDEO001', 'newVIDEO002']);
  assert.deepEqual(asked.range, { startDate: '2026-10-20', endDate: '2026-11-06' });
  assert.deepEqual([r.updated, r.waiting, r.uploaded], [['old'], ['fresh'], 2]);
  const old = new StudioMemory(dir).find('old').results;
  assert.deepEqual([old.views, old.subscribers, old.viewedPct, old.source, old.at], [3200, 21, 88.5, 'youtube-analytics', '2026-11-06T09:00:00.000Z']);
  assert.equal(new StudioMemory(dir).find('fresh').results, null);
  assert.match(new StudioMemory(dir).summaryForPrompt(), /"Old" \(topic: topic old\): 3200 views, 88\.5% viewed, \+21 subs/);

  const none = await syncStudioStats({ analytics: { videoStats: async () => assert.fail('should not call') }, memory: new StudioMemory(tmp()) });
  assert.equal(none.uploaded, 0);
});

test('sign-in records whether Analytics was granted, and setup checks notice when it was not', async () => {
  const dir = tmp();
  const { state } = startAuth({ clientId: 'cid', dataDir: dir, port: 1 });
  const r = await finishAuth({ clientId: 'cid', dataDir: dir, redirectedUrl: `http://127.0.0.1:1/oauth2callback?code=c&state=${state}`, fetchImpl: async () => json(200, { refresh_token: 'rt', scope: `${SCOPE} ${ANALYTICS_SCOPE}` }) });
  assert.equal(r.analytics, true);
  assert.deepEqual(grantedScopes({ dataDir: dir }), [SCOPE, ANALYTICS_SCOPE]);
  const base = { YOUTUBE_CLIENT_ID: 'cid', YOUTUBE_CLIENT_SECRET: 's', AGENTS_DATA_DIR: dir };
  assert.equal(youtubeAnalyticsGranted(loadConfig({}, base)), true);
  assert.ok(analyticsFromConfig(loadConfig({}, base)) instanceof YouTubeAnalytics);
  assert.equal(analyticsFromConfig(loadConfig({}, { ...base, AGENTS_YOUTUBE_ANALYTICS: '0' })), null);

  // An older sign-in with only the upload scope (user unticked Analytics, or signed in before this feature).
  const old = tmp();
  writeFileSync(join(old, 'youtube-token.json'), JSON.stringify({ refresh_token: 'rt', scope: SCOPE }));
  const oldCfg = loadConfig({}, { ...base, AGENTS_DATA_DIR: old });
  assert.equal(youtubeAnalyticsGranted(oldCfg), false);
  assert.equal(analyticsFromConfig(oldCfg), null);
  assert.ok(validateYouTubeConfig(oldCfg).warnings.some((w) => /Analytics is not granted.*youtube-auth/.test(w)));
  assert.equal(analyticsFromConfig(loadConfig({}, {})), null, 'not connected at all');
});

test('a studio run syncs YouTube stats before choosing topics, and a sync failure does not stop it', { skip: !FFMPEG && 'ffmpeg not installed', timeout: 180_000 }, async () => {
  const dir = tmp();
  const memory = new StudioMemory(dir);
  memory.addVideo({ slug: 'hit', title: 'The hit', topic: 'Old topic' });
  memory.linkUpload('hit', { videoId: 'hitVIDEO001', youtubeUrl: 'u', privacy: 'public' });
  const config = { dataDir: dir, channelNiche: 'personal finance for students', studioVideos: 1 };
  const order = [];
  const llm = new MockLLMClient();
  const origChat = llm.chatJSON.bind(llm);
  llm.chatJSON = async (m, o) => { if (m[0].content.includes('ROLE: topic_researcher')) order.push('research'); return origChat(m, o); };
  const syncStats = async () => {
    order.push('sync');
    return syncStudioStats({ analytics: { videoStats: async () => new Map([['hitVIDEO001', { views: 9000, viewedPct: 92, subscribers: 40 }]]) }, memory });
  };
  await new Studio({ llm, media: new MockMediaClient({ wordsPerSecond: 12 }), memory, config, syncStats }).run();
  assert.deepEqual(order, ['sync', 'research']);
  assert.match(llm.calls.find((c) => c.system.includes('ROLE: topic_researcher')).user, /"The hit" \(topic: Old topic\): 9000 views, 92% viewed, \+40 subs/);

  const logs = [];
  const r = await new Studio({ llm: new MockLLMClient(), media: new MockMediaClient({ wordsPerSecond: 12 }), memory, config, syncStats: async () => { throw new Error('Analytics down'); }, log: (m) => logs.push(m) }).run();
  assert.equal(r.videos.length, 1);
  assert.ok(logs.some((l) => /YouTube Analytics\] skipped: Analytics down/.test(l)));
});
