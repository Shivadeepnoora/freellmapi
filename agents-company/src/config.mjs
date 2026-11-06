// Runtime configuration. Everything can be set by env var or CLI flag.
//
// The LLM and the web search each come from a "provider". FreeLLMAPI (free
// tiers, for testing) is the default; for a real business, switch to a paid
// OpenAI-compatible API and a paid search API, and set AGENTS_ENV=production
// so the company refuses to run on free tiers by accident.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSignupUrl } from './site/signup.mjs';

export const LLM_PROVIDERS = {
  freellmapi: { baseUrl: 'http://localhost:3001/v1', keyEnv: 'FREELLMAPI_API_KEY', model: 'auto', freeTier: true },
  openai: { baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', model: null, freeTier: false },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', model: null, freeTier: false },
  custom: { baseUrl: null, keyEnv: 'AGENTS_LLM_API_KEY', model: null, freeTier: false },
};

// Both search backends speak Tavily's request/response shape.
export const SEARCH_PROVIDERS = {
  freellmapi: { url: null /* derived from the FreeLLMAPI base URL */, keyEnv: 'FREELLMAPI_API_KEY', freeTier: true },
  tavily: { url: 'https://api.tavily.com/search', keyEnv: 'TAVILY_API_KEY', freeTier: false },
  custom: { url: null, keyEnv: 'AGENTS_SEARCH_API_KEY', freeTier: false },
  off: { url: null, keyEnv: null, freeTier: false },
};

