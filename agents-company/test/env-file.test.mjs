import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, loadEnvFile } from '../src/env-file.mjs';
import { parseEnv as parse } from '../src/env-file.mjs';
import { loadConfig } from '../src/config.mjs';

test('parseEnv handles comments, quotes, export prefixes and inline comments', () => {
  const env = parseEnv([
    '# a comment',
    '',
    'PLAIN=value',
    'SPACED = spaced value  # trailing comment',
    'export EXPORTED=yes',
    'DOUBLE="Acme <hi@acme.co>"',
    "SINGLE='keep # this'",
    'ESCAPED="line1\\nline2 \\"q\\""',
    'EMPTY=',
    'bad line without equals',
    '9BAD=no',
    'URL=https://x.co/a?b=1#frag',
  ].join('\r\n'));
  assert.deepEqual(env, {
    PLAIN: 'value',
    SPACED: 'spaced value',
    EXPORTED: 'yes',
    DOUBLE: 'Acme <hi@acme.co>',
    SINGLE: 'keep # this',
    ESCAPED: 'line1\nline2 "q"',
    EMPTY: '',
    URL: 'https://x.co/a?b=1#frag',
  });
});

test('loadEnvFile fills only unset variables, skips blanks, and reports names only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'A=from-file\nB=from-file\nC=\n');
  const env = { B: 'from-shell' };
  assert.deepEqual(loadEnvFile(file, env), ['A']);
  assert.deepEqual(env, { A: 'from-file', B: 'from-shell' });
  assert.deepEqual(loadEnvFile(join(dir, 'missing.env'), env), []);
});

test('.env.example parses cleanly and its defaults load into a valid config', () => {
  const example = fileURLToPath(new URL('../.env.example', import.meta.url));
  const vars = parse(readFileSync(example, 'utf8'));
  assert.equal(vars.AGENTS_CHANNEL_NICHE, 'personal finance for students');
  assert.equal(vars.AGENTS_YOUTUBE_PRIVACY, 'unlisted');
  assert.equal(vars.AGENTS_DAEMON_JOBS, 'studio');
  const env = {};
  loadEnvFile(example, env);
  assert.ok(!('FREELLMAPI_API_KEY' in env), 'blank placeholders are not loaded');
  const config = loadConfig({}, env);
  assert.deepEqual([config.channelNiche, config.youtubePrivacy, config.daemonJobs, config.studioVideos], ['personal finance for students', 'unlisted', ['studio'], 1]);
});

test('the default data folder is a real filesystem path on every OS', () => {
  const { dataDir } = loadConfig({}, {});
  assert.ok(!dataDir.startsWith('file:'));
  assert.ok(!/^\/[A-Za-z]:/.test(dataDir), 'no "/C:/…" style paths');
  assert.match(dataDir.replace(/\\/g, '/'), /agents-company\/data\/?$/);
});
