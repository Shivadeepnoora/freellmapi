// Approval queue for actions that touch the outside world. Nothing in here is
// executed until a human approves it. Approved items are dispatched to a
// webhook (n8n, Zapier, Make, your own service) that performs the real action.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const MAX_ARTIFACT_BYTES = 1_000_000;

export class ApprovalQueue {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
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

  // Carry out every approved item, in order of preference:
  //   1. a built-in executor that can handle it (e.g. GitHub Pages for "publish")
  //   2. the webhook, which receives the action plus the artifact's content
  //   3. otherwise it is marked "manual" for a human to do.
  // A webhook reply of {"status":"ignored"} also means "manual".
  async dispatch({ webhookUrl, webhookSecret, executors = [], fetchImpl = globalThis.fetch, log = () => {} }) {
    const done = [];
    for (const item of this.list('approved')) {
      try {
        const executor = executors.find((e) => e.canHandle(item));
        if (executor) {
          const result = await executor.execute(item, this.readArtifact(item));
          this.#finish(item, 'executed', result);
          log(`[Executor] ${item.id} executed by ${result.executor}: ${item.title}${result.url ? ` -> ${result.url}` : ''}`);
        } else if (webhookUrl) {
          const res = await fetchImpl(webhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(webhookSecret ? { 'x-agents-secret': webhookSecret } : {}) },
            body: JSON.stringify({ action: item, content: this.readArtifact(item) }),
          });
          if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
          const result = await res.json().catch(() => ({}));
          if (result?.status === 'ignored') {
            this.#finish(item, 'manual', result);
            log(`[Executor] ${item.id} not handled by webhook (${result.reason ?? 'ignored'}): do it manually -> ${item.title}`);
          } else {
            this.#finish(item, 'executed', result);
            log(`[Executor] ${item.id} executed via webhook: ${item.title}${result?.url ? ` -> ${result.url}` : ''}`);
          }
        } else {
          this.#finish(item, 'manual', null);
          log(`[Executor] ${item.id} approved but no executor or AGENTS_WEBHOOK_URL: do it manually -> ${item.title}`);
        }
      } catch (err) {
        Object.assign(item, { status: 'failed', error: err.message });
        log(`[Executor] ${item.id} FAILED: ${err.message}`);
      }
      done.push(item);
      this.save();
    }
    return done;
  }

  // Reads an action's artifact, but only from inside this company's workspace,
  // so an edited approvals.json cannot make the executor read or publish
  // arbitrary files from the machine.
  readArtifact(item) {
    if (!item.artifact) return null;
    const workspace = resolve(this.dataDir, 'workspace') + sep;
    const file = resolve(item.artifact);
    if (!file.startsWith(workspace)) throw new Error(`artifact ${item.artifact} is outside the workspace`);
    if (!existsSync(file)) throw new Error(`artifact ${item.artifact} no longer exists`);
    if (statSync(file).size > MAX_ARTIFACT_BYTES) throw new Error(`artifact ${item.artifact} is too large`);
    return readFileSync(file, 'utf8');
  }

  #finish(item, status, result) {
    Object.assign(item, { status, executedAt: new Date().toISOString() });
    if (result?.url) item.resultUrl = result.url;
    if (result?.page) item.page = result.page;
    if (result?.signupCapture !== undefined) item.signupCapture = result.signupCapture;
    if (result?.reason) item.note = result.reason;
    delete item.error;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items, null, 2));
    renameSync(tmp, this.file);
  }
}
