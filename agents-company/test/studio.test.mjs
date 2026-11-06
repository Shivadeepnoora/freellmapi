import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { phrases, buildCaptions, toAss, escapeAss } from '../src/studio/captions.mjs';
import { Studio, normaliseScript, normaliseTopics, uploadMetadata } from '../src/studio/studio.mjs';
import { StudioMemory, performanceScore } from '../src/studio/memory.mjs';
import { MediaClient, MockMediaClient, imageExt, audioExt } from '../src/studio/media.mjs';
import { hasFfmpeg, videoInfo } from '../src/studio/ffmpeg.mjs';
import { SourceLibrary } from '../src/search.mjs';
import { MockLLMClient, MockSearchClient } from '../src/mock-llm.mjs';
import { ApprovalQueue } from '../src/approvals.mjs';
import { loadConfig, validateStudioConfig } from '../src/config.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'agents-studio-'));
const FFMPEG = await hasFfmpeg();
const noSleep = async () => {};

function libWith(n = 3) {
  const lib = new SourceLibrary();
  lib.add(Array.from({ length: n }, (_, i) => ({ title: `S${i + 1}`, url: `https://real.example/${i + 1}`, content: 'fact' })), 'q');
  return lib;
}

// ---- captions -----------------------------------------------------------------

test('captions: short phrases, timed across the spoken part of each scene, ASS-safe', () => {
  assert.deepEqual(phrases('Most students follow this rule, and it quietly fails them.'), ['Most students follow this', 'rule, and it quietly', 'fails them.']);
  const events = buildCaptions([{ narration: 'one two three four five six', start: 0, speech: 2 }, { narration: 'seven eight', start: 2.5, speech: 1 }]);
  assert.equal(events[0].start, 0);
  assert.ok(Math.abs(events[1].end - 2) < 1e-9, 'first scene captions end when speech ends');
  assert.equal(events[2].start, 2.5);
  assert.ok(Math.abs(events.at(-1).end - 3.5) < 1e-9);
  const ass = toAss([{ start: 61.239, end: 62.5, text: 'hi {\\b1}there\\N' }]);
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
  assert.match(ass, /Dialogue: 0,0:01:01\.24,0:01:02\.50,Caption,,0,0,0,,hi ／b1there／N/);
  assert.equal(escapeAss('a{b}c\nd'), 'abc d');
});

// ---- script and topic normalisation ----------------------------------------------

const scene = (words) => ({ narration: Array.from({ length: words }, (_, i) => `w${i}`).join(' '), visual: 'a calm desk' });

test('normaliseScript enforces Shorts length, scenes, title, hashtags and tags', () => {
  const lib = libWith();
  const ok = normaliseScript({ title: '  A   title ', scenes: [scene(20), scene(20), scene(20), scene(20)], tags: ['a,b', '#c', 'd'], hashtags: ['money', '#shorts', 'x y'], sources: ['S1', 'S9'] }, lib);
  assert.equal(ok.title, 'A title');
  assert.equal(ok.words, 80);
  assert.deepEqual(ok.hashtags, ['#shorts', '#money', '#xy']);
  assert.deepEqual(ok.tags, ['ab', 'c', 'd']);
  assert.deepEqual(ok.sources, ['S1']);
  assert.throws(() => normaliseScript({ title: 't', scenes: [scene(30), scene(30)] }, lib), /fewer than 3/);
  assert.throws(() => normaliseScript({ title: 't', scenes: [scene(10), scene(10), scene(10)] }, lib), /30 words/);
  assert.throws(() => normaliseScript({ title: 't', scenes: [scene(60), scene(60), scene(60)] }, lib), /180 words/);
  assert.throws(() => normaliseScript({ title: ' ', scenes: [scene(30), scene(30), scene(30)] }, lib), /no title/);
});

test('normaliseTopics drops topics already made and duplicates', () => {
  const topics = normaliseTopics({ topics: [{ topic: 'A', sources: ['S1', 'S7'] }, { topic: 'a' }, { topic: 'Old one' }, { topic: '' }, { topic: 'B' }] }, libWith(), ['old one']);
  assert.deepEqual(topics.map((t) => [t.topic, t.sources]), [['A', ['S1']], ['B', []]]);
});

