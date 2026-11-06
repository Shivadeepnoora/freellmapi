// Long-term company memory: a JSON file that survives between runs so the
// company does not re-research the same ideas and can build on past verdicts.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const EMPTY = { runs: [], opportunities: {}, actions: [] };

export class CompanyMemory {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = join(dataDir, 'memory.json');
    mkdirSync(dataDir, { recursive: true });
    this.state = { ...structuredClone(EMPTY), ...(existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {}) };
  }

  knownOpportunityNames() {
    return Object.values(this.state.opportunities).map((o) => o.name);
  }

  recordRun(run) {
    this.state.runs.push({ id: run.id, at: run.finishedAt, focus: run.focus, ranked: run.ranked.map((r) => r.name) });
    for (const r of run.ranked) {
      const key = r.name.toLowerCase();
      const prev = this.state.opportunities[key];
      this.state.opportunities[key] = {
        ...prev, // keep traction and history recorded earlier
        name: r.name,
        category: r.category,
        lastScore: r.totalScore,
        timesSeen: (prev?.timesSeen ?? 0) + 1,
        lastRun: run.id,
      };
    }
    for (const e of run.execution ?? []) {
      this.state.actions.push({ run: run.id, opportunity: e.opportunity, deliverables: e.deliverables.map((d) => d.file), approvals: e.approvals });
    }
    this.save();
  }

  // Latest action records, with the current approval status merged in.
  recentActions(n = 10, approvals = null) {
    return this.state.actions.slice(-n).map((a) => ({
      ...a,
      approvals: a.approvals.map((id) => ({ id, status: approvals?.get(id)?.status ?? 'unknown' })),
    }));
  }

  // Stores the latest live results on each launched opportunity. Counts only:
  // emails never reach memory (or the LLM prompts built from it).
  recordResults(results, at = new Date().toISOString()) {
    for (const r of results) {
      const key = r.opportunity.toLowerCase();
      const prev = this.state.opportunities[key] ?? { name: r.opportunity, category: 'uncategorised', lastScore: 0, timesSeen: 0 };
      const traction = { views: r.views, signups: r.signups, conversion: r.conversion, tractionScore: r.tractionScore, verdict: r.verdict, url: r.url, at };
      this.state.opportunities[key] = { ...prev, traction, tractionHistory: [...(prev.tractionHistory ?? []), traction].slice(-30) };
    }
    if (results.length) this.save();
  }

  // Ranking that blends what the agents thought (lastScore) with what the
  // market did (tractionScore) once there is enough data. Market evidence
  // counts as much as the whole analysis.
  topOpportunities(n = 5) {
    return Object.values(this.state.opportunities)
      .map((o) => ({ ...o, combinedScore: combinedScore(o) }))
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, n)
      .map(({ tractionHistory, ...o }) => o);
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }
}

export function combinedScore(o) {
  const t = o.traction?.tractionScore;
  return t == null ? o.lastScore : Math.round(((o.lastScore + t) / 2) * 10) / 10;
}
