import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAuth, finishAuth, waitForRedirect, GoogleAuth, tokenFile, refreshTokenFrom, SCOPE } from '../src/youtube/oauth.mjs';
import { YouTubeUploader, youtubeExecutor, QuotaExceededError, shortsUrl } from '../src/youtube/upload.mjs';
import { StudioMemory } from '../src/studio/memory.mjs';
import { ApprovalQueue } from '../src/approvals.mjs';
import { buildExecutors } from '../src/executors/index.mjs';
import { Studio } from '../src/studio/studio.mjs';
import { MockMediaClient } from '../src/studio/media.mjs';
import { MockLLMClient } from '../src/mock-llm.mjs';
import { hasFfmpeg } from '../src/studio/ffmpeg.mjs';
import { loadConfig, validateYouTubeConfig } from '../src/config.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'agents-yt-'));
const noSleep = async () => {};
const FFMPEG = await hasFfmpeg();
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// ---- OAuth ---------------------------------------------------------------------

test('startAuth builds a PKCE consent URL for the upload scope and stores the verifier privately', () => {
  const dir = tmp();
  const { url, redirectUri } = startAuth({ clientId: 'cid.apps.googleusercontent.com', dataDir: dir, port: 8976 });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const p = Object.fromEntries(u.searchParams);
  // Upload plus read-only analytics by default; upload only when analytics is off.
  assert.equal(p.scope, 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/yt-analytics.readonly');
  assert.equal(new URL(startAuth({ clientId: 'cid', dataDir: tmp(), port: 1, analytics: false }).url).searchParams.get('scope'), SCOPE);
  assert.deepEqual([p.response_type, p.access_type, p.prompt, p.code_challenge_method, p.redirect_uri], ['code', 'offline', 'consent', 'S256', redirectUri]);
  assert.equal(redirectUri, 'http://127.0.0.1:8976/oauth2callback');
  const pendingPath = join(dir, 'youtube-auth-pending.json');
  const pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
  assert.equal(p.code_challenge, createHash('sha256').update(pending.verifier).digest('base64url'));
  assert.equal(p.state, pending.state);
  assert.equal(statSync(pendingPath).mode & 0o777, 0o600);
  assert.throws(() => startAuth({ clientId: '', dataDir: dir, port: 1 }), /YOUTUBE_CLIENT_ID/);
});

test('finishAuth checks state, exchanges the code with the PKCE verifier, and stores only the refresh token (mode 600)', async () => {
  const dir = tmp();
  const { state } = startAuth({ clientId: 'cid', dataDir: dir, port: 8976 });
  const pending = JSON.parse(readFileSync(join(dir, 'youtube-auth-pending.json'), 'utf8'));
  await assert.rejects(finishAuth({ clientId: 'cid', dataDir: dir, redirectedUrl: `http://127.0.0.1:8976/oauth2callback?code=c&state=WRONG${state.slice(5)}` }), /state did not match/);
  await assert.rejects(finishAuth({ clientId: 'cid', dataDir: dir, redirectedUrl: 'http://127.0.0.1:8976/oauth2callback?error=access_denied' }), /access_denied/);

  let sent;
  const fetchImpl = async (url, init) => { sent = { url, body: Object.fromEntries(new URLSearchParams(init.body)) }; return json(200, { access_token: 'at', refresh_token: 'rt-123', scope: SCOPE, expires_in: 3599 }); };
  await finishAuth({ clientId: 'cid', clientSecret: 'sec', dataDir: dir, redirectedUrl: `http://127.0.0.1:8976/oauth2callback?code=the-code&state=${state}`, fetchImpl });
  assert.equal(sent.url, 'https://oauth2.googleapis.com/token');
  assert.deepEqual(sent.body, { client_id: 'cid', client_secret: 'sec', code: 'the-code', code_verifier: pending.verifier, redirect_uri: 'http://127.0.0.1:8976/oauth2callback', grant_type: 'authorization_code' });
  const stored = JSON.parse(readFileSync(tokenFile(dir), 'utf8'));
  assert.equal(stored.refresh_token, 'rt-123');
  assert.ok(!('access_token' in stored));
  assert.equal(statSync(tokenFile(dir)).mode & 0o777, 0o600);
  assert.ok(!existsSync(join(dir, 'youtube-auth-pending.json')));
  assert.equal(refreshTokenFrom({ dataDir: dir }), 'rt-123');
  assert.equal(refreshTokenFrom({ dataDir: dir, youtubeRefreshToken: 'env-token' }), 'env-token');
  await assert.rejects(finishAuth({ clientId: 'cid', dataDir: dir, redirectedUrl: 'http://x/?code=a&state=b' }), /No sign-in in progress/);
});

test('finishAuth refuses a response without a refresh token or without the upload scope', async () => {
  for (const [body, msg] of [[{ access_token: 'a', scope: SCOPE }, /no refresh token/], [{ access_token: 'a', refresh_token: 'r', scope: 'openid' }, /upload permission was not granted/]]) {
    const dir = tmp();
    const { state } = startAuth({ clientId: 'cid', dataDir: dir, port: 1 });
    await assert.rejects(finishAuth({ clientId: 'cid', dataDir: dir, redirectedUrl: `http://127.0.0.1:1/oauth2callback?code=c&state=${state}`, fetchImpl: async () => json(200, body) }), msg);
  }
});

const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

test('waitForRedirect catches Google\'s loopback redirect', async () => {
  const port = await freePort();
  let received;
  const done = waitForRedirect({ port, onUrl: async (u) => { received = u; } });
  await new Promise((r) => setTimeout(r, 50));
  const res = await fetch(`http://127.0.0.1:${port}/oauth2callback?code=abc&state=xyz`);
  assert.match(await res.text(), /YouTube is connected/);
  await done;
  assert.equal(received, `http://127.0.0.1:${port}/oauth2callback?code=abc&state=xyz`);
});

test('GoogleAuth caches access tokens, refreshes on expiry, and explains revoked access', async () => {
  let now = 0;
  let calls = 0;
  const auth = new GoogleAuth({ clientId: 'c', clientSecret: 's', refreshToken: 'r', now: () => now, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(new URLSearchParams(init.body).get('grant_type'), 'refresh_token');
    return json(200, { access_token: `tok${calls}`, expires_in: 3600 });
  } });
  assert.equal(await auth.accessToken(), 'tok1');
  now = 1000 * 3000;
  assert.equal(await auth.accessToken(), 'tok1');
  now = 1000 * 3560; // within a minute of expiry
  assert.equal(await auth.accessToken(), 'tok2');
  assert.equal(await auth.accessToken({ force: true }), 'tok3');
  const revoked = new GoogleAuth({ clientId: 'c', refreshToken: 'r', fetchImpl: async () => json(400, { error: 'invalid_grant' }) });
  await assert.rejects(revoked.accessToken(), /run `youtube-auth` again/);
  assert.throws(() => new GoogleAuth({ clientId: 'c' }), /not connected/);
});