test('upload metadata never publishes model-written URLs; it appends verified sources, your link and an AI note', () => {
  const lib = libWith();
  const script = { title: 'T', description: 'Useful point. See https://fake.example/x for more. Sources: https://fake.example/y', hashtags: ['#shorts'], tags: ['a'], scenes: [{ narration: 'n' }] };
  const meta = uploadMetadata(script, [lib.get('S2')], { channelLink: 'https://me.github.io/site/news/', channelCta: 'Free newsletter' });
  assert.ok(!meta.description.includes('fake.example'));
  assert.match(meta.description, /^Useful point\./);
  assert.match(meta.description, /Free newsletter: https:\/\/me\.github\.io\/site\/news\//);
  assert.match(meta.description, /Sources:\n- https:\/\/real\.example\/2/);
  assert.match(meta.description, /made with AI tools/);
  assert.match(meta.description, /#shorts$/);
});

// ---- memory and feedback ---------------------------------------------------------

test('StudioMemory records validated results and ranks videos by performance', () => {
  const m = new StudioMemory(tmp());
  m.addVideo({ slug: 'a', title: 'A', topic: 'ta' });
  m.addVideo({ slug: 'b', title: 'B', topic: 'tb' });
  m.addVideo({ slug: 'c', title: 'C', topic: 'tc' });
  assert.throws(() => m.recordResults('zzz', { views: 1 }), /No video/);
  assert.throws(() => m.recordResults('a', { views: -5 }), /non-negative/);
  assert.throws(() => m.recordResults('a', {}), /at least one/);
  m.recordResults('a', { views: '200', viewedPct: '40' });
  m.recordResults('b', { views: '5000', viewedPct: '85', subscribers: '30', youtubeUrl: 'https://youtube.com/shorts/x' });
  assert.deepEqual(m.ranked().map((v) => v.slug), ['b', 'a']);
  assert.equal(m.find('b').youtubeUrl, 'https://youtube.com/shorts/x');
  assert.match(m.summaryForPrompt(), /Best:\n- "B" \(topic: tb\): 5000 views, 85% viewed, \+30 subs/);
  assert.ok(performanceScore({ views: 1000, viewedPct: 90 }) > performanceScore({ views: 1000, viewedPct: 30 }));
  assert.match(new StudioMemory(tmp()).summaryForPrompt(), /No published results yet/);
});

// ---- media client ------------------------------------------------------------------

test('MediaClient: speech and image requests, real file types, URL images, retries', async () => {
  const dir = tmp();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
  const calls = [];
  let flaky = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, auth: init?.headers?.authorization });
    if (url.endsWith('/audio/speech')) {
      if (flaky++ === 0) return new Response('busy', { status: 503 });
      return new Response(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(200)]), { headers: { 'content-type': 'audio/wav' } });
    }
    if (url.endsWith('/images/generations')) {
      return calls.filter((c) => c.url.endsWith('/images/generations')).length === 1
        ? Response.json({ data: [{ b64_json: png.toString('base64') }] })
        : Response.json({ data: [{ url: 'https://cdn.example/img' }] });
    }
    if (url === 'https://cdn.example/img') return new Response(jpg);
    return new Response('nope', { status: 404 });
  };
  const media = new MediaClient({ baseUrl: 'http://h/v1/', apiKey: 'k', voice: 'nova', fetchImpl, sleep: noSleep });
  const audio = await media.speech('Hello there', dir, 'v1');
  assert.ok(audio.endsWith('v1.wav'));
  const speechCall = calls.find((c) => c.url === 'http://h/v1/audio/speech' && c.body);
  assert.deepEqual(speechCall.body, { model: 'auto', input: 'Hello there', voice: 'nova', response_format: 'mp3' });
  assert.equal(speechCall.auth, 'Bearer k');
  assert.ok((await media.image('a desk', dir, 'i1')).endsWith('i1.png'));
  assert.equal(calls.find((c) => c.url.endsWith('/images/generations')).body.size, '1024x1792');
  assert.ok((await media.image('a desk', dir, 'i2')).endsWith('i2.jpg'));
  assert.deepEqual(media.usage, { speech: 1, images: 2 });

  const bad = new MediaClient({ baseUrl: 'http://h', fetchImpl: async () => Response.json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] }), sleep: noSleep });
  await assert.rejects(bad.image('x', dir, 'bad'), /unsupported or corrupt/);
  const noAudio = new MediaClient({ baseUrl: 'http://h', retries: 0, fetchImpl: async () => new Response('denied', { status: 401 }), sleep: noSleep });
  await assert.rejects(noAudio.speech('x', dir, 'n'), /401/);
  assert.equal(imageExt(Buffer.from('RIFF0000WEBPxxxx')), 'webp');
  assert.equal(audioExt('audio/mpeg', Buffer.from('ID3xxxx')), 'mp3');
  assert.equal(audioExt('', Buffer.from('OggSxxxx')), 'ogg');
});

// ---- full studio run (real ffmpeg) --------------------------------------------------

const studioConfig = (dataDir, o = {}) => ({ dataDir, channelNiche: 'personal finance for students', channelName: 'Money Basics', channelLink: 'https://me.github.io/site/news/', channelCta: 'Free newsletter', studioVideos: 1, ...o });

