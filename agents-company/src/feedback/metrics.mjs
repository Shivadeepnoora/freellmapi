// Stores landing-page results: anonymous daily view counts and email signups.
//
// Two files, so personal data stays separate from what the agents see:
//   metrics.json  per-page counts only (views per day, signup count). Safe to
//                 summarise into reports and LLM prompts.
//   signups.json  the email addresses themselves, with page, time and consent.
//                 Never sent to an LLM; exported or deleted only by the CLI.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const token = () => randomBytes(24).toString('base64url');
export const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

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

  // Returns {added:true, signup} or {added:false, reason}. Duplicates are not
  // errors to the visitor (they see the same thanks), so callers treat both as
  // success. With double opt-in the subscriber stays "pending" until they click
  // the link in the confirmation email; only "confirmed" people get newsletters.
  addSignup(page, email, at = new Date(), { doubleOptIn = false } = {}) {
    const normal = String(email ?? '').trim().toLowerCase();
    if (normal.length > 254 || !EMAIL_RE.test(normal)) return { added: false, reason: 'invalid email' };
    const p = this.#page(page);
    if (this.signups.some((s) => s.page === page && s.email === normal)) return { added: false, reason: 'duplicate' };
    const signup = {
      page,
      email: normal,
      consent: true,
      at: at.toISOString(),
      status: doubleOptIn ? 'pending' : 'confirmed',
      ...(doubleOptIn ? { confirmToken: token() } : { confirmedAt: at.toISOString() }),
      unsubToken: token(),
    };
    this.signups.push(signup);
    p.signups += 1;
    p.lastSignupAt = at.toISOString();
    writeJSON(this.signupsFile, this.signups);
    writeJSON(this.metricsFile, this.metrics);
    return { added: true, signup };
  }

  // Click on the confirmation link. Returns the signup, or null for an unknown token.
  confirm(confirmToken, at = new Date()) {
    const s = confirmToken && this.signups.find((x) => x.confirmToken === confirmToken);
    if (!s) return null;
    if (s.status === 'pending') {
      Object.assign(s, { status: 'confirmed', confirmedAt: at.toISOString() });
      writeJSON(this.signupsFile, this.signups);
      return { signup: s, changed: true };
    }
    return { signup: s, changed: false };
  }

  // Unsubscribe link or one-click header. The record is kept (marked
  // unsubscribed) so the address is never emailed again by accident; use
  // deleteEmail to erase it entirely.
  unsubscribe(unsubToken, at = new Date()) {
    const s = unsubToken && this.signups.find((x) => x.unsubToken === unsubToken);
    if (!s) return null;
    const changed = s.status !== 'unsubscribed';
    if (changed) {
      Object.assign(s, { status: 'unsubscribed', unsubscribedAt: at.toISOString() });
      delete s.confirmToken;
      writeJSON(this.signupsFile, this.signups);
    }
    return { signup: s, changed };
  }

  // People who may receive newsletters for a page. Records from before
  // statuses existed were single opt-in with consent, so count as confirmed.
  subscribers(page) {
    return this.signups.filter((s) => s.page === page && (s.status ?? 'confirmed') === 'confirmed');
  }

  // Gives records created before tokens existed an unsubscribe token.
  ensureUnsubToken(signup) {
    if (!signup.unsubToken) {
      signup.unsubToken = token();
      writeJSON(this.signupsFile, this.signups);
    }
    return signup.unsubToken;
  }

  // Counts only: no email addresses.
  async stats() {
    return Object.fromEntries(Object.entries(this.metrics.pages).map(([page, p]) => {
      const people = this.signups.filter((s) => s.page === page);
      const count = (status) => people.filter((s) => (s.status ?? 'confirmed') === status).length;
      return [page, {
        views: Object.values(p.views).reduce((a, b) => a + b, 0),
        signups: p.signups,
        confirmed: count('confirmed'),
        pending: count('pending'),
        unsubscribed: count('unsubscribed'),
        viewsByDay: { ...p.views },
        firstSeen: p.firstSeen,
        lastSignupAt: p.lastSignupAt ?? null,
      }];
    }));
  }

  // For the operator's own email tool. Tokens are secrets, so they are left out.
  exportSignups(page) {
    return this.signups
      .filter((s) => !page || s.page === page)
      .map(({ confirmToken, unsubToken, ...s }) => ({ ...s, status: s.status ?? 'confirmed' }));
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
