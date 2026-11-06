// Loads settings from agents-company/.env (or AGENTS_ENV_FILE) so you can keep
// them in one file instead of typing exports. Variables already set in the
// shell always win. Format: KEY=value per line; # starts a comment; values may
// be wrapped in "double" or 'single' quotes.
import { existsSync, readFileSync } from 'node:fs';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!m || !KEY_RE.test(m[1])) continue;
    let value = m[2];
    const q = value[0];
    if ((q === '"' || q === "'") && value.lastIndexOf(q) > 0) {
      value = value.slice(1, value.lastIndexOf(q));
      if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, '').trim(); // inline comment after an unquoted value
    }
    out[m[1]] = value;
  }
  return out;
}

// Returns the names that were loaded (never the values).
export function loadEnvFile(file, env = process.env) {
  if (!file || !existsSync(file)) return [];
  const loaded = [];
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (env[k] !== undefined || v === '') continue;
    env[k] = v;
    loaded.push(k);
  }
  return loaded;
}
