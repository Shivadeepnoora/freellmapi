// Voiceover and visuals from an OpenAI-compatible media API (FreeLLMAPI by
// default, which routes across the free providers that serve these models):
//   POST /audio/speech            {model, input, voice, response_format}  → audio bytes
//   POST /images/generations      {model, prompt, size, response_format}  → {data:[{b64_json|url}]}
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './ffmpeg.mjs';

export class MediaClient {
  constructor({ baseUrl, apiKey, ttsModel = 'auto', voice = 'alloy', imageModel = 'auto', retries = 2, timeoutMs = 180_000, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    if (!baseUrl) throw new Error('MediaClient needs a base URL');
    Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), apiKey, ttsModel, voice, imageModel, retries, timeoutMs, fetch: fetchImpl, sleep });
    this.usage = { speech: 0, images: 0 };
  }

  async #post(path, body) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) return res;
        const text = await res.text().catch(() => '');
        const err = new Error(`${path} -> ${res.status}: ${text.slice(0, 200)}`);
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      } catch (err) {
        lastErr = err;
        if (err.retryable === false || attempt === this.retries) break;
        await this.sleep(2000 * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  // Writes the narration for `text` into dir and returns the file path.
  async speech(text, dir, name) {
    const res = await this.#post('/audio/speech', { model: this.ttsModel, input: text, voice: this.voice, response_format: 'mp3' });
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 100) throw new Error('speech: the provider returned an empty audio file');
    const ext = audioExt(res.headers.get('content-type'), bytes);
    const file = join(dir, `${name}.${ext}`);
    writeFileSync(file, bytes);
    this.usage.speech++;
    return file;
  }

  // Writes one vertical image for `prompt` into dir and returns the file path.
  async image(prompt, dir, name) {
    const res = await this.#post('/images/generations', { model: this.imageModel, prompt, n: 1, size: '1024x1792', response_format: 'b64_json' });
    const data = await res.json();
    const item = data?.data?.[0];
    let bytes;
    if (item?.b64_json) bytes = Buffer.from(item.b64_json, 'base64');
    else if (item?.url && /^https?:\/\//.test(item.url)) {
      const img = await this.fetch(item.url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!img.ok) throw new Error(`image download -> ${img.status}`);
      bytes = Buffer.from(await img.arrayBuffer());
    } else throw new Error('image: the provider returned no image');
    const ext = imageExt(bytes);
    if (!ext) throw new Error('image: unsupported or corrupt image data');
    const file = join(dir, `${name}.${ext}`);
    writeFileSync(file, bytes);
    this.usage.images++;
    return file;
  }
}

// The image2 demuxer picks a decoder from the extension, so name files by their real format.
export function imageExt(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function audioExt(contentType, b) {
  const ct = String(contentType ?? '').toLowerCase();
  if (ct.includes('wav') || b.toString('ascii', 0, 4) === 'RIFF') return 'wav';
  if (ct.includes('ogg') || b.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (ct.includes('flac') || b.toString('ascii', 0, 4) === 'fLaC') return 'flac';
  if (ct.includes('aac') || ct.includes('mp4')) return 'm4a';
  return 'mp3';
}

// Offline stand-in: a coloured image per scene and a tone whose length follows
// the narration (≈2.7 words per second), so the real ffmpeg pipeline runs end to end.
const COLOURS = ['0x1d3557', '0x457b9d', '0x2a9d8f', '0xe76f51', '0x6d597a', '0x264653', '0xbc6c25'];

export class MockMediaClient {
  constructor({ wordsPerSecond = 2.7 } = {}) {
    this.wordsPerSecond = wordsPerSecond;
    this.usage = { speech: 0, images: 0 };
    this.calls = [];
  }

  async speech(text, dir, name) {
    const seconds = Math.max(1, String(text).split(/\s+/).filter(Boolean).length / this.wordsPerSecond).toFixed(2);
    const file = join(dir, `${name}.m4a`);
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds}`, '-c:a', 'aac', file]);
    this.usage.speech++;
    this.calls.push({ type: 'speech', text });
    return file;
  }

  async image(prompt, dir, name) {
    const colour = COLOURS[this.usage.images % COLOURS.length];
    const file = join(dir, `${name}.png`);
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=1024x1792`, '-frames:v', '1', file]);
    this.usage.images++;
    this.calls.push({ type: 'image', prompt });
    return file;
  }
}

export function mediaFromConfig(config, { fetchImpl } = {}) {
  return new MediaClient({ baseUrl: config.mediaBaseUrl, apiKey: config.mediaApiKey, ttsModel: config.ttsModel, voice: config.ttsVoice, imageModel: config.imageModel, fetchImpl });
}
