#!/usr/bin/env node
// agents-company run              research → decide → act (build deliverables, queue external actions)
// agents-company daemon           run now, then every --interval; also dispatches approved actions
// agents-company approvals        list actions waiting for a human decision
// agents-company approve <id|all> approve actions (optionally --note "...")
// agents-company reject <id|all>  reject actions
// agents-company execute          send approved actions to AGENTS_WEBHOOK_URL
// agents-company webhook-server   receive approved actions over HTTP and publish pages to GitHub Pages
// agents-company memory           print what the company remembers
// agents-company check            show the resolved LLM/search setup and any problems
import { parseArgs } from 'node:util';
import { loadConfig, validateConfig } from './config.mjs';
import { LLMClient } from './llm.mjs';
import { MockLLMClient, MockSearchClient } from './mock-llm.mjs';
import { searchFromConfig } from './search.mjs';
import { CompanyMemory } from './memory.mjs';
import { ApprovalQueue } from './approvals.mjs';
import { Company } from './company.mjs';
import { writeReports } from './report.mjs';
import { buildExecutors } from './executors/index.mjs';
import { publisherFromConfig } from './executors/github-pages.mjs';
import { createWebhookServer } from './executors/webhook-server.mjs';

const COMMANDS = ['run', 'daemon', 'approvals', 'approve', 'reject', 'execute', 'webhook-server', 'memory', 'check'];
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    mock: { type: 'boolean' },
    'no-act': { type: 'boolean' },
    'execute-top': { type: 'string' },
    focus: { type: 'string' },
    opportunities: { type: 'string', short: 'n' },
    concurrency: { type: 'string', short: 'c' },
    interval: { type: 'string' },
    model: { type: 'string' },
    'strong-model': { type: 'string' },
    provider: { type: 'string' },
    search: { type: 'string' },
    env: { type: 'string' },
    'base-url': { type: 'string' },
    'data-dir': { type: 'string' },
    webhook: { type: 'string' },
    'pages-repo': { type: 'string' },
    'pages-branch': { type: 'string' },
    port: { type: 'string' },
    note: { type: 'string' },
    all: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0] ?? 'run';
if (values.help || !COMMANDS.includes(command)) {
  console.log(`Usage: agents-company <${COMMANDS.join('|')}> [options]
  run/daemon: [--mock] [--no-act] [--execute-top 2] [--focus "..."] [-n 5] [-c 3] [--interval 24h]
              [--provider freellmapi|openai|openrouter|custom] [--model M] [--strong-model M] [--base-url URL]
              [--search auto|freellmapi|tavily|custom|off] [--env development|production]
  check:      validate the LLM / search setup without running anything
  approvals:  [--all]            approve/reject: <id...|all> [--note "..."]
  execute:    [--webhook URL] [--pages-repo owner/name] [--pages-branch gh-pages]
  webhook-server: [--port 8787] [--pages-repo owner/name] [--pages-branch gh-pages]
  common:     [--data-dir DIR]
Env: AGENTS_LLM_PROVIDER, AGENTS_LLM_BASE_URL, AGENTS_LLM_API_KEY, AGENTS_MODEL, AGENTS_STRONG_MODEL, AGENTS_ENV,
     FREELLMAPI_BASE_URL, FREELLMAPI_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, AGENTS_ALLOW_FREE_TIER=1,
     AGENTS_SEARCH, TAVILY_API_KEY, AGENTS_SEARCH_URL, AGENTS_SEARCH_API_KEY, AGENTS_SEARCH_QUERIES,
     AGENTS_PRICE_INPUT_PER_MTOK, AGENTS_PRICE_OUTPUT_PER_MTOK, AGENTS_FOCUS, AGENTS_INTERVAL, AGENTS_MOCK=1,
     AGENTS_ACT=0, AGENTS_EXECUTE_TOP, AGENTS_WEBHOOK_URL, AGENTS_WEBHOOK_SECRET, AGENTS_WEBHOOK_PORT,
     AGENTS_GITHUB_PAGES_REPO, AGENTS_GITHUB_PAGES_BRANCH, AGENTS_GITHUB_TOKEN (or GITHUB_TOKEN)`);
  process.exit(values.help ? 0 : 1);
}

const config = loadConfig({
  mock: values.mock,
  act: values['no-act'] ? false : undefined,
  executeTop: values['execute-top'],
  focus: values.focus,
  opportunities: values.opportunities,
  concurrency: values.concurrency,
  interval: values.interval,
  model: values.model,
  strongModel: values['strong-model'],
  provider: values.provider,
  search: values.search,
  environment: values.env,
  baseUrl: values['base-url'],
  dataDir: values['data-dir'],
  webhookUrl: values.webhook,
  githubPagesRepo: values['pages-repo'],
  githubPagesBranch: values['pages-branch'],
  port: values.port,
});
const memory = new CompanyMemory(config.dataDir);
const approvals = new ApprovalQueue(config.dataDir);
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const ids = positionals.slice(1);
let executors;
try {
  executors = buildExecutors(config, { log });
} catch (err) {
  console.error(`GitHub Pages is misconfigured: ${err.message}`);
  process.exit(1);
}
const dispatch = () => approvals.dispatch({ webhookUrl: config.webhookUrl, webhookSecret: config.webhookSecret, executors, log });

