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
// agents-company results          live views, signups and verdicts for every launched page
// agents-company signups          signup counts; --export [page] prints CSV, --delete <email> erases
// agents-company email-test <to>  send one test email through Resend to check the setup
// agents-company studio           make YouTube Shorts: research, script, review, voice, visuals, video
// agents-company studio-list      videos made, with recorded results
// agents-company studio-results <slug> --views N …   record a video's YouTube Studio numbers
import { parseArgs } from 'node:util';
import { Studio } from './studio/studio.mjs';
import { StudioMemory } from './studio/memory.mjs';
import { MockMediaClient, mediaFromConfig } from './studio/media.mjs';
import { hasFfmpeg } from './studio/ffmpeg.mjs';
import { startAuth, finishAuth, waitForRedirect } from './youtube/oauth.mjs';
import { mailerFromConfig } from './email/resend.mjs';
import { welcomeEmail } from './email/templates.mjs';
import { loadConfig, validateConfig, validateStudioConfig, validateYouTubeConfig, youtubeAnalyticsGranted, signupOrigins, daemonPlan } from './config.mjs';
import { Scheduler, isDue } from './scheduler.mjs';
import { createStudioJob } from './studio/schedule.mjs';
import { analyticsFromConfig, syncStudioStats } from './youtube/analytics.mjs';
import { MetricsStore, metricsFromConfig } from './feedback/metrics.mjs';
import { collectResults } from './feedback/traction.mjs';
import { LLMClient } from './llm.mjs';
import { MockLLMClient, MockSearchClient } from './mock-llm.mjs';
import { searchFromConfig } from './search.mjs';
import { CompanyMemory } from './memory.mjs';
import { ApprovalQueue } from './approvals.mjs';
import { Company } from './company.mjs';
import { writeReports } from './report.mjs';
import { buildExecutors, siteFromConfig } from './executors/index.mjs';
import { publisherFromConfig } from './executors/github-pages.mjs';
import { createWebhookServer } from './executors/webhook-server.mjs';