export function loadConfig(overrides = {}, env = process.env) {
  const pick = (flag, name, fallback) => overrides[flag] ?? env[name] ?? fallback;

  const provider = pick('provider', 'AGENTS_LLM_PROVIDER', 'freellmapi');
  const preset = LLM_PROVIDERS[provider];
  const freellmapiBase = (env.FREELLMAPI_BASE_URL ?? LLM_PROVIDERS.freellmapi.baseUrl).replace(/\/$/, '');
  const baseUrl = pick('baseUrl', 'AGENTS_LLM_BASE_URL', provider === 'freellmapi' ? freellmapiBase : preset?.baseUrl ?? '');

  const searchRequested = pick('search', 'AGENTS_SEARCH', 'auto');
  const searchProvider = searchRequested === 'auto'
    ? (provider === 'freellmapi' ? 'freellmapi' : env.TAVILY_API_KEY ? 'tavily' : 'off')
    : searchRequested;
  const searchPreset = SEARCH_PROVIDERS[searchProvider];

  return {
    environment: pick('environment', 'AGENTS_ENV', 'development'),
    allowFreeTier: env.AGENTS_ALLOW_FREE_TIER === '1',
    provider,
    baseUrl: (baseUrl ?? '').replace(/\/$/, ''),
    apiKey: overrides.apiKey ?? env.AGENTS_LLM_API_KEY ?? (preset?.keyEnv ? env[preset.keyEnv] : '') ?? '',
    model: pick('model', 'AGENTS_MODEL', preset?.model ?? ''),
    // Optional stronger model for the two decisions that matter most
    // (Research Director and CEO); department and action agents use `model`.
    strongModel: pick('strongModel', 'AGENTS_STRONG_MODEL', ''),
    priceInputPerMTok: Number(env.AGENTS_PRICE_INPUT_PER_MTOK ?? 0),
    priceOutputPerMTok: Number(env.AGENTS_PRICE_OUTPUT_PER_MTOK ?? 0),

    searchProvider,
    searchUrl: env.AGENTS_SEARCH_URL ?? (searchProvider === 'freellmapi' ? `${freellmapiBase}/search` : searchPreset?.url ?? ''),
    searchApiKey: env.AGENTS_SEARCH_API_KEY ?? (searchPreset?.keyEnv ? env[searchPreset.keyEnv] : '') ?? '',
    searchQueries: Number(pick('searchQueries', 'AGENTS_SEARCH_QUERIES', 4)),
    searchResults: Number(pick('searchResults', 'AGENTS_SEARCH_RESULTS', 5)),

    mock: overrides.mock ?? env.AGENTS_MOCK === '1',
    focus: pick('focus', 'AGENTS_FOCUS', 'online income sources a solo founder can start with little capital'),
    opportunities: Number(pick('opportunities', 'AGENTS_OPPORTUNITIES', 5)),
    concurrency: Number(pick('concurrency', 'AGENTS_CONCURRENCY', 3)),
    retries: Number(pick('retries', 'AGENTS_RETRIES', 3)),
    dataDir: pick('dataDir', 'AGENTS_DATA_DIR', new URL('../data/', import.meta.url).pathname),
    act: overrides.act ?? env.AGENTS_ACT !== '0',
    executeTop: Number(pick('executeTop', 'AGENTS_EXECUTE_TOP', 2)),
    webhookUrl: pick('webhookUrl', 'AGENTS_WEBHOOK_URL', ''),
    webhookSecret: env.AGENTS_WEBHOOK_SECRET ?? '',
    githubPagesRepo: pick('githubPagesRepo', 'AGENTS_GITHUB_PAGES_REPO', ''),
    githubPagesBranch: pick('githubPagesBranch', 'AGENTS_GITHUB_PAGES_BRANCH', 'gh-pages'),
    githubToken: env.AGENTS_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? '',
    githubApiUrl: env.AGENTS_GITHUB_API_URL ?? 'https://api.github.com',
    webhookPort: Number(pick('port', 'AGENTS_WEBHOOK_PORT', 8787)),

    // Signup capture and the feedback loop
    signupUrl: pick('signupUrl', 'AGENTS_SIGNUP_URL', '').replace(/\/$/, ''),
    signupAllowedOrigins: splitList(pick('signupAllowedOrigins', 'AGENTS_SIGNUP_ALLOWED_ORIGINS', '')),
    businessName: env.AGENTS_BUSINESS_NAME ?? '',
    contactEmail: env.AGENTS_CONTACT_EMAIL ?? '',
    trustProxy: env.AGENTS_TRUST_PROXY === '1',
    metricsSource: env.AGENTS_METRICS_SOURCE ?? 'auto',
    postalAddress: env.AGENTS_POSTAL_ADDRESS ?? '',

    // Email to subscribers (Resend)
    resendApiKey: env.RESEND_API_KEY ?? '',
    emailFrom: env.AGENTS_EMAIL_FROM ?? '',
    emailReplyTo: env.AGENTS_EMAIL_REPLY_TO ?? '',
    doubleOptIn: env.AGENTS_DOUBLE_OPT_IN !== '0',
    emailMaxRecipients: Number(env.AGENTS_EMAIL_MAX_RECIPIENTS ?? 1000),

    // YouTube Shorts studio
    channelNiche: pick('channelNiche', 'AGENTS_CHANNEL_NICHE', ''),
    channelName: env.AGENTS_CHANNEL_NAME ?? '',
    channelLink: env.AGENTS_CHANNEL_LINK ?? '',
    channelCta: env.AGENTS_CHANNEL_CTA ?? 'Free newsletter',
    studioVideos: Number(pick('studioVideos', 'AGENTS_STUDIO_VIDEOS', 2)),
    mediaBaseUrl: (env.AGENTS_MEDIA_BASE_URL ?? freellmapiBase).replace(/\/$/, ''),
    mediaApiKey: env.AGENTS_MEDIA_API_KEY ?? env.FREELLMAPI_API_KEY ?? '',
    ttsModel: env.AGENTS_TTS_MODEL ?? 'auto',
    ttsVoice: env.AGENTS_TTS_VOICE ?? 'alloy',
    imageModel: env.AGENTS_IMAGE_MODEL ?? 'auto',

    // YouTube upload after approval
    youtubeClientId: env.YOUTUBE_CLIENT_ID ?? '',
    youtubeClientSecret: env.YOUTUBE_CLIENT_SECRET ?? '',
    youtubeRefreshToken: env.YOUTUBE_REFRESH_TOKEN ?? '',
    youtubePrivacy: pick('youtubePrivacy', 'AGENTS_YOUTUBE_PRIVACY', 'public'),
    youtubeSynthetic: env.AGENTS_YOUTUBE_SYNTHETIC !== '0',
    youtubeAuthPort: Number(env.AGENTS_YOUTUBE_AUTH_PORT ?? 8976),
    get youtubeAutoUpload() { return Boolean(this.youtubeClientId && (this.youtubeRefreshToken || existsSync(join(this.dataDir, 'youtube-token.json')))); },
    youtubeAnalytics: env.AGENTS_YOUTUBE_ANALYTICS !== '0',

    minViews: Number(pick('minViews', 'AGENTS_MIN_VIEWS', 100)),
    targetConversion: Number(pick('targetConversion', 'AGENTS_TARGET_CONVERSION', 0.05)),
    intervalMs: parseInterval(pick('interval', 'AGENTS_INTERVAL', '24h')),
  };
}