// ---- uploader --------------------------------------------------------------------

const SESSION = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION1';

// A small fake of the YouTube upload API with switches for failure modes.
function fakeYouTube({ dropFirstPut = false, initStatus = [], quota = false, privacyOut = null } = {}) {
  const s = { inits: [], puts: [], tokens: 0, received: 0, total: 0 };
  const statuses = [...initStatus];
  const fetchImpl = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') { s.tokens++; return json(200, { access_token: `tok${s.tokens}`, expires_in: 3600 }); }
    if (url.startsWith('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status')) {
      s.inits.push({ headers: init.headers, body: JSON.parse(init.body) });
      const st = statuses.shift();
      if (st === 401) return json(401, { error: { message: 'Invalid Credentials' } });
      if (quota) return json(403, { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } });
      if (st === 400) return json(400, { error: { message: 'Invalid title', errors: [{ reason: 'invalidTitle' }] } });
      s.total = Number(init.headers['x-upload-content-length']);
      return new Response(null, { status: 200, headers: { location: SESSION } });
    }
    if (url === SESSION && init.method === 'PUT') {
      const range = init.headers['content-range'];
      if (range?.startsWith('bytes */')) {
        return s.received >= s.total
          ? json(201, { id: 'vid123', status: { privacyStatus: privacyOut ?? 'public' } })
          : new Response(null, { status: 308, headers: s.received > 0 ? { range: `bytes=0-${s.received - 1}` } : {} });
      }
      const len = init.body.length;
      s.puts.push({ range: range ?? null, len, auth: init.headers.authorization });
      if (dropFirstPut && s.puts.length === 1) { s.received = Math.floor(len / 2); throw new TypeError('fetch failed: socket hang up'); }
      s.received = (range ? Number(/bytes (\d+)-/.exec(range)[1]) : 0) + len;
      return json(201, { id: 'vid123', status: { privacyStatus: privacyOut ?? init.privacy ?? 'public', uploadStatus: 'uploaded' } });
    }
    return json(404, { error: { message: `unexpected ${init?.method} ${url}` } });
  };
  return { s, fetchImpl };
}

