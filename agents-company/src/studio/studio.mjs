// YouTube Shorts studio: research → script → standards review → voiceover and
// visuals → ffmpeg assembly with captions → upload-ready package → your
// approval queue. Uploading is manual for now; you record each video's
// results with `studio-results` and the next topics follow what performed.
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TOPIC_RESEARCHER, SCRIPTWRITER, REVIEWER } from './roles.mjs';
import { SourceLibrary, gather } from '../search.mjs';
import { slugify } from '../execution.mjs';
import { probeDuration, renderScene, assembleShort, extractCover, videoInfo } from './ffmpeg.mjs';
import { buildCaptions, toAss } from './captions.mjs';

const VISUAL_STYLE = ', vertical 9:16 composition, high detail, soft cinematic lighting, no text, no letters, no logos, no watermark';
const SCENE_PAD = 0.35; // breathing room after each line
const END_PAD = 0.8;    // a beat after the last line

export class Studio {
  constructor({ llm, media, search = null, memory, approvals = null, config, log = () => {} }) {
    Object.assign(this, { llm, media, search, memory, approvals, config, log });
  }

  async run() {
    const { channelNiche: niche, studioVideos: count } = this.config;
    if (!niche) throw new Error('Set the channel niche (AGENTS_CHANNEL_NICHE or --niche)');
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const runDir = join(this.config.dataDir, 'workspace', 'studio', runId);
    mkdirSync(runDir, { recursive: true });
    this.llm.takeUsage?.();
    const searchesBefore = this.search?.count ?? 0;
    const library = new SourceLibrary();

    // 1. Research the niche
    if (this.search) {
      const year = new Date().getFullYear();
      const queries = [`${niche} surprising facts`, `${niche} common mistakes`, `${niche} new research ${year}`, `${niche} questions people ask`];
      this.log(`[Topic Researcher] searching the web for "${niche}"`);
      await gather(this.search, library, queries, { concurrency: 2, log: this.log });
    }
    const made = this.memory.topicsMade();
    const reply = await this.llm.chatJSON([
      { role: 'system', content: TOPIC_RESEARCHER.system },
      { role: 'user', content: `Channel niche: ${niche}\nReturn exactly ${count * 2} topics (spares in case some fail review).` +
        (made.length ? `\nAlready made (do not repeat): ${made.join('; ')}` : '') +
        `\n\n${this.memory.summaryForPrompt()}\n\n${library.toPrompt()}` },
    ], { tier: 'strong' });
    const topics = normaliseTopics(reply, library, made);
    if (!topics.length) throw new Error('Topic Researcher returned no usable topics');
    this.log(`[Topic Researcher] ${topics.length} topics: ${topics.map((t) => t.topic).join(' | ')}`);

    // 2. Make videos until we have enough (spares cover rejected scripts)
    const videos = [];
    const skipped = [];
    for (const topic of topics) {
      if (videos.length >= count) break;
      try {
        videos.push(await this.#makeVideo(topic, library, runDir));
      } catch (err) {
        skipped.push({ topic: topic.topic, reason: err.message });
        this.log(`[Studio] skipped "${topic.topic}": ${err.message}`);
      }
    }

    const usage = { ...(this.llm.takeUsage?.() ?? {}), searches: (this.search?.count ?? 0) - searchesBefore, media: { ...this.media.usage } };
    const result = { runId, niche, dir: runDir, videos, skipped, usage, sources: library.all().map(({ id, title, url }) => ({ id, title, url })) };
    writeFileSync(join(runDir, 'report.md'), studioReport(result));
    return result;
  }

  async #makeVideo(topic, library, runDir) {
    // Targeted evidence for this topic
    let evidence = topic.sources.map((id) => library.get(id));
    if (this.search) {
      const hits = await gather(this.search, library, [`${topic.topic} facts`, `${topic.topic} statistics study`], { concurrency: 2, log: this.log });
      evidence = [...new Map([...evidence, ...hits].filter(Boolean).map((s) => [s.id, s])).values()];
    }
    const sourcesPrompt = library.toPrompt(evidence);
    const brief = `Channel: ${this.config.channelName || '(faceless Shorts channel)'}\nNiche: ${this.config.channelNiche}\nTopic: ${topic.topic}\nAngle: ${topic.angle}`;

    // Script, then standards review with one rewrite
    this.log(`[Scriptwriter] "${topic.topic}"`);
    let script = await this.#write(brief, sourcesPrompt, library);
    let review = await this.#review(script, sourcesPrompt);
    if (!review.approved) {
      this.log(`[Standards Reviewer] sent back: ${review.issues.join('; ')}`);
      script = await this.#write(`${brief}\n\nYour previous draft was rejected. Fix these issues:\n- ${review.issues.join('\n- ')}\n${review.fix_instructions ?? ''}\n\nPrevious draft:\n${JSON.stringify(script)}`, sourcesPrompt, library);
      review = await this.#review(script, sourcesPrompt);
      if (!review.approved) throw new Error(`rejected by the Standards Reviewer: ${review.issues.join('; ')}`);
    }
    this.log(`[Standards Reviewer] approved "${script.title}"`);

    // Production
    const slug = uniqueSlug(slugify(script.title), (s) => existsSync(join(runDir, s)) || Boolean(this.memory.find(s)));
    const dir = join(runDir, slug);
    mkdirSync(dir, { recursive: true });
    this.log(`[Producer] voiceover and visuals for ${script.scenes.length} scenes`);
    const temp = [];
    const scenes = [];
    let start = 0;
    for (const [i, scene] of script.scenes.entries()) {
      const audio = await this.media.speech(scene.narration, dir, `scene-${i + 1}-voice`);
      const image = await this.media.image(scene.visual + VISUAL_STYLE, dir, `scene-${i + 1}-image`);
      const speech = await probeDuration(audio);
      const seconds = speech + (i === script.scenes.length - 1 ? END_PAD : SCENE_PAD);
      const video = await renderScene({ image, seconds, out: join(dir, `scene-${i + 1}.mp4`), zoomIn: i % 2 === 0 });
      temp.push(audio, image, video);
      scenes.push({ narration: scene.narration, audio, video, seconds, speech, start });
      start += seconds;
    }
    writeFileSync(join(dir, 'captions.ass'), toAss(buildCaptions(scenes)));
    const videoPath = await assembleShort({ dir, scenes, captionsFile: 'captions.ass' });
    const coverPath = await extractCover(videoPath, join(dir, 'cover.jpg'));
    const info = await videoInfo(videoPath);
    for (const f of [...temp, join(dir, 'scenes.txt'), join(dir, 'narration.m4a')]) if (existsSync(f)) unlinkSync(f);
    this.log(`[Producer] ${slug}/short.mp4: ${info.duration.toFixed(1)}s ${info.width}x${info.height}`);

    // Package for upload
    const sources = script.sources.map((id) => library.get(id)).filter(Boolean);
    const metadata = uploadMetadata(script, sources, this.config);
    writeFileSync(join(dir, 'script.json'), JSON.stringify({ ...script, sources: sources.map(({ id, title, url }) => ({ id, title, url })), topic }, null, 2));
    writeFileSync(join(dir, 'metadata.md'), metadata.markdown);
    writeFileSync(join(dir, 'UPLOAD.md'), uploadChecklist(metadata, info));

    const video = { slug, title: script.title, topic: topic.topic, angle: topic.angle, duration: Math.round(info.duration * 10) / 10, dir, videoPath, coverPath };
    this.memory.addVideo({ slug, title: script.title, topic: topic.topic, angle: topic.angle, duration: video.duration, dir });
    if (this.approvals) {
      const item = this.approvals.add({
        kind: 'publish_video',
        platform: 'youtube',
        opportunity: this.config.channelName || 'YouTube channel',
        title: `YouTube Short: ${script.title}`,
        details: `${video.duration}s vertical Short. Watch it, then upload by hand using UPLOAD.md.`,
        videoPath,
        coverPath,
        uploadGuide: join(dir, 'UPLOAD.md'),
        slug,
        artifact: null, // video files are not sent to executors or webhooks
      });
      video.approval = item.id;
    }
    return video;
  }