const COMMANDS = ['run', 'daemon', 'approvals', 'approve', 'reject', 'execute', 'webhook-server', 'memory', 'check', 'results', 'signups', 'email-test', 'studio', 'studio-list', 'studio-results', 'studio-sync', 'youtube-auth'];
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    mock: { type: 'boolean' },
    'no-act': { type: 'boolean' },
    'execute-top': { type: 'string' },
    'signup-url': { type: 'string' },
    export: { type: 'boolean' },
    delete: { type: 'string' },
    niche: { type: 'string' },
    videos: { type: 'string' },
    views: { type: 'string' },
    likes: { type: 'string' },
    comments: { type: 'string' },
    subscribers: { type: 'string' },
    'viewed-pct': { type: 'string' },
    'avg-view-seconds': { type: 'string' },
    url: { type: 'string' },
    redirect: { type: 'string' },
    privacy: { type: 'string' },
    jobs: { type: 'string' },
    'studio-every': { type: 'string' },
    check: { type: 'string' },
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
  daemon:     [--jobs company,studio] [--studio-every 24h] [--check 10m]   runs whatever is due, forever
  run/daemon: [--mock] [--no-act] [--execute-top 2] [--focus "..."] [-n 5] [-c 3] [--interval 24h]
              [--provider freellmapi|openai|openrouter|custom] [--model M] [--strong-model M] [--base-url URL]
              [--search auto|freellmapi|tavily|custom|off] [--env development|production]
  check:      validate the LLM / search setup without running anything
  approvals:  [--all]            approve/reject: <id...|all> [--note "..."]
  execute:    [--webhook URL] [--pages-repo owner/name] [--pages-branch gh-pages]
  webhook-server: [--port 8787] [--pages-repo owner/name] [--pages-branch gh-pages] [--signup-url URL]
  results:    live views, signups, conversion and verdict per launched page
  signups:    counts per page; [--export] [page] prints CSV with emails; [--delete email] erases a person
  email-test: <to-address>  send one test email through Resend
  studio:     [--niche "..."] [--videos 2] [--mock]   make YouTube Shorts for review
  youtube-auth: connect YouTube once (opens Google consent); [--redirect URL] to finish on a headless server
  studio-sync: pull views, retention and subscribers for uploaded Shorts from YouTube Analytics now
  execute:    also uploads approved Shorts to YouTube when connected; [--privacy public|unlisted|private]
  studio-list / studio-results <slug> [--views N] [--likes N] [--comments N] [--subscribers N]
              [--viewed-pct N] [--avg-view-seconds N] [--url https://youtube.com/shorts/…]
  common:     [--data-dir DIR]
Env: AGENTS_LLM_PROVIDER, AGENTS_LLM_BASE_URL, AGENTS_LLM_API_KEY, AGENTS_MODEL, AGENTS_STRONG_MODEL, AGENTS_ENV,
     FREELLMAPI_BASE_URL, FREELLMAPI_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, AGENTS_ALLOW_FREE_TIER=1,
     AGENTS_SEARCH, TAVILY_API_KEY, AGENTS_SEARCH_URL, AGENTS_SEARCH_API_KEY, AGENTS_SEARCH_QUERIES,
     AGENTS_PRICE_INPUT_PER_MTOK, AGENTS_PRICE_OUTPUT_PER_MTOK, AGENTS_FOCUS, AGENTS_INTERVAL, AGENTS_MOCK=1,
     AGENTS_ACT=0, AGENTS_EXECUTE_TOP, AGENTS_WEBHOOK_URL, AGENTS_WEBHOOK_SECRET, AGENTS_WEBHOOK_PORT,
     AGENTS_GITHUB_PAGES_REPO, AGENTS_GITHUB_PAGES_BRANCH, AGENTS_GITHUB_TOKEN (or GITHUB_TOKEN),
     AGENTS_SIGNUP_URL, AGENTS_SIGNUP_ALLOWED_ORIGINS, AGENTS_BUSINESS_NAME, AGENTS_CONTACT_EMAIL,
     AGENTS_TRUST_PROXY=1, AGENTS_METRICS_SOURCE=local, AGENTS_MIN_VIEWS, AGENTS_TARGET_CONVERSION,
     RESEND_API_KEY, AGENTS_EMAIL_FROM, AGENTS_EMAIL_REPLY_TO, AGENTS_POSTAL_ADDRESS, AGENTS_DOUBLE_OPT_IN=0,
     AGENTS_EMAIL_MAX_RECIPIENTS, AGENTS_CHANNEL_NICHE, AGENTS_CHANNEL_NAME, AGENTS_CHANNEL_LINK, AGENTS_CHANNEL_CTA,
     AGENTS_STUDIO_VIDEOS, AGENTS_MEDIA_BASE_URL, AGENTS_MEDIA_API_KEY, AGENTS_TTS_MODEL, AGENTS_TTS_VOICE, AGENTS_IMAGE_MODEL,
     YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN, AGENTS_YOUTUBE_PRIVACY, AGENTS_YOUTUBE_SYNTHETIC=0,
     AGENTS_YOUTUBE_AUTH_PORT, AGENTS_YOUTUBE_ANALYTICS=0, AGENTS_DAEMON_JOBS, AGENTS_DAEMON_CHECK, AGENTS_STUDIO_EVERY,
     AGENTS_STUDIO_MAX_PENDING`);
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
  signupUrl: values['signup-url'],
  channelNiche: values.niche,
  studioVideos: values.videos,
  youtubePrivacy: values.privacy,
  jobs: values.jobs,
  studioEvery: values['studio-every'],
  check: values.check,
});
const memory = new CompanyMemory(config.dataDir);
const approvals = new ApprovalQueue(config.dataDir);
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const ids = positionals.slice(1);
let executors;
try {
  executors = buildExecutors(config, { log });
} catch (err) {
  console.error(`Setup error: ${err.message}`);
  process.exit(1);
}
const dispatch = () => approvals.dispatch({ webhookUrl: config.webhookUrl, webhookSecret: config.webhookSecret, executors, log });

// Everything the studio needs before it can make videos. The studio doesn't
// publish pages, so page/signup/email checks are left out.
async function studioChecks() {
  const base = validateConfig(config);
  const studioCheck = validateStudioConfig(config);
  const errors = [...base.errors.filter((e) => !/SIGNUP|POSTAL|CONTACT_EMAIL|EMAIL_FROM/.test(e)), ...studioCheck.errors];
  const warnings = [...base.warnings.filter((w) => !/SIGNUP|RESEND|POSTAL|CONTACT/.test(w)), ...studioCheck.warnings];
  if (!(await hasFfmpeg())) errors.push('ffmpeg and ffprobe are required to build videos (e.g. apt-get install ffmpeg, or brew install ffmpeg).');
  return { errors, warnings };
}

function makeStudio() {
  return new Studio({
    llm: config.mock ? new MockLLMClient() : new LLMClient(config),
    media: config.mock ? new MockMediaClient() : mediaFromConfig(config),
    search: config.mock ? (config.searchProvider === 'off' ? null : new MockSearchClient()) : searchFromConfig(config),
    memory: new StudioMemory(config.dataDir),
    approvals,
    config,
    syncStats: config.mock ? null : () => syncYouTube(),
    log,
  });
}

// Pulls YouTube Analytics stats into studio memory. Quietly does nothing when
// YouTube or analytics isn't set up, unless `required` (studio-sync).
async function syncYouTube({ required = false } = {}) {
  const analytics = analyticsFromConfig(config);
  if (!analytics) {
    if (!required) return { updated: [], waiting: [], uploaded: 0 };
    if (!config.youtubeAutoUpload) throw new Error('YouTube is not connected: set YOUTUBE_CLIENT_ID and run `youtube-auth`');
    if (!config.youtubeAnalytics) throw new Error('analytics is turned off (AGENTS_YOUTUBE_ANALYTICS=0)');
    throw new Error('the saved sign-in has no Analytics permission: run `youtube-auth` again and allow "View YouTube Analytics reports"');
  }
  return syncStudioStats({ analytics, memory: new StudioMemory(config.dataDir), log });
}

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
      const file = i.artifact ? `\n        file: ${i.artifact}` : i.videoPath ? `\n        watch: ${i.videoPath}\n        upload guide: ${i.uploadGuide}` : '';
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
    // The server always stores signups locally, in its own data directory.
    const metrics = new MetricsStore(config.dataDir);
    const allowedOrigins = signupOrigins(config);
    let server;
    let mailer;
    try {
      mailer = mailerFromConfig(config);
      server = createWebhookServer({
        publisher, secret: config.webhookSecret, metrics, allowedOrigins, site: siteFromConfig(config), trustProxy: config.trustProxy,
        mailer, doubleOptIn: config.doubleOptIn, maxRecipients: config.emailMaxRecipients, log,
      });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    server.listen(config.webhookPort, () => {
      log(`Webhook server listening on :${config.webhookPort} (GitHub Pages: ${publisher ? `${config.githubPagesRepo}@${config.githubPagesBranch}` : 'not configured'})`);
      log(`Signups accepted from: ${allowedOrigins.join(', ') || 'nowhere (set AGENTS_GITHUB_PAGES_REPO or AGENTS_SIGNUP_ALLOWED_ORIGINS)'}`);
      if (publisher && !config.signupUrl) log('Warning: AGENTS_SIGNUP_URL is not set, so pages published from here will not collect signups.');
      if (mailer && config.signupUrl) log(`Email: Resend from ${config.emailFrom}; ${config.doubleOptIn ? 'double opt-in (confirmation email first)' : 'single opt-in (welcome email)'}`);
      else log('Email: off (set RESEND_API_KEY, AGENTS_EMAIL_FROM and AGENTS_SIGNUP_URL to email subscribers)');
    });
    break;
  }
  case 'results': {
    const metrics = metricsFromConfig(config);
    const results = await collectResults({ approvals, metrics, config, log });
    if (!results.length) {
      console.log('No launched pages yet. Approve and execute a "publish" action first.');
      break;
    }
    for (const r of results) {
      const score = r.tractionScore != null ? ` · traction ${r.tractionScore}/10` : '';
      console.log(`${r.verdict.toUpperCase().padEnd(15)} ${r.opportunity}\n    ${r.url}\n    ${r.daysLive} days live · ${r.views} views · ${r.signups} signups · ${(r.conversion * 100).toFixed(1)}%${score}`);
    }
    console.log(`\nVerdicts need at least ${config.minViews} views; traction 10 = ${(config.targetConversion * 100).toFixed(1)}% conversion or better.`);
    break;
  }
  case 'signups': {
    // Emails live only where the webhook-server runs; this reads that machine's data directory.
    const store = new MetricsStore(config.dataDir);
    if (values.delete) {
      const n = store.deleteEmail(values.delete);
      console.log(n ? `Deleted ${n} signup(s) for that address.` : 'No signups found for that address.');
    } else if (values.export) {
      const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).replace(/^([=+\-@])/, "'$1");
      console.log('page,email,consent,signed_up_at');
      for (const s of store.exportSignups(ids[0])) console.log([s.page, s.email, String(s.consent), s.at].map(csvCell).join(','));
    } else {
      const stats = await store.stats();
      const pages = Object.entries(stats);
      if (!pages.length) console.log('No signups or views recorded in this data directory.');
      for (const [page, s] of pages) {
        console.log(`${page.padEnd(40)} ${String(s.views).padStart(6)} views ${String(s.signups).padStart(5)} signups  (${s.confirmed} confirmed, ${s.pending} pending, ${s.unsubscribed} unsubscribed)`);
      }
    }
    break;
  }
  case 'studio': {
    const { errors, warnings } = await studioChecks();
    warnings.forEach((w) => console.warn(`Warning: ${w}`));
    if (errors.length) {
      errors.forEach((e) => console.error(`Error: ${e}`));
      process.exit(1);
    }
    const studio = makeStudio();
    try {
      const r = await studio.run();
      log(`Studio done: ${r.videos.length} video(s) ready, ${r.skipped.length} skipped. Report: ${r.dir}/report.md`);
      for (const v of r.videos) log(`  ${v.approval ?? ''} ${v.title} (${v.duration}s) → ${v.videoPath}`);
      if (r.videos.length) log('Watch each video, then follow its UPLOAD.md. Record results later with `studio-results <slug> --views N`.');
    } catch (err) {
      console.error(`Studio failed: ${err.message}`);
      process.exit(1);
    }
    break;
  }
  case 'studio-list': {
    const memoryS = new StudioMemory(config.dataDir);
    if (!memoryS.state.videos.length) console.log('No videos yet. Run `studio` first.');
    for (const v of memoryS.state.videos) {
      const r = v.results;
      const from = r?.source === 'youtube-analytics' ? ` (YouTube Analytics, ${String(r.at).slice(0, 10)})` : r ? ' (typed in)' : '';
      const stats = r ? `${r.views ?? '?'} views${r.viewedPct != null ? `, ${r.viewedPct}% viewed` : ''}${r.subscribers != null ? `, +${r.subscribers} subs` : ''}${from}` : v.videoId ? 'uploaded, waiting for analytics' : 'no results recorded';
      console.log(`${v.slug}\n    ${v.title} · ${v.duration}s · ${stats}${v.youtubeUrl ? ` · ${v.youtubeUrl}` : ''}`);
    }
    break;
  }
  case 'studio-sync': {
    try {
      const r = await syncYouTube({ required: true });
      if (!r.uploaded) console.log('No uploaded Shorts yet. Approve and execute a publish_video item first.');
      else console.log(`Updated ${r.updated.length} of ${r.uploaded} uploaded Short(s)${r.waiting.length ? `; waiting for data: ${r.waiting.join(', ')}` : ''}. See \`studio-list\`.`);
    } catch (err) {
      console.error(`YouTube Analytics sync failed: ${err.message}`);
      process.exit(1);
    }
    break;
  }
  case 'studio-results': {
    if (!ids[0]) {
      console.error('Usage: agents-company studio-results <slug> --views N [--likes N] [--comments N] [--subscribers N] [--viewed-pct N] [--avg-view-seconds N] [--url URL]');
      process.exit(1);
    }
    try {
      const v = new StudioMemory(config.dataDir).recordResults(ids[0], {
        views: values.views, likes: values.likes, comments: values.comments, subscribers: values.subscribers,
        viewedPct: values['viewed-pct'], avgViewSeconds: values['avg-view-seconds'], youtubeUrl: values.url,
      });
      console.log(`Recorded results for "${v.title}". The next studio run will take them into account.`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    break;
  }
  case 'youtube-auth': {
    try {
      const creds = { clientId: config.youtubeClientId, clientSecret: config.youtubeClientSecret, dataDir: config.dataDir };
      if (values.redirect) {
        await finishAuth({ ...creds, redirectedUrl: values.redirect });
      } else {
        const { url } = startAuth({ ...creds, port: config.youtubeAuthPort, analytics: config.youtubeAnalytics });
        const perms = config.youtubeAnalytics ? '"Manage your YouTube videos" (uploads) and "View YouTube Analytics reports" (read-only)' : '"Manage your YouTube videos" (uploads)';
        console.log(`Open this link in a browser on this machine and allow ${perms}:\n\n${url}\n`);
        console.log(`Waiting for Google to redirect to 127.0.0.1:${config.youtubeAuthPort} …`);
        console.log('On a server without a browser: open the link anywhere, then copy the URL the browser ends on (it starts with');
        console.log(`http://127.0.0.1:${config.youtubeAuthPort}/oauth2callback?…, the page itself will not load) and run:`);
        console.log('  node src/cli.mjs youtube-auth --redirect "<that URL>"\n');
        await waitForRedirect({ port: config.youtubeAuthPort, onUrl: (u) => finishAuth({ ...creds, redirectedUrl: u }) });
      }
      console.log(`YouTube connected. Approved Shorts will be uploaded as ${config.youtubePrivacy} by \`execute\` and the daemon.`);
      if (config.youtubeAnalytics) {
        console.log(youtubeAnalyticsGranted(config)
          ? 'YouTube Analytics granted: stats are pulled on every studio run and daemon tick (and with `studio-sync`).'
          : 'YouTube Analytics was not granted, so enter stats with `studio-results`, or run `youtube-auth` again and allow it.');
      }
    } catch (err) {
      console.error(`YouTube sign-in failed: ${err.message}`);
      process.exit(1);
    }
    break;
  }
  case 'email-test': {
    const to = ids[0];
    if (!to) {
      console.error('Usage: agents-company email-test <your-address>');
      process.exit(1);
    }
    try {
      const mailer = mailerFromConfig(config);
      if (!mailer) throw new Error('RESEND_API_KEY is not set');
      const site = siteFromConfig(config);
      const message = welcomeEmail({ to, opportunity: 'a test of your email setup', unsubscribeUrl: site.signupUrl ? `${site.signupUrl}/unsubscribe?t=test` : null, site });
      const { id } = await mailer.send({ ...message, subject: `[Test] ${message.subject}` });
      console.log(`Sent a test email to ${to} from ${config.emailFrom}${id ? ` (Resend id ${id})` : ''}. Check the inbox and the spam folder.`);
    } catch (err) {
      console.error(`Test email failed: ${err.message}`);
      process.exit(1);
    }
    break;
  }
  case 'check': {
    const { errors, warnings } = validateConfig(config);
    const strong = config.strongModel ? ` · strong ${config.strongModel}` : '';
    const searchKey = config.searchApiKey ? 'set' : config.searchProvider === 'off' ? 'n/a' : 'missing';
    console.log(`Environment: ${config.environment}${config.mock ? ' (mock)' : ''}`);
    console.log(`LLM:    ${config.provider} · ${config.baseUrl || '(no URL)'} · model ${config.model || '(none)'}${strong} · key ${config.apiKey ? 'set' : 'missing'}`);
    console.log(`Search: ${config.searchProvider}${config.searchUrl ? ` · ${config.searchUrl}` : ''} · key ${searchKey}`);
    const ytAnalytics = !config.youtubeAnalytics ? 'analytics off' : youtubeAnalyticsGranted(config) ? 'analytics on' : 'analytics not granted';
    console.log(`YouTube: ${config.youtubeAutoUpload ? `connected · uploads as ${config.youtubePrivacy}${config.youtubeSynthetic ? ' · AI disclosure on' : ''} · ${ytAnalytics}` : config.youtubeClientId ? 'client set, not connected (run youtube-auth)' : 'manual upload'}`);
    const yt = validateYouTubeConfig(config);
    [...warnings, ...yt.warnings].forEach((w) => console.log(`warning: ${w}`));
    errors.push(...yt.errors);
    errors.forEach((e) => console.log(`error:   ${e}`));
    if (!errors.length) console.log('OK');
    process.exit(errors.length ? 1 : 0);
  }
  default:
    await runOrDaemon();
}

async function runOrDaemon() {
  const plan = command === 'daemon' ? daemonPlan(config) : { jobs: ['company'], explicit: true, errors: [] };
  const fail = (errs) => { errs.forEach((e) => console.error(`Error: ${e}`)); process.exit(1); };
  if (plan.errors.length) fail(plan.errors);
  if (plan.jobs.includes('company')) {
    const { errors, warnings } = validateConfig(config);
    warnings.forEach((w) => console.warn(`Warning: ${w}`));
    if (errors.length) fail(errors);
  }
  if (plan.jobs.includes('studio')) {
    const { errors, warnings } = await studioChecks();
    warnings.forEach((w) => console.warn(`Warning: ${w}`));
    if (errors.length && plan.explicit) fail(errors);
    if (errors.length) {
      // Auto-enabled because a niche is set: keep the business running, just without the studio.
      errors.forEach((e) => console.warn(`Warning: studio job disabled: ${e}`));
      plan.jobs = plan.jobs.filter((j) => j !== 'studio');
    }
  }
  if (!plan.jobs.length) fail(['No daemon jobs left to run']);
  const llm = config.mock ? new MockLLMClient() : new LLMClient(config);
  let search = null;
  if (config.mock) search = config.searchProvider === 'off' ? null : new MockSearchClient();
  else search = searchFromConfig(config);
  const metrics = config.mock ? new MetricsStore(config.dataDir) : metricsFromConfig(config);

  async function cycle() {
    const run = await new Company({ llm, memory, approvals, search, metrics, config, log }).run();
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

  // Daemon: every check, run whatever is due. Approved actions (uploads,
  // pages, newsletters) go out on every check; stats sync hourly; the business
  // cycle and the studio each keep their own schedule, saved across restarts.
  const RETRY_MS = 60 * 60_000;
  let lastSync = 0;
  let companyFailedAt = 0;
  const jobs = [
    { name: 'approved actions', due: () => approvals.list('approved').length > 0, run: () => dispatch() },
    { name: 'youtube-analytics', due: () => !config.mock && Date.now() - lastSync >= RETRY_MS, run: async () => { lastSync = Date.now(); await syncYouTube().catch((err) => log(`[YouTube Analytics] skipped: ${err.message}`)); } },
  ];
  if (plan.jobs.includes('company')) {
    jobs.push({
      name: 'company',
      due: () => (companyFailedAt
        ? isDue(new Date(companyFailedAt), Math.min(RETRY_MS, config.intervalMs))
        : isDue(memory.state.runs.at(-1)?.at, config.intervalMs)),
      run: async () => {
        try { await cycle(); companyFailedAt = 0; } catch (err) { companyFailedAt = Date.now(); throw err; }
      },
    });
  }
  if (plan.jobs.includes('studio')) {
    jobs.push(createStudioJob({ makeStudio, memory: new StudioMemory(config.dataDir), approvals, intervalMs: plan.studioIntervalMs, maxPending: config.studioMaxPending, log }));
  }
  const scheduler = new Scheduler({ jobs, log });
  const every = (ms) => (ms % 36e5 === 0 ? `${ms / 36e5}h` : ms % 6e4 === 0 ? `${ms / 6e4}m` : `${ms / 1000}s`);
  log(`Daemon started, checking every ${every(config.checkMs)}. Jobs:`);
  log('  approved actions: uploads, pages and newsletters go out within one check of your approval');
  if (plan.jobs.includes('company')) log(`  company: research → decide → act, every ${every(config.intervalMs)}`);
  if (plan.jobs.includes('studio')) log(`  studio: ${config.studioVideos} Short(s) every ${every(plan.studioIntervalMs)} for "${config.channelNiche}", paused while ${config.studioMaxPending}+ wait for review`);
  if (!config.mock && analyticsFromConfig(config)) log('  youtube-analytics: stats sync hourly');
  await scheduler.tick();
  const timer = setInterval(() => scheduler.tick(), config.checkMs);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      clearInterval(timer);
      log('Daemon stopped');
      process.exit(0);
    });
  }
}
