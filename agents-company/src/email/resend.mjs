// Minimal Resend client (https://resend.com/docs/api-reference).
//   POST /emails        one message
//   POST /emails/batch  up to 100 messages in one request
// Retries on 429/5xx with backoff (honouring Retry-After), and sends an
// Idempotency-Key so a retried request never delivers the same email twice.

export const RESEND_BATCH_LIMIT = 100;

export class ResendMailer {
  constructor({ apiKey, from, replyTo = '', apiUrl = 'https://api.resend.com', retries = 3, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    if (!apiKey) throw new Error('Resend needs RESEND_API_KEY');
    if (!from) throw new Error('Resend needs AGENTS_EMAIL_FROM, e.g. "Acme <hello@yourdomain.com>" on a domain verified in Resend');
    this.apiKey = apiKey;
    this.from = from;
    this.replyTo = replyTo;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.retries = retries;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.sent = 0;
  }

  // message: {to, subject, text, html, headers?}
  async send(message, { idempotencyKey } = {}) {
    const data = await this.#post('/emails', this.#payload(message), idempotencyKey);
    this.sent++;
    return { id: data?.id ?? null };
  }

  async sendBatch(messages, { idempotencyKey } = {}) {
    if (messages.length > RESEND_BATCH_LIMIT) throw new Error(`Resend batches are limited to ${RESEND_BATCH_LIMIT} emails`);
    if (!messages.length) return { ids: [] };
    const data = await this.#post('/emails/batch', messages.map((m) => this.#payload(m)), idempotencyKey);
    this.sent += messages.length;
    return { ids: (data?.data ?? []).map((d) => d.id) };
  }

  #payload({ to, subject, text, html, headers }) {
    return {
      from: this.from,
      to: [to],
      subject,
      text,
      html,
      ...(this.replyTo ? { reply_to: this.replyTo } : {}),
      ...(headers ? { headers } : {}),
    };
  }

  async #post(path, body, idempotencyKey) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.fetch(`${this.apiUrl}${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            'user-agent': 'freellmapi-agents-company',
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          },
          body: JSON.stringify(body),
        });
        if (res.ok) return res.json().catch(() => ({}));
        const text = await res.text().catch(() => '');
        let msg = text;
        try { msg = JSON.parse(text).message ?? text; } catch { /* keep raw */ }
        const err = new Error(`Resend ${path} -> ${res.status}: ${String(msg).slice(0, 200)}`);
        err.retryable = res.status === 429 || res.status >= 500;
        err.retryAfterMs = Number(res.headers.get('retry-after')) * 1000 || 0;
        throw err;
      } catch (err) {
        lastErr = err;
        if (err.retryable === false || attempt === this.retries) break;
        await this.sleep(Math.max(err.retryAfterMs ?? 0, 1000 * 2 ** attempt));
      }
    }
    throw lastErr;
  }
}

export function mailerFromConfig(config, { fetchImpl } = {}) {
  if (!config.resendApiKey) return null;
  return new ResendMailer({ apiKey: config.resendApiKey, from: config.emailFrom, replyTo: config.emailReplyTo, fetchImpl });
}