// Checks that matter before spending money or making decisions on the output.
// Errors stop the run; warnings are printed.
export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  if (config.mock) return { errors, warnings };

  const preset = LLM_PROVIDERS[config.provider];
  if (!preset) errors.push(`Unknown AGENTS_LLM_PROVIDER "${config.provider}" (use: ${Object.keys(LLM_PROVIDERS).join(', ')})`);
  if (!config.baseUrl) errors.push('No LLM base URL: set AGENTS_LLM_BASE_URL for the custom provider');
  if (!config.model) errors.push(`No model set for provider "${config.provider}": set AGENTS_MODEL (or --model) to a model your provider offers`);
  if (preset && !config.apiKey) {
    const key = preset.keyEnv ?? 'AGENTS_LLM_API_KEY';
    (preset.freeTier ? warnings : errors).push(`${key} is not set${preset.freeTier ? ' (use the unified key from the FreeLLMAPI Keys page, or --mock)' : ''}`);
  }

  const search = SEARCH_PROVIDERS[config.searchProvider];
  if (!search) errors.push(`Unknown AGENTS_SEARCH "${config.searchProvider}" (use: auto, ${Object.keys(SEARCH_PROVIDERS).join(', ')})`);
  else if (config.searchProvider === 'off') warnings.push('Web search is off: research comes from model knowledge only and will be marked unverified. Set TAVILY_API_KEY or AGENTS_SEARCH.');
  else {
    if (!config.searchUrl) errors.push('No search URL: set AGENTS_SEARCH_URL for the custom search provider');
    if (!config.searchApiKey && config.searchProvider !== 'freellmapi') errors.push(`${search.keyEnv} is not set for search provider "${config.searchProvider}"`);
  }

  // Signup capture: published pages should collect emails, lawfully.
  const prod = config.environment === 'production';
  if (config.signupUrl) {
    try { validateSignupUrl(config.signupUrl); } catch (err) { errors.push(err.message); }
    if (!config.businessName || !config.contactEmail) {
      (prod ? errors : warnings).push('Set AGENTS_BUSINESS_NAME and AGENTS_CONTACT_EMAIL: the privacy notice published with each page must say who you are and how to reach you.');
    }
    if (!signupOrigins(config).length) warnings.push('No allowed signup origins: set AGENTS_GITHUB_PAGES_REPO or AGENTS_SIGNUP_ALLOWED_ORIGINS, or every signup will be refused.');
  } else if (config.githubPagesRepo) {
    (prod ? errors : warnings).push('AGENTS_SIGNUP_URL is not set: published landing pages will not collect signups, so there is no feedback to learn from. Run `webhook-server` on a public HTTPS address and set AGENTS_SIGNUP_URL to it.');
  }

  // Email to subscribers
  if (config.resendApiKey) {
    if (!config.emailFrom) errors.push('RESEND_API_KEY is set but AGENTS_EMAIL_FROM is not, e.g. "Acme <hello@yourdomain.com>" on a domain verified in Resend.');
    else if (!/<?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?\s*$/.test(config.emailFrom)) errors.push(`AGENTS_EMAIL_FROM doesn't look like an email address: "${config.emailFrom}"`);
    if (!config.signupUrl) warnings.push('Email is configured but AGENTS_SIGNUP_URL is not: confirmation and unsubscribe links need the public server address, so no emails will be sent.');
    if (!config.postalAddress) (prod ? errors : warnings).push('AGENTS_POSTAL_ADDRESS is not set: newsletters will be refused, because commercial email must include a postal address (CAN-SPAM). A PO box or registered business address works.');
  } else if (config.signupUrl) {
    warnings.push('RESEND_API_KEY is not set: subscribers get no confirmation, welcome or newsletter emails (you can still export them with `signups --export`).');
  }

  // FreeLLMAPI's README: "for personal experimentation and learning, not
  // production … swap in a paid API before you ship". Enforce that in production.
  if (prod && !config.allowFreeTier) {
    if (preset?.freeTier) errors.push('AGENTS_ENV=production but the LLM provider is FreeLLMAPI (free tiers are not meant for production). Switch AGENTS_LLM_PROVIDER to a paid API, or set AGENTS_ALLOW_FREE_TIER=1 to override.');
    if (search?.freeTier) errors.push('AGENTS_ENV=production but web search goes through FreeLLMAPI free tiers. Set AGENTS_SEARCH=tavily (or custom), or AGENTS_ALLOW_FREE_TIER=1 to override.');
    if (config.searchProvider === 'off') errors.push('AGENTS_ENV=production requires live web search so decisions are based on sources. Configure AGENTS_SEARCH.');
  } else if (preset?.freeTier || search?.freeTier) {
    warnings.push('Running on FreeLLMAPI free tiers: fine for testing, but switch to paid providers (and set AGENTS_ENV=production) before relying on this for the business.');
  }
  return { errors, warnings };
}

