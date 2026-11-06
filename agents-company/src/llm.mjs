// Thin client for an OpenAI-compatible /v1/chat/completions endpoint
// (FreeLLMAPI by default). Retries with exponential backoff, and can parse
// JSON out of a model reply even when it is wrapped in prose or code fences.

export class LLMClient {
  constructor({ baseUrl, apiKey, model, strongModel = '', priceInputPerMTok = 0, priceOutputPerMTok = 0, retries = 3, fetchImpl = globalThis.fetch, sleep = defaultSleep }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.strongModel = strongModel || model;
    this.prices = { input: priceInputPerMTok, output: priceOutputPerMTok };
    this.usage = newUsage();
    this.retries = retries;
    this.fetch = fetchImpl;
    this.sleep = sleep;
  }

  // tier: 'strong' uses AGENTS_STRONG_MODEL (Research Director, CEO); anything else uses the default model.
  async chat(messages, { temperature = 0.7, maxTokens = 1500, tier } = {}) {
    const model = tier === 'strong' ? this.strongModel : this.model;
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
          err.retryable = res.status === 429 || res.status >= 500;
          throw err;
        }
        const data = await res.json();
        this.#recordUsage(data?.model ?? model, data?.usage);
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('Empty LLM reply'), { retryable: true });
        return content;
      } catch (err) {
        lastErr = err;
        if (err.retryable === false || attempt === this.retries) break;
        await this.sleep(1000 * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  #recordUsage(model, usage) {
    const u = this.usage;
    const input = Number(usage?.prompt_tokens) || 0;
    const output = Number(usage?.completion_tokens) || 0;
    u.calls++;
    u.inputTokens += input;
    u.outputTokens += output;
    u.byModel[model] = (u.byModel[model] ?? 0) + 1;
  }

  // Usage since the last call to takeUsage(), with an estimated cost when
  // AGENTS_PRICE_INPUT_PER_MTOK / AGENTS_PRICE_OUTPUT_PER_MTOK are set.
  takeUsage() {
    const u = this.usage;
    this.usage = newUsage();
    const cost = (u.inputTokens * this.prices.input + u.outputTokens * this.prices.output) / 1e6;
    return { ...u, estimatedCostUsd: this.prices.input || this.prices.output ? Math.round(cost * 10000) / 10000 : null };
  }

  async chatJSON(messages, opts) {
    const reply = await this.chat(messages, opts);
    return extractJSON(reply);
  }
}

export function extractJSON(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    try { return JSON.parse(c.trim()); } catch { /* try next */ }
    const start = c.search(/[[{]/);
    if (start === -1) continue;
    const open = c[start];
    const close = open === '{' ? '}' : ']';
    const end = c.lastIndexOf(close);
    if (end > start) {
      try { return JSON.parse(c.slice(start, end + 1)); } catch { /* try next */ }
    }
  }
  throw new Error(`Could not parse JSON from model reply: ${text.slice(0, 200)}`);
}

const newUsage = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, byModel: {} });
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
