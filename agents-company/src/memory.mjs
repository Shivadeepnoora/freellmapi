// Long-term company memory: a JSON file that survives between runs so the
// company does not re-research the same ideas and can build on past verdicts.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const EMPTY = { runs: [], opportunities: {} };

export class CompanyMemory {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = join(dataDir, 'memory.json');
    mkdirSync(dataDir, { recursive: true });
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : structuredClone(EMPTY);
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
        name: r.name,
        category: r.category,
        lastScore: r.totalScore,
        timesSeen: (prev?.timesSeen ?? 0) + 1,
        lastRun: run.id,
      };
    }
    this.save();
  }

  topOpportunities(n = 5) {
    return Object.values(this.state.opportunities).sort((a, b) => b.lastScore - a.lastScore).slice(0, n);
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }
}