test('a studio run produces an upload-ready vertical Short and queues it for review', { skip: !FFMPEG && 'ffmpeg not installed', timeout: 180_000 }, async () => {
  const dir = tmp();
  const llm = new MockLLMClient();
  const approvals = new ApprovalQueue(dir);
  const memory = new StudioMemory(dir);
  const studio = new Studio({ llm, media: new MockMediaClient({ wordsPerSecond: 12 }), search: new MockSearchClient(), memory, approvals, config: studioConfig(dir) });
  const r = await studio.run();

  assert.equal(r.videos.length, 1);
  const v = r.videos[0];
  const info = await videoInfo(v.videoPath);
  assert.deepEqual([info.width, info.height, info.video, info.audio], [1080, 1920, 'h264', 'aac']);
  assert.ok(info.duration > 3 && info.duration < 60, `duration ${info.duration}`);
  assert.deepEqual(readdirSync(v.dir).sort(), ['UPLOAD.md', 'captions.ass', 'cover.jpg', 'metadata.md', 'script.json', 'short.mp4'], 'intermediate files are cleaned up');
  const meta = readFileSync(join(v.dir, 'metadata.md'), 'utf8');
  assert.ok(!meta.includes('made-up.example'), 'model-written URL removed');
  assert.match(meta, /Free newsletter: https:\/\/me\.github\.io\/site\/news\//);
  assert.match(meta, /Sources:\n- https:\/\/example\.com\//);
  assert.match(readFileSync(join(v.dir, 'UPLOAD.md'), 'utf8'), /Altered or synthetic content/);
  assert.match(readFileSync(join(v.dir, 'captions.ass'), 'utf8'), /Dialogue: .*Most students follow this/);
  assert.ok(existsSync(join(r.dir, 'report.md')));

  const item = approvals.get(v.approval);
  assert.deepEqual([item.kind, item.platform, item.artifact, item.videoPath, item.status], ['publish_video', 'youtube', null, v.videoPath, 'pending']);
  assert.equal(memory.find(v.slug).title, v.title);
  assert.deepEqual(r.usage.media, { speech: 5, images: 5 });

  // The video file is never read or sent anywhere when the approval is executed.
  approvals.decide([item.id], 'approved');
  await approvals.dispatch({ webhookUrl: '' });
  assert.equal(approvals.get(item.id).status, 'manual');

  // Second run: does not repeat the topic, and the researcher sees recorded results.
  memory.recordResults(v.slug, { views: 1200, viewedPct: 78, subscribers: 9 });
  const llm2 = new MockLLMClient();
  const r2 = await new Studio({ llm: llm2, media: new MockMediaClient({ wordsPerSecond: 12 }), search: null, memory, approvals, config: studioConfig(dir) }).run();
  const researcher = llm2.calls.find((c) => c.system.includes('ROLE: topic_researcher'));
  assert.match(researcher.user, new RegExp(`Already made \\(do not repeat\\): ${v.topic.replace(/[/.]/g, '\\$&')}`));
  assert.match(researcher.user, /1200 views, 78% viewed, \+9 subs/);
  assert.notEqual(r2.videos[0].topic, v.topic);
  assert.notEqual(r2.videos[0].slug, v.slug);
});

test('a script the reviewer rejects twice is skipped, and a spare topic is used instead', { skip: !FFMPEG && 'ffmpeg not installed', timeout: 180_000 }, async () => {
  const dir = tmp();
  const llm = new MockLLMClient();
  const original = llm.chatJSON.bind(llm);
  let reviews = 0;
  llm.chatJSON = async (messages, o) => {
    if (messages[0].content.includes('ROLE: video_reviewer')) {
      reviews++;
      // Reject the first topic's draft and its rewrite; approve the next topic.
      if (reviews <= 2) return { approved: false, issues: ['claim about rent is not in the sources'], fix_instructions: 'remove it' };
    }
    return original(messages, o);
  };
  const r = await new Studio({ llm, media: new MockMediaClient({ wordsPerSecond: 12 }), memory: new StudioMemory(dir), config: studioConfig(dir) }).run();
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /rejected by the Standards Reviewer: claim about rent/);
  assert.equal(r.videos.length, 1);
  const rewrite = llm.calls.filter((c) => c.system.includes('ROLE: scriptwriter'))[1];
  assert.match(rewrite.user, /previous draft was rejected[\s\S]*claim about rent/);
});

// ---- configuration -----------------------------------------------------------------

test('studio configuration checks', () => {
  const env = { FREELLMAPI_API_KEY: 'u' };
  assert.ok(validateStudioConfig(loadConfig({}, env)).errors.some((e) => /channel niche/.test(e)));
  const dev = validateStudioConfig(loadConfig({ channelNiche: 'x' }, env));
  assert.deepEqual(dev.errors, []);
  assert.ok(dev.warnings.some((w) => /free tiers/.test(w)));
  assert.ok(dev.warnings.some((w) => /AGENTS_CHANNEL_LINK/.test(w)));
  assert.ok(validateStudioConfig(loadConfig({ channelNiche: 'x' }, { ...env, AGENTS_ENV: 'production' })).errors.some((e) => /AGENTS_MEDIA_BASE_URL/.test(e)));
  const paid = validateStudioConfig(loadConfig({ channelNiche: 'x' }, { ...env, AGENTS_ENV: 'production', AGENTS_MEDIA_BASE_URL: 'https://api.openai.com/v1', AGENTS_MEDIA_API_KEY: 'k', AGENTS_CHANNEL_LINK: 'https://x.co' }));
  assert.deepEqual([paid.errors, paid.warnings], [[], []]);
  assert.ok(validateStudioConfig(loadConfig({ channelNiche: 'x', studioVideos: '50' }, env)).errors.some((e) => /between 1 and 10/.test(e)));
});