// Extra checks for the YouTube studio (on top of validateConfig).
export function validateStudioConfig(config) {
  const errors = [];
  const warnings = [];
  if (!config.channelNiche) errors.push('Set the channel niche: AGENTS_CHANNEL_NICHE or --niche (e.g. "personal finance for students").');
  if (!Number.isInteger(config.studioVideos) || config.studioVideos < 1 || config.studioVideos > 10) errors.push('AGENTS_STUDIO_VIDEOS / --videos must be between 1 and 10.');
  if (config.mock) return { errors, warnings };
  const freeMedia = config.mediaBaseUrl.replace(/\/$/, '') === (process.env.FREELLMAPI_BASE_URL ?? LLM_PROVIDERS.freellmapi.baseUrl).replace(/\/$/, '');
  if (freeMedia) {
    if (config.environment === 'production' && !config.allowFreeTier) {
      errors.push('AGENTS_ENV=production but voiceover and images go through FreeLLMAPI free tiers. Set AGENTS_MEDIA_BASE_URL (and AGENTS_MEDIA_API_KEY, AGENTS_TTS_MODEL, AGENTS_IMAGE_MODEL) to a paid OpenAI-compatible media API, or AGENTS_ALLOW_FREE_TIER=1.');
    } else {
      warnings.push('Voiceover and images use FreeLLMAPI free tiers: fine for testing; check each provider\'s terms before publishing commercially. FreeLLMAPI needs speech and image models enabled on its Models page.');
    }
    if (!config.mediaApiKey) warnings.push('FREELLMAPI_API_KEY is not set, so media requests will be refused.');
  }
  if (!config.channelLink) warnings.push('AGENTS_CHANNEL_LINK is not set: descriptions will not point viewers to your newsletter or offer, which is how a new channel earns before monetization.');
  errors.push(...validateYouTubeConfig(config).errors);
  return { errors, warnings };
}

export function validateYouTubeConfig(config) {
  const errors = [];
  const warnings = [];
  if (!['public', 'unlisted', 'private'].includes(config.youtubePrivacy)) errors.push(`AGENTS_YOUTUBE_PRIVACY must be public, unlisted or private (got "${config.youtubePrivacy}")`);
  if (config.youtubeClientId && !config.youtubeClientSecret) warnings.push('YOUTUBE_CLIENT_SECRET is not set; Google requires it for "Desktop app" OAuth clients.');
  if (config.youtubeClientId && !config.youtubeAutoUpload) warnings.push('YouTube is not connected yet: run `node src/cli.mjs youtube-auth` once. Until then, approved videos are marked for manual upload.');
  if (config.youtubeAutoUpload && config.youtubeAnalytics && !config.youtubeRefreshToken && !youtubeAnalyticsGranted(config)) {
    warnings.push('YouTube Analytics is not granted on the saved sign-in, so stats are not pulled automatically: run `node src/cli.mjs youtube-auth` again and allow "View YouTube Analytics reports".');
  }
  return { errors, warnings };
}

export function youtubeAnalyticsGranted(config) {
  if (config.youtubeRefreshToken) return true;
  const f = join(config.dataDir, 'youtube-token.json');
  if (!existsSync(f)) return false;
  try { return String(JSON.parse(readFileSync(f, 'utf8')).scope ?? '').includes('yt-analytics.readonly'); } catch { return false; }
}

// Origins allowed to post signups: the explicit list, else the GitHub Pages
// site of the configured repo (https://<owner>.github.io).
export function signupOrigins(config) {
  if (config.signupAllowedOrigins.length) return config.signupAllowedOrigins;
  const owner = config.githubPagesRepo?.split('/')[0];
  return owner ? [`https://${owner.toLowerCase()}.github.io`] : [];
}

function splitList(value) {
  return String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function parseInterval(value) {
  if (typeof value === 'number') return value;
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(String(value).trim());
  if (!m) throw new Error(`Invalid interval "${value}" (use e.g. 30m, 6h, 1d)`);
  const unit = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] ?? 'ms'];
  return Number(m[1]) * unit;
}
