// YouTube Data API v3 resumable upload (videos.insert):
//   1. POST /upload/youtube/v3/videos?uploadType=resumable&part=snippet,status  → Location: <session URL>
//   2. PUT <session URL> with the bytes                                          → 200/201 + video resource
//   On a dropped connection or 5xx: PUT "Content-Range: bytes */N" → 308 + Range, then send the rest.
// Each upload costs 1,600 of the default 10,000 daily quota units (about 6 a day).
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep, basename } from 'node:path';

const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const MAX_BYTES = 256 * 1024 * 1024;
export const PRIVACY = ['public', 'unlisted', 'private'];

export class QuotaExceededError extends Error {}

export class YouTubeUploader {
  constructor({ auth, fetchImpl = globalThis.fetch, attempts = 5, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    Object.assign(this, { auth, fetch: fetchImpl, attempts, sleep });
  }

  // meta: {title, description, tags, categoryId, privacyStatus, syntheticMedia}
  async upload(file, meta) {
    const size = statSync(file).size;
    if (size > MAX_BYTES) throw new Error('Video is larger than 256 MB; that is not a Short');
    const bytes = readFileSync(file);
    const session = await this.#startSession(size, meta);
    let offset = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.fetch(session, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${await this.auth.accessToken()}`,
            'content-type': 'video/mp4',
            'content-length': String(size - offset),
            ...(offset > 0 ? { 'content-range': `bytes ${offset}-${size - 1}/${size}` } : {}),
          },
          body: bytes.subarray(offset),
        });
        if (res.status === 200 || res.status === 201) return res.json();
        if (res.status === 308) { offset = await this.#uploadedSoFar(session, size); continue; }
        await this.#throwFor(res);
      } catch (err) {
        if (err instanceof QuotaExceededError || err.fatal || attempt >= this.attempts) throw err;
        await this.sleep(1000 * 2 ** attempt);
        offset = await this.#uploadedSoFar(session, size); // resume where the server says we got to
      }
    }
  }

  async #startSession(size, meta) {
    const body = {
      snippet: {
        title: String(meta.title).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100), // YouTube rejects < and > in titles
        description: String(meta.description ?? '').replace(/[<>]/g, '').slice(0, 5000),
        tags: (meta.tags ?? []).map((t) => String(t).replace(/[<>]/g, '')).filter(Boolean).slice(0, 30),
        categoryId: meta.categoryId ?? '22',
      },
      status: {
        privacyStatus: PRIVACY.includes(meta.privacyStatus) ? meta.privacyStatus : 'private',
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: Boolean(meta.syntheticMedia),
      },
    };
    for (let refreshed = false; ;) {
      const res = await this.fetch(UPLOAD_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.auth.accessToken({ force: refreshed })}`,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-length': String(size),
          'x-upload-content-type': 'video/mp4',
        },
        body: JSON.stringify(body),
      });
      if (res.status === 401 && !refreshed) { refreshed = true; continue; } // stale token: refresh once
      if (!res.ok) await this.#throwFor(res);
      const location = res.headers.get('location');
      if (!location?.startsWith('https://')) throw Object.assign(new Error('YouTube did not return an upload session URL'), { fatal: true });
      return location;
    }
  }

  async #uploadedSoFar(session, size) {
    const res = await this.fetch(session, {
      method: 'PUT',
      headers: { authorization: `Bearer ${await this.auth.accessToken()}`, 'content-range': `bytes */${size}`, 'content-length': '0' },
    });
    if (res.status === 200 || res.status === 201) return size;
    if (res.status !== 308) await this.#throwFor(res);
    const range = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '');
    return range ? Number(range[1]) + 1 : 0;
  }

  async #throwFor(res) {
    const data = await res.json().catch(() => ({}));
    const reason = data?.error?.errors?.[0]?.reason ?? data?.error?.status ?? '';
    const message = data?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 403 && /quotaExceeded|dailyLimitExceeded|rateLimitExceeded/i.test(reason)) {
      throw new QuotaExceededError('YouTube daily upload quota reached');
    }
    if (res.status === 400 && /uploadLimitExceeded/i.test(reason)) throw new QuotaExceededError('YouTube channel upload limit reached for today');
    const err = new Error(`YouTube upload failed (${res.status} ${reason}): ${message}`);
    err.fatal = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    throw err;
  }
}

// Executor for approved publish_video items. Only uploads a short.mp4 the
// studio wrote inside data/workspace/studio/, so an edited approvals file
// can't make it upload anything else, and never uploads the same video twice.
export function youtubeExecutor({ uploader, memory, dataDir, privacyStatus = 'public', syntheticMedia = true, log = () => {} }) {
  const studioRoot = resolve(dataDir, 'workspace', 'studio') + sep;
  return {
    name: 'youtube',
    canHandle: (a) => a?.kind === 'publish_video' && a.platform === 'youtube' && typeof a.videoPath === 'string',
    async execute(action) {
      const file = resolve(action.videoPath);
      if (!file.startsWith(studioRoot) || basename(file) !== 'short.mp4') throw new Error(`refusing to upload ${action.videoPath}: not a studio-made short.mp4`);
      const already = action.videoId ?? memory?.reload().find(action.slug)?.videoId;
      if (already) return { status: 'executed', executor: 'youtube', videoId: already, url: shortsUrl(already), note: 'already uploaded' };
      if (!action.upload?.title) throw new Error('this item has no upload metadata; re-run the studio to produce it again');
      try {
        const video = await uploader.upload(file, { ...action.upload, privacyStatus, syntheticMedia });
        const url = shortsUrl(video.id);
        const actualPrivacy = video.status?.privacyStatus ?? privacyStatus;
        if (memory && action.slug) memory.linkUpload(action.slug, { videoId: video.id, youtubeUrl: url, privacy: actualPrivacy });
        log(`[YouTube] uploaded "${action.upload.title}" as ${actualPrivacy}: ${url}`);
        return {
          status: 'executed', executor: 'youtube', videoId: video.id, url, privacy: actualPrivacy,
          ...(actualPrivacy !== privacyStatus ? { reason: `YouTube set it to ${actualPrivacy}. Uploads from unaudited API projects stay private until Google approves the project; change it in YouTube Studio meanwhile.` } : {}),
        };
      } catch (err) {
        if (err instanceof QuotaExceededError) return { status: 'deferred', reason: `${err.message}; it will be retried on the next execute/daemon run` };
        throw err;
      }
    },
  };
}

export function shortsUrl(id) {
  return `https://youtube.com/shorts/${encodeURIComponent(id)}`;
}