function videoFile(dir, bytes = 1000) {
  const root = join(dir, 'workspace', 'studio', 'run-1', 'my-short');
  mkdirSync(root, { recursive: true });
  const file = join(root, 'short.mp4');
  writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

const META = { title: 'Why budgets fail <fast>', description: 'Useful. <script>', tags: ['budget', '<x>'], privacyStatus: 'public', syntheticMedia: true };

test('uploader sends the resumable request with snippet, status and AI disclosure, then the bytes', async () => {
  const { s, fetchImpl } = fakeYouTube();
  const auth = new GoogleAuth({ clientId: 'c', refreshToken: 'r', fetchImpl });
  const file = videoFile(tmp(), 1234);
  const video = await new YouTubeUploader({ auth, fetchImpl, sleep: noSleep }).upload(file, META);
  assert.equal(video.id, 'vid123');
  const init = s.inits[0];
  assert.equal(init.headers['x-upload-content-length'], '1234');
  assert.equal(init.headers['x-upload-content-type'], 'video/mp4');
  assert.equal(init.headers.authorization, 'Bearer tok1');
  assert.deepEqual(init.body, {
    snippet: { title: 'Why budgets fail fast', description: 'Useful. script', tags: ['budget', 'x'], categoryId: '22' },
    status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
  });
  assert.deepEqual(s.puts.map((p) => [p.range, p.len]), [[null, 1234]]);
});

test('uploader resumes from the server-reported offset after a dropped connection', async () => {
  const { s, fetchImpl } = fakeYouTube({ dropFirstPut: true });
  const auth = new GoogleAuth({ clientId: 'c', refreshToken: 'r', fetchImpl });
  const video = await new YouTubeUploader({ auth, fetchImpl, sleep: noSleep }).upload(videoFile(tmp(), 1000), META);
  assert.equal(video.id, 'vid123');
  assert.deepEqual(s.puts.map((p) => [p.range, p.len]), [[null, 1000], ['bytes 500-999/1000', 500]]);
});

test('uploader refreshes a stale token once, stops on quota, and does not retry invalid requests', async () => {
  const stale = fakeYouTube({ initStatus: [401] });
  const auth1 = new GoogleAuth({ clientId: 'c', refreshToken: 'r', fetchImpl: stale.fetchImpl });
  await new YouTubeUploader({ auth: auth1, fetchImpl: stale.fetchImpl, sleep: noSleep }).upload(videoFile(tmp()), META);
  assert.deepEqual(stale.s.inits.map((i) => i.headers.authorization), ['Bearer tok1', 'Bearer tok2']);

  const quota = fakeYouTube({ quota: true });
  await assert.rejects(new YouTubeUploader({ auth: new GoogleAuth({ clientId: 'c', refreshToken: 'r', fetchImpl: quota.fetchImpl }), fetchImpl: quota.fetchImpl, sleep: noSleep }).upload(videoFile(tmp()), META), QuotaExceededError);

  const bad = fakeYouTube({ initStatus: [400] });
  await assert.rejects(new YouTubeUploader({ auth: new GoogleAuth({ clientId: 'c', refreshToken: 'r', fetchImpl: bad.fetchImpl }), fetchImpl: bad.fetchImpl, sleep: noSleep }).upload(videoFile(tmp()), META), /400 invalidTitle/);
  assert.equal(bad.s.inits.length, 1);
});

// ---- executor ----------------------------------------------------------------------

test('executor uploads only studio-made short.mp4 files, never twice, and defers on quota', async () => {
  const dir = tmp();
  const file = videoFile(dir);
  const memory = new StudioMemory(dir);
  memory.addVideo({ slug: 'my-short', title: 'T', topic: 't' });
  let uploads = 0;
  let quota = false;
  const uploader = { upload: async (f, meta) => { if (quota) throw new QuotaExceededError('YouTube daily upload quota reached'); uploads++; assert.equal(f, file); assert.equal(meta.privacyStatus, 'unlisted'); assert.equal(meta.syntheticMedia, true); return { id: 'abc', status: { privacyStatus: 'unlisted' } }; } };
  const exec = youtubeExecutor({ uploader, memory, dataDir: dir, privacyStatus: 'unlisted' });
  const item = { kind: 'publish_video', platform: 'youtube', videoPath: file, slug: 'my-short', upload: { title: 'T', description: 'D', tags: [] } };

  assert.equal(exec.canHandle(item), true);
  assert.equal(exec.canHandle({ ...item, platform: 'tiktok' }), false);
  await assert.rejects(exec.execute({ ...item, videoPath: '/etc/passwd' }), /not a studio-made short\.mp4/);
  const outside = join(dir, 'workspace', 'other.mp4');
  writeFileSync(outside, 'x');
  await assert.rejects(exec.execute({ ...item, videoPath: outside }), /not a studio-made/);
  await assert.rejects(exec.execute({ ...item, upload: undefined }), /no upload metadata/);

  quota = true;
  const deferred = await exec.execute(item);
  assert.equal(deferred.status, 'deferred');
  assert.match(deferred.reason, /quota/);
  quota = false;

  const r = await exec.execute(item);
  assert.deepEqual([r.status, r.videoId, r.url, r.privacy], ['executed', 'abc', 'https://youtube.com/shorts/abc', 'unlisted']);
  assert.equal(memory.find('my-short').videoId, 'abc');
  const again = await exec.execute(item);
  assert.equal(again.note, 'already uploaded');
  assert.equal(uploads, 1);
});

test('executor explains when YouTube keeps an upload private (unaudited API project)', async () => {
  const dir = tmp();
  const file = videoFile(dir);
  const exec = youtubeExecutor({ uploader: { upload: async () => ({ id: 'p1', status: { privacyStatus: 'private' } }) }, memory: null, dataDir: dir, privacyStatus: 'public' });
  const r = await exec.execute({ kind: 'publish_video', platform: 'youtube', videoPath: file, upload: { title: 'T' } });
  assert.equal(r.privacy, 'private');
  assert.match(r.reason, /unaudited API projects stay private/);
});

// ---- end to end: studio → approve → execute uploads -------------------------------

test('approving a studio Short uploads it to YouTube on execute; quota waits are retried', { skip: !FFMPEG && 'ffmpeg not installed', timeout: 180_000 }, async () => {
  const dir = tmp();
  const approvals = new ApprovalQueue(dir);
  const memory = new StudioMemory(dir);
  const config = { dataDir: dir, channelNiche: 'personal finance for students', channelName: 'Money Basics', studioVideos: 1, youtubeAutoUpload: true, youtubePrivacy: 'public', youtubeSynthetic: true, youtubeClientId: 'cid', youtubeClientSecret: 'sec', youtubeRefreshToken: 'rt' };
  const r = await new Studio({ llm: new MockLLMClient(), media: new MockMediaClient({ wordsPerSecond: 12 }), memory, approvals, config }).run();
  const id = r.videos[0].approval;
  assert.match(approvals.get(id).details, /approving uploads it to YouTube as public/);
  approvals.decide([id], 'approved');

  // Day 1: quota exhausted → stays approved with a note.
  const busy = fakeYouTube({ quota: true });
  await approvals.dispatch({ executors: buildExecutors(config, { fetchImpl: busy.fetchImpl }) });
  assert.equal(approvals.get(id).status, 'approved');
  assert.match(approvals.get(id).note, /quota/);

  // Day 2: uploads, records the Shorts link everywhere.
  const yt = fakeYouTube();
  await approvals.dispatch({ executors: buildExecutors(config, { fetchImpl: yt.fetchImpl }) });
  const item = approvals.get(id);
  assert.deepEqual([item.status, item.executor, item.videoId, item.resultUrl, item.note], ['executed', 'youtube', 'vid123', shortsUrl('vid123'), undefined]);
  assert.equal(yt.s.inits[0].body.snippet.title, r.videos[0].title);
  assert.match(yt.s.inits[0].body.snippet.description, /made with AI tools/);
  assert.equal(yt.s.puts[0].len, statSync(r.videos[0].videoPath).size);
  assert.equal(new StudioMemory(dir).find(r.videos[0].slug).youtubeUrl, 'https://youtube.com/shorts/vid123');
});

test('YouTube configuration checks', () => {
  assert.ok(validateYouTubeConfig(loadConfig({ youtubePrivacy: 'everyone' }, {})).errors.length);
  const c = loadConfig({}, { YOUTUBE_CLIENT_ID: 'x', AGENTS_DATA_DIR: tmp() });
  assert.equal(c.youtubeAutoUpload, false);
  assert.ok(validateYouTubeConfig(c).warnings.some((w) => /youtube-auth/.test(w)));
  assert.ok(validateYouTubeConfig(c).warnings.some((w) => /CLIENT_SECRET/.test(w)));
  assert.equal(loadConfig({}, { YOUTUBE_CLIENT_ID: 'x', YOUTUBE_REFRESH_TOKEN: 'r' }).youtubeAutoUpload, true);
  assert.equal(loadConfig({}, {}).youtubePrivacy, 'public');
  assert.equal(loadConfig({}, { AGENTS_YOUTUBE_SYNTHETIC: '0' }).youtubeSynthetic, false);
});