  async #write(brief, sourcesPrompt, library) {
    const raw = await this.llm.chatJSON([
      { role: 'system', content: SCRIPTWRITER.system },
      { role: 'user', content: `${brief}\n\n${sourcesPrompt}` },
    ], { tier: 'strong', temperature: 0.8, maxTokens: 2000 });
    return normaliseScript(raw, library);
  }

  async #review(script, sourcesPrompt) {
    const r = await this.llm.chatJSON([
      { role: 'system', content: REVIEWER.system },
      { role: 'user', content: `Script:\n${JSON.stringify(script, null, 2)}\n\n${sourcesPrompt}` },
    ], { temperature: 0.1 });
    return { approved: r?.approved === true, issues: Array.isArray(r?.issues) ? r.issues.filter(Boolean).map(String) : [], fix_instructions: r?.fix_instructions ?? '' };
  }
}

export function normaliseTopics(reply, library, made = []) {
  const list = Array.isArray(reply) ? reply : reply?.topics ?? [];
  const seen = new Set(made.map((t) => t.toLowerCase()));
  return list
    .filter((t) => typeof t?.topic === 'string' && t.topic.trim())
    .map((t) => ({ topic: t.topic.trim().slice(0, 140), angle: String(t.angle ?? '').trim().slice(0, 300), why: String(t.why_it_works ?? ''), sources: library.validIds(t.sources) }))
    .filter((t) => !seen.has(t.topic.toLowerCase()) && seen.add(t.topic.toLowerCase()));
}

