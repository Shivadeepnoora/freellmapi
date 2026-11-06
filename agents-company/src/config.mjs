// Runtime configuration. Everything can be set by env var or CLI flag.
export function loadConfig(overrides = {}) {
  const env = process.env;
  return {
    baseUrl: (overrides.baseUrl ?? env.FREELLMAPI_BASE_URL ?? 'http://localhost:3001/v1').replace(/\/$/, ''),
    apiKey: overrides.apiKey ?? env.FREELLMAPI_API_KEY ?? '',
    model: overrides.model ?? env.AGENTS_MODEL ?? 'auto',
    mock: overrides.mock ?? env.AGENTS_MOCK === '1',
    focus: overrides.focus ?? env.AGENTS_FOCUS ?? 'online income sources a solo founder can start with little capital',
    opportunities: Number(overrides.opportunities ?? env.AGENTS_OPPORTUNITIES ?? 5),
    concurrency: Number(overrides.concurrency ?? env.AGENTS_CONCURRENCY ?? 3),
    retries: Number(overrides.retries ?? env.AGENTS_RETRIES ?? 3),
    dataDir: overrides.dataDir ?? env.AGENTS_DATA_DIR ?? new URL('../data/', import.meta.url).pathname,
    intervalMs: parseInterval(overrides.interval ?? env.AGENTS_INTERVAL ?? '24h'),
  };
}

export function parseInterval(value) {
  if (typeof value === 'number') return value;
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(String(value).trim());
  if (!m) throw new Error(`Invalid interval "${value}" (use e.g. 30m, 6h, 1d)`);
  const unit = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] ?? 'ms'];
  return Number(m[1]) * unit;
}
