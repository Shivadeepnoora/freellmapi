// Approval queue for actions that touch the outside world. Nothing in here is
// executed until a human approves it. Approved items are dispatched to a
// webhook (n8n, Zapier, Make, your own service) that performs the real action.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class ApprovalQueue {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'approvals.json');
    this.items = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : [];
  }

  add(request) {
    const id = `act-${String(this.items.length + 1).padStart(4, '0')}`;
    const item = { id, status: 'pending', createdAt: new Date().toISOString(), ...request };
    this.items.push(item);
    this.save();
    return item;
  }

  list(status) { return status ? this.items.filter((i) => i.status === status) : this.items; }

  get(id) { return this.items.find((i) => i.id === id); }

  decide(ids, status, note) {
    if (!['approved', 'rejected'].includes(status)) throw new Error(`Bad status ${status}`);
    const targets = ids.includes('all') ? this.list('pending') : ids.map((id) => {
      const item = this.get(id);
      if (!item) throw new Error(`No action ${id}`);
      if (item.status !== 'pending') throw new Error(`${id} is already ${item.status}`);
      return item;
    });
    for (const item of targets) Object.assign(item, { status, decidedAt: new Date().toISOString(), note });
    this.save();
    return targets;
  }

  // Send every approved item to the webhook. Without a webhook, items are
  // marked "manual" with the steps for a human to do it.
  async dispatch({ webhookUrl, webhookSecret, fetchImpl = globalThis.fetch, log = () => {} }) {
    const done = [];
    for (const item of this.list('approved')) {
      if (!webhookUrl) {
        Object.assign(item, { status: 'manual', executedAt: new Date().toISOString() });
        log(`[Executor] ${item.id} approved but no AGENTS_WEBHOOK_URL set: do it manually -> ${item.title}`);
        done.push(item);
        continue;
      }
      try {
        const res = await fetchImpl(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(webhookSecret ? { 'x-agents-secret': webhookSecret } : {}) },
          body: JSON.stringify({ action: item }),
        });
        if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
        Object.assign(item, { status: 'executed', executedAt: new Date().toISOString() });
        log(`[Executor] ${item.id} executed via webhook: ${item.title}`);
      } catch (err) {
        Object.assign(item, { status: 'failed', error: err.message });
        log(`[Executor] ${item.id} FAILED: ${err.message}`);
      }
      done.push(item);
      this.save();
    }
    this.save();
    return done;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items, null, 2));
    renameSync(tmp, this.file);
  }
}
