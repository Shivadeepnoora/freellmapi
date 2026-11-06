// Burned-in captions in ASS format: short 2–4 word phrases, big bold text with
// an outline, centred in the lower third (clear of YouTube's Shorts UI). Each
// scene's narration is split into phrases timed in proportion to their length,
// which tracks real speech closely enough for short phrases.

const MAX_WORDS = 4;

export function phrases(text) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const out = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    const endsSentence = /[.!?…:;,]$/.test(w);
    if (cur.length >= MAX_WORDS || (endsSentence && cur.length >= 2)) {
      out.push(cur.join(' '));
      cur = [];
    }
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}

// scenes: [{narration, start, speech}] with times in seconds; captions only
// cover the spoken part (speech), not the silent padding after it.
export function buildCaptions(scenes) {
  const events = [];
  for (const s of scenes) {
    const parts = phrases(s.narration);
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let t = s.start;
    for (const p of parts) {
      const d = (s.speech * p.length) / total;
      events.push({ start: t, end: t + d, text: p });
      t += d;
    }
  }
  return events;
}

export function toAss(events, { font = 'Inter', size = 84 } = {}) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${font},${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,2,2,90,90,560,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = events.map((e) => `Dialogue: 0,${ts(e.start)},${ts(e.end)},Caption,,0,0,0,,${escapeAss(e.text)}`);
  return `${header}${lines.join('\n')}\n`;
}

// ASS treats {…} as override tags and backslashes as escapes; neutralise both
// so narration text can never restyle or break the subtitle file.
export function escapeAss(text) {
  return String(text).replace(/\\/g, '／').replace(/[{}]/g, '').replace(/\r?\n/g, ' ');
}

function ts(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}
