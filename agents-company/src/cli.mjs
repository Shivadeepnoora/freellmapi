#!/usr/bin/env node
// agents-company run     — one research cycle, then exit
// agents-company daemon  — run now, then every --interval (default 24h)
// agents-company memory  — print what the company remembers
import { parseArgs } from 'node:util';
import { loadConfig } from './config.mjs';
import { LLMClient } from './llm.mjs';
import { MockLLMClient } from './mock-llm.mjs';
import { CompanyMemory } from './memory.mjs';
import { Company } from './company.mjs';
import { writeReports } from './report.mjs';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    mock: { type: 'boolean' },
    focus: { type: 'string' },
    opportunities: { type: 'string', short: 'n' },
    concurrency: { type: 'string', short: 'c' },
    interval: { type: 'string' },
    model: { type: 'string' },
    'base-url': { type: 'string' },
    'data-dir': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0] ?? 'run';
if (values.help || !['run', 'daemon', 'memory'].includes(command)) {
  console.log(`Usage: agents-company <run|daemon|memory> [--mock] [--focus "..."] [-n 5] [-c 3] [--interval 24h] [--model auto] [--base-url URL] [--data-dir DIR]
Env: FREELLMAPI_BASE_URL, FREELLMAPI_API_KEY, AGENTS_MODEL, AGENTS_FOCUS, AGENTS_INTERVAL, AGENTS_MOCK=1`);
  process.exit(values.help ? 0 : 1);
}

const config = loadConfig({
  mock: values.mock,
  focus: values.focus,
  opportunities: values.opportunities,
  concurrency: values.concurrency,
  interval: values.interval,
  model: values.model,
  baseUrl: values['base-url'],
  dataDir: values['data-dir'],
});
const memory = new CompanyMemory(config.dataDir);

if (command === 'memory') {
  console.log(JSON.stringify({ runs: memory.state.runs.length, top: memory.topOpportunities(10) }, null, 2));
  process.exit(0);
}

if (!config.mock && !config.apiKey) {
  console.warn('Warning: FREELLMAPI_API_KEY is not set. Use the unified key from the FreeLLMAPI Keys page, or --mock for an offline demo.');
}

const llm = config.mock ? new MockLLMClient() : new LLMClient(config);
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

async function cycle() {
  const company = new Company({ llm, memory, config, log });
  const run = await company.run();
  const { md } = writeReports(run, config.dataDir);
  log(`Report written: ${md}`);
  run.ranked.slice(0, 3).forEach((r, i) => log(`  #${i + 1} ${r.name} (score ${r.totalScore})`));
  return run;
}

if (command === 'run') {
  cycle().catch((err) => { console.error(err); process.exit(1); });
} else {
  let running = false;
  const tick = async () => {
    if (running) return log('Previous cycle still running; skipping this tick');
    running = true;
    try { await cycle(); } catch (err) { log(`Cycle failed: ${err.message}`); } finally { running = false; }
  };
  log(`Daemon started; running every ${config.intervalMs / 1000}s`);
  await tick();
  const timer = setInterval(tick, config.intervalMs);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { clearInterval(timer); log('Daemon stopped'); process.exit(0); });
}
