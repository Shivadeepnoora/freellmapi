// Stores landing-page results: anonymous daily view counts and email signups.
//
// Two files, so personal data stays separate from what the agents see:
//   metrics.json  per-page counts only (views per day, signup count). Safe to
//                 summarise into reports and LLM prompts.
//   signups.json  the email addresses themselves, with page, time and consent.
//                 Never sent to an LLM; exported or deleted only by the CLI.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;
export const PAGE_RE = /^[a-z0-9-]{1,60}$/;

export class MetricsStore {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true });
    this.metricsFile = join(dataDir, 'metrics.json');
    this.signupsFile = join(dataDir, 'signups.json');
    this.metrics = readJSON(this.metricsFile, { pages: {} });
    this.signups = readJSON(this.signupsFile, []);
  }

  #page(page) {
    if (!PAGE_RE.test(page)) throw new Error('invalid page');
    return (this.metrics.pages[page] ??= { views: {}, signups: 0, firstSeen: new Date().toISOString() });
  }

  recordView(page, at = new Date()) {
    const p = this.#page(page);
    const day = at.toISOString().slice(0, 10);
    p.views[day] = (p.views[day] ?? 0) + 1;
    writeJSON(this.metricsFile, this.metrics);
  }

  // Returns {added:true} or {added:false, reason}. Duplicates are not errors to
  // the visitor (they see the same thanks), so callers treat both as success.
  addSignup(page, email, at = new Date()) {
    const normal = String(email ?? '').trim().toLowerCase();
    if (normal.length > 254 || !EMAIL_RE.test(normal)) return { added: false, reason: 'invalid email' };
    const p = this.#page(page);
    if (this.signups.some((s) => s.page === page && s.email === normal)) return { added: false, reason: 'duplicate' };
    this.signups.push({ page, email: normal, consent: true, at: at.toISOString() });
    p.signups += 1;
    p.lastSignupAt = at.toISOString();
    writeJSON(this.signupsFile, this.signups);
    writeJSON(this.metricsFile, this.metrics);
    return { added: true };
  }

  // Counts only: no email addresses.
  async stats() {
    return Object.fromEntries(Object.entries(this.metrics.pages).map(([page, p]) => [page, {
      views: Object.values(p.views).reduce((a, b) => a + b, 0),
      signups: p.signups,
      viewsByDay: { ...p.views },
      firstSeen: p.firstSeen,
      lastSignupAt: p.lastSignupAt ?? null,
    }]));
  }

  exportSignups(page) {
    return this.signups.filter((s) => !page || s.page === page);
  }

  // Right to erasure: removes every signup for this address and fixes the counts.
  deleteEmail(email) {
    const normal = String(email ?? '').trim().toLowerCase();
    const removed = this.signups.filter((s) => s.email === normal);
    this.signups = this.signups.filter((s) => s.email !== normal);
    for (const s of removed) if (this.metrics.pages[s.page]) this.metrics.pages[s.page].signups -= 1;
    writeJSON(this.signupsFile, this.signups);
    writeJSON(this.metricsFile, this.metrics);
    return removed.length;
  }
}

// Reads counts from a webhook server on another machine (GET /stats).
export class RemoteMetrics {
  constructor({ url, secret, fetchImpl = globalThis.fetch }) {
    this.url = `${url.replace(/\/$/, '')}/stats`;
    this.secret = secret;
    this.fetch = fetchImpl;
  }

  async stats() {
    const res = await this.fetch(this.url, { headers: { 'x-agents-secret': this.secret } });
    if (!res.ok) throw new Error(`stats HTTP ${res.status}`);
    const data = await res.json();
    return data?.pages ?? {};
  }
}

// Remote when the signup server is configured with a shared secret (it may run
// elsewhere); otherwise the local files, written by a webhook-server that
// shares this data directory.
export function metricsFromConfig(config, { fetchImpl } = {}) {
  if (config.signupUrl && config.webhookSecret && config.metricsSource !== 'local') {
    return new RemoteMetrics({ url: config.signupUrl, secret: config.webhookSecret, fetchImpl });
  }
  return new MetricsStore(config.dataDir);
}

function readJSON(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : structuredClone(fallback);
}

function writeJSON(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}