switch (command) {
  case 'memory':
    console.log(JSON.stringify({ runs: memory.state.runs.length, top: memory.topOpportunities(10), actions: memory.recentActions(10, approvals) }, null, 2));
    break;
  case 'approvals': {
    const items = values.all ? approvals.list() : approvals.list('pending');
    if (!items.length) console.log(values.all ? 'No actions yet.' : 'Nothing waiting for approval.');
    for (const i of items) {
      const cost = i.costUsd ? ` ($${i.costUsd})` : '';
      const details = i.details ? ` — ${i.details}` : '';
      const file = i.artifact ? `\n        file: ${i.artifact}` : '';
      const url = i.resultUrl ? `\n        live: ${i.resultUrl}` : '';
      const err = i.error ? `\n        error: ${i.error}` : '';
      console.log(`${i.id}  [${i.status}]  ${i.kind}${cost}  day ${i.day}  ${i.opportunity}\n        ${i.title}${details}${file}${url}${err}`);
    }
    break;
  }
  case 'approve':
  case 'reject': {
    if (!ids.length) {
      console.error(`Usage: agents-company ${command} <id...|all>`);
      process.exit(1);
    }
    try {
      const changed = approvals.decide(ids, command === 'approve' ? 'approved' : 'rejected', values.note);
      console.log(`${command === 'approve' ? 'Approved' : 'Rejected'} ${changed.length}: ${changed.map((c) => c.id).join(', ') || '(none pending)'}`);
      if (command === 'approve' && changed.length) console.log('Run `agents-company execute` to carry them out.');
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    break;
  }
  case 'execute':
    await dispatch();
    break;
  case 'webhook-server': {
    const publisher = executors.length ? publisherFromConfig(config, { log }) : null;
    let server;
    try {
      server = createWebhookServer({ publisher, secret: config.webhookSecret, log });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    server.listen(config.webhookPort, () => {
      log(`Webhook server listening on :${config.webhookPort} (GitHub Pages: ${publisher ? `${config.githubPagesRepo}@${config.githubPagesBranch}` : 'not configured'})`);
    });
    break;
  }
  case 'check': {
    const { errors, warnings } = validateConfig(config);
    const strong = config.strongModel ? ` · strong ${config.strongModel}` : '';
    const searchKey = config.searchApiKey ? 'set' : config.searchProvider === 'off' ? 'n/a' : 'missing';
    console.log(`Environment: ${config.environment}${config.mock ? ' (mock)' : ''}`);
    console.log(`LLM:    ${config.provider} · ${config.baseUrl || '(no URL)'} · model ${config.model || '(none)'}${strong} · key ${config.apiKey ? 'set' : 'missing'}`);
    console.log(`Search: ${config.searchProvider}${config.searchUrl ? ` · ${config.searchUrl}` : ''} · key ${searchKey}`);
    warnings.forEach((w) => console.log(`warning: ${w}`));
    errors.forEach((e) => console.log(`error:   ${e}`));
    if (!errors.length) console.log('OK');
    process.exit(errors.length ? 1 : 0);
  }
  default:
    await runOrDaemon();
}

async function runOrDaemon() {
  const { errors, warnings } = validateConfig(config);
  warnings.forEach((w) => console.warn(`Warning: ${w}`));
  if (errors.length) {
    errors.forEach((e) => console.error(`Error: ${e}`));
    process.exit(1);
  }
  const llm = config.mock ? new MockLLMClient() : new LLMClient(config);
  let search = null;
  if (config.mock) search = config.searchProvider === 'off' ? null : new MockSearchClient();
  else search = searchFromConfig(config);

  async function cycle() {
    const run = await new Company({ llm, memory, approvals, search, config, log }).run();
    const { md } = writeReports(run, config.dataDir);
    log(`Report written: ${md}`);
    run.ranked.slice(0, 3).forEach((r, i) => log(`  #${i + 1} ${r.name} (score ${r.totalScore}${r.verified === false ? ', unverified' : ''})`));
    const u = run.usage ?? {};
    const cost = u.estimatedCostUsd != null ? ` (~$${u.estimatedCostUsd})` : '';
    log(`Usage: ${u.calls ?? 0} LLM calls, ${(u.inputTokens ?? 0) + (u.outputTokens ?? 0)} tokens${cost}, ${u.searches ?? 0} searches, ${run.research?.sources.length ?? 0} sources`);
    const pending = approvals.list('pending').length;
    if (pending) log(`${pending} action(s) waiting for approval: run \`agents-company approvals\``);
    return run;
  }

  if (command === 'run') {
    try {
      await cycle();
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
    return;
  }

  let running = false;
  const tick = async () => {
    if (running) return log('Previous cycle still running; skipping this tick');
    running = true;
    try {
      await dispatch();
      await cycle();
    } catch (err) {
      log(`Cycle failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
  log(`Daemon started; running every ${config.intervalMs / 1000}s`);
  await tick();
  const timer = setInterval(tick, config.intervalMs);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      clearInterval(timer);
      log('Daemon stopped');
      process.exit(0);
    });
  }
}
