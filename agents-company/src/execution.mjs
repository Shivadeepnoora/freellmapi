// Execution phase: for the top-ranked opportunities, action agents build the
// deliverables (written to the workspace automatically), then the Operations
// Manager plans the next 14 days. External tasks go to the approval queue.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_AGENTS, OPERATIONS_MANAGER, EXTERNAL_KINDS } from './agents/action-roles.mjs';
import { runPool } from './pool.mjs';

export class ExecutionTeam {
  constructor({ llm, approvals, config, log = () => {} }) {
    this.llm = llm;
    this.approvals = approvals;
    this.config = config;
    this.log = log;
  }

  async execute(run) {
    const top = run.ranked.filter((r) => r.totalScore > 0).slice(0, this.config.executeTop);
    const results = [];
    for (const opp of top) results.push(await this.#executeOne(run, opp));
    return results;
  }

  async #executeOne(run, opp) {
    const dir = join(this.config.dataDir, 'workspace', run.id, slugify(opp.name));
    mkdirSync(dir, { recursive: true });
    const brief = JSON.stringify({ name: opp.name, category: opp.category, summary: opp.summary, reports: opp.reports, ceo: run.decision }, null, 2);
    this.log(`[CEO] assigning action agents to "${opp.name}"`);

    const files = await runPool(FILE_AGENTS, this.config.concurrency, async (agent) => {
      const reply = await this.llm.chat([
        { role: 'system', content: agent.system },
        { role: 'user', content: `Opportunity brief:\n${brief}` },
      ], { maxTokens: 3000 });
      const path = join(dir, agent.file); // file name is ours, never the model's
      writeFileSync(path, stripFences(reply));
      this.log(`  [${agent.title}] wrote ${agent.file}`);
      return { agent: agent.id, file: agent.file, path };
    });
    const deliverables = files.filter((f) => f.value).map((f) => f.value);
    const failures = files.map((f, i) => f.error && { agent: FILE_AGENTS[i].id, error: f.error.message }).filter(Boolean);
    failures.forEach((f) => this.log(`  [${f.agent}] FAILED: ${f.error}`));

    let tasks = [];
    try {
      const plan = await this.llm.chatJSON([
        { role: 'system', content: OPERATIONS_MANAGER.system },
        { role: 'user', content: `Opportunity brief:\n${brief}\n\nDeliverables ready: ${deliverables.map((d) => d.file).join(', ') || 'none'}` },
      ], { temperature: 0.3 });
      tasks = normaliseTasks(plan);
      writeFileSync(join(dir, 'plan.json'), JSON.stringify({ tasks }, null, 2));
      this.log(`  [${OPERATIONS_MANAGER.title}] planned ${tasks.length} tasks`);
    } catch (err) {
      failures.push({ agent: OPERATIONS_MANAGER.id, error: err.message });
      this.log(`  [${OPERATIONS_MANAGER.title}] FAILED: ${err.message}`);
    }

    const approvalsRequested = tasks.filter((t) => t.type === 'external').map((t) => this.approvals.add({
      runId: run.id,
      opportunity: opp.name,
      kind: t.kind,
      title: t.title,
      details: t.details,
      day: t.day,
      costUsd: t.cost_usd,
      artifact: t.artifact && deliverables.some((d) => d.file === t.artifact) ? join(dir, t.artifact) : null,
    }));
    if (approvalsRequested.length) this.log(`  ${approvalsRequested.length} external actions waiting for approval`);

    return { opportunity: opp.name, workspace: dir, deliverables, tasks, approvals: approvalsRequested.map((a) => a.id), failures };
  }
}

export function normaliseTasks(plan) {
  const list = Array.isArray(plan) ? plan : plan?.tasks ?? [];
  return list.filter((t) => t && typeof t.title === 'string' && t.title.trim()).map((t) => {
    const kind = EXTERNAL_KINDS.includes(t.kind) ? t.kind : 'internal';
    // Fail safe: anything flagged external, or with a non-internal kind, or costing money, needs approval.
    const external = t.type === 'external' || kind !== 'internal' || Number(t.cost_usd) > 0;
    return {
      day: Number(t.day) || 1,
      title: t.title.trim(),
      type: external ? 'external' : 'internal',
      kind: external ? (kind === 'internal' ? (Number(t.cost_usd) > 0 ? 'spend_money' : 'other_external') : kind) : 'internal',
      details: t.details ?? '',
      artifact: t.artifact ?? '',
      cost_usd: Number(t.cost_usd) || 0,
    };
  });
}

export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'opportunity';
}

export function stripFences(text) {
  const m = /^\s*```[a-z]*\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  return (m ? m[1] : text).trim() + '\n';
}