export function normaliseScript(raw, library) {
  const scenes = (Array.isArray(raw?.scenes) ? raw.scenes : [])
    .map((s) => ({ narration: String(s?.narration ?? '').replace(/\s+/g, ' ').trim(), visual: String(s?.visual ?? '').replace(/\s+/g, ' ').trim().slice(0, 600) }))
    .filter((s) => s.narration && s.visual)
    .slice(0, 8);
  if (scenes.length < 3) throw new Error('script has fewer than 3 usable scenes');
  const words = scenes.reduce((n, s) => n + s.narration.split(' ').length, 0);
  if (words < 45 || words > 170) throw new Error(`script narration is ${words} words; a 30-55 second Short needs about 70-140`);
  const title = String(raw?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!title) throw new Error('script has no title');
  const tags = (Array.isArray(raw?.tags) ? raw.tags : []).map((t) => String(t).replace(/[<>,#]/g, '').trim()).filter(Boolean).slice(0, 10);
  const hashtags = [...new Set(['#shorts', ...(Array.isArray(raw?.hashtags) ? raw.hashtags : [])
    .map((h) => `#${String(h).replace(/[^\p{L}\p{N}_]/gu, '')}`).filter((h) => h.length > 1)])].slice(0, 3);
  return { title, hook: String(raw?.hook ?? scenes[0].narration), scenes, words, description: String(raw?.description ?? '').trim(), tags, hashtags, sources: library.validIds(raw?.sources) };
}

// Upload text. Model-written URLs are removed from the description and the
// verified source URLs are appended instead, so no invented link is published.
export function uploadMetadata(script, sources, config) {
  const description = script.description
    .replace(/[^.!?\n]*https?:\/\/\S+[^.!?\n]*[.!?]?/g, '') // drop whole sentences that carry a model-written URL
    .replace(/^\s*sources?:.*$/gim, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const parts = [description];
  if (config.channelLink) parts.push(`${config.channelCta || 'More'}: ${config.channelLink}`);
  if (sources.length) parts.push(`Sources:\n${sources.map((s) => `- ${s.url}`).join('\n')}`);
  parts.push('Narration and visuals were made with AI tools and reviewed before publishing.');
  parts.push(script.hashtags.join(' '));
  const fullDescription = parts.filter(Boolean).join('\n\n').slice(0, 4900);
  const markdown = `# ${script.title}\n\n## Title\n\n${script.title}\n\n## Description\n\n${fullDescription}\n\n## Tags\n\n${script.tags.join(', ')}\n\n## Script\n\n${script.scenes.map((s, i) => `${i + 1}. ${s.narration}`).join('\n')}\n`;
  return { title: script.title, description: fullDescription, tags: script.tags, markdown };
}

export function uploadChecklist(meta, info) {
  return `# Upload checklist

1. Watch \`short.mp4\` all the way through (${info.duration.toFixed(1)}s, ${info.width}×${info.height}). Check the facts, the captions and the voice.
2. In YouTube Studio: **Create → Upload videos** and pick \`short.mp4\`. Vertical videos up to 3 minutes are published as Shorts.
3. **Title:** copy from \`metadata.md\`.
4. **Description:** copy from \`metadata.md\`. It includes the verified sources and an AI note.
5. **Audience:** "No, it's not made for kids" unless it really is.
6. **Altered or synthetic content:** choose **Yes** if any visual looks like a real person, place or event that didn't happen. Realistic AI content must be disclosed.
7. **Tags** (Show more): ${meta.tags.join(', ') || '(none)'}
8. Publish, or schedule it. Afterwards, record results with:
   \`node src/cli.mjs studio-results <slug> --views N --viewed-pct N --subscribers N\`
`;
}

function studioReport(r) {
  const lines = [`# Studio run ${r.runId}`, ``, `Niche: ${r.niche}`, ``, `## Videos ready for review (${r.videos.length})`, ``];
  for (const v of r.videos) lines.push(`- **${v.title}** (${v.duration}s): \`${v.videoPath}\`${v.approval ? ` · approval ${v.approval}` : ''}`);
  if (r.skipped.length) lines.push(``, `## Skipped`, ``, ...r.skipped.map((s) => `- ${s.topic}: ${s.reason}`));
  if (r.sources.length) lines.push(``, `## Sources`, ``, ...r.sources.map((s) => `- ${s.id} ${s.url}`));
  const u = r.usage;
  lines.push(``, `## Usage`, ``, `- LLM calls: ${u.calls ?? 0}, tokens: ${(u.inputTokens ?? 0) + (u.outputTokens ?? 0)}${u.estimatedCostUsd != null ? ` (~$${u.estimatedCostUsd})` : ''}`, `- Voiceover clips: ${u.media.speech}, images: ${u.media.images}, searches: ${u.searches}`, ``);
  return lines.join('\n');
}

// Slugs identify videos in studio-results, so they must be unique across runs.
function uniqueSlug(base, taken) {
  const root = base || 'short';
  let slug = root;
  for (let i = 2; taken(slug); i++) slug = `${root}-${i}`;
  return slug;
}
