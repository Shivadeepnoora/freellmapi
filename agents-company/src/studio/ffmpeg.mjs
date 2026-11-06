// ffmpeg helpers for building vertical Shorts (1080×1920, 30 fps, H.264/AAC).
// Commands run through execFile with argument arrays (no shell), so titles or
// prompts can never be interpreted as shell syntax.
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const WIDTH = 1080;
export const HEIGHT = 1920;
export const FPS = 30;

export function run(cmd, args, { cwd, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || err.message).trim().split('\n').slice(-6).join('\n');
        reject(new Error(`${cmd} failed: ${tail}`));
      } else resolve({ stdout, stderr });
    });
  });
}

export async function hasFfmpeg() {
  try {
    await run('ffmpeg', ['-hide_banner', '-version'], { timeoutMs: 10_000 });
    await run('ffprobe', ['-hide_banner', '-version'], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function probeDuration(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = Number(String(stdout).trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`could not read the duration of ${file}`);
  return d;
}

// One scene: a still image with a slow zoom ("Ken Burns"), exactly `seconds` long.
export async function renderScene({ image, seconds, out, zoomIn = true }) {
  const frames = Math.max(1, Math.ceil(seconds * FPS));
  const zoom = zoomIn ? `min(zoom+0.0007,1.12)` : `if(eq(on,0),1.12,max(zoom-0.0007,1.0))`;
  const vf = [
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase`,
    `crop=${WIDTH}:${HEIGHT}`,
    `scale=${WIDTH * 2}:${HEIGHT * 2}`,
    `zoompan=z='${zoom}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${WIDTH}x${HEIGHT}:fps=${FPS}`,
    'format=yuv420p',
  ].join(',');
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', image, '-vf', vf, '-frames:v', String(frames),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-r', String(FPS), out]);
  return out;
}

// Joins scene videos, joins the narration clips (each padded to its scene's
// length), burns in the captions, and writes the final Short.
export async function assembleShort({ dir, scenes, captionsFile, out = 'short.mp4' }) {
  writeFileSync(join(dir, 'scenes.txt'), scenes.map((s) => `file '${s.video.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  // Audio: pad every narration clip to its scene length so voice and picture stay in sync.
  const audioArgs = scenes.flatMap((s) => ['-i', s.audio]);
  const pads = scenes.map((s, i) => `[${i}:a]aresample=44100,aformat=channel_layouts=stereo,apad=whole_dur=${s.seconds.toFixed(3)}[a${i}]`);
  const concat = `${scenes.map((_, i) => `[a${i}]`).join('')}concat=n=${scenes.length}:v=0:a=1[aout]`;
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...audioArgs, '-filter_complex', [...pads, concat].join(';'),
    '-map', '[aout]', '-c:a', 'aac', '-b:a', '160k', 'narration.m4a'], { cwd: dir });
  // Video + captions + audio. Relative file names (cwd = dir) avoid filter-path escaping.
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'scenes.txt', '-i', 'narration.m4a',
    '-vf', `ass=${captionsFile}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'copy', '-shortest', '-movflags', '+faststart', out], { cwd: dir });
  return join(dir, out);
}

export async function extractCover(video, out) {
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', video, '-frames:v', '1', '-q:v', '3', out]);
  return out;
}

export async function videoInfo(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-show_entries', 'format=duration', '-of', 'json', file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return { duration: Number(j.format.duration), width: v?.width, height: v?.height, video: v?.codec_name, audio: a?.codec_name ?? null };
}
