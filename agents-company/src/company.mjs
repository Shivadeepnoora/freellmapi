// The company: Research Director finds income sources, the CEO distributes
// each one to every department sub-agent (in parallel, with a concurrency cap),
// scores are aggregated and ranked, and the CEO writes the decision memo.
import { RESEARCH_DIRECTOR, DEPARTMENTS, CEO } from './agents/roles.mjs';
import { runPool } from './pool.mjs';

export class Company {
  constructor({ llm, memory, config, log = () => {} }) {
    this.llm = llm;
    this.memory = memory;
    this.config = config;
    this.log = log;
  }

  async run() {
    const { focus, opportunities: count, concurrency } = this.config;
    const run = { id: new Date().toISOString().replace(/[:.]/g, '-'), focus, startedAt: new Date().toISOString() };

    // 1. Research
    this.log(`[Research Director] researching ${count} income sources: ${focus}`);
    const known = this.memory.knownOpportunityNames();
    const research = await this.llm.chatJSON([
      { role: 'system', content: RESEARCH_DIRECTOR.system },
      {
        role: 'user',
        content: `Focus: ${focus}\nReturn exactly ${count} distinct opportunities.` +
          (known.length ? `\nAlready researched in earlier runs (find NEW ones): ${known.join('; ')}` : ''),
      },
    ]);
    const opps = normaliseOpportunities(research, count);
    if (!opps.length) throw new Error('Research Director returned no opportunities');

    // 2. Distribute: every (opportunity, department) pair is one sub-agent task.
    const tasks = opps.flatMap((opp) => DEPARTMENTS.map((dept) => ({ opp, dept })));
    this.log(`[CEO] distributing ${opps.length} opportunities to ${DEPARTMENTS.length} departments (${tasks.length} tasks, ${concurrency} at a time)`);
    const results = await runPool(tasks, concurrency, async ({ opp, dept }) => {
      const report = await this.llm.chatJSON([
        { role: 'system', content: dept.system },
        { role: 'user', content: `Opportunity:\n${JSON.stringify(opp, null, 2)}` },
      ]);
      this.log(`  [${dept.title}] done: ${opp.name}`);
      return report;
    });

    // 3. Aggregate and rank
    const byOpp = new Map(opps.map((o) => [o.id, { ...o, reports: {}, failures: [] }]));
    results.forEach((r, i) => {
      const { opp, dept } = tasks[i];
      const entry = byOpp.get(opp.id);
      if (r.error) {
        entry.failures.push({ department: dept.id, error: String(r.error.message ?? r.error) });
        this.log(`  [${dept.title}] FAILED on ${opp.name}: ${r.error.message}`);
      } else entry.reports[dept.id] = r.value;
    });
    const ranked = [...byOpp.values()].map(scoreOpportunity).sort((a, b) => b.totalScore - a.totalScore);

    // 4. CEO decision
    this.log('[CEO] writing decision memo');
    let decision;
    try {
      decision = await this.llm.chatJSON([
        { role: 'system', content: CEO.system },
        { role: 'user', content: `Ranked opportunities with department reports:\n${JSON.stringify(ranked.map(compactForCeo), null, 2)}\n\nBest past opportunities from memory:\n${JSON.stringify(this.memory.topOpportunities())}` },
      ], { temperature: 0.3 });
    } catch (err) {
      decision = { executive_summary: `CEO step failed: ${err.message}`, priorities: ranked.slice(0, 2).map((r) => r.name), next_actions: [] };
    }

    Object.assign(run, { opportunities: opps, ranked, decision, finishedAt: new Date().toISOString() });
    this.memory.recordRun(run);
    return run;
  }
}

export function normaliseOpportunities(research, count) {
  const list = Array.isArray(research) ? research : research?.opportunities ?? [];
  const seen = new Set();
  return list
    .filter((o) => o && typeof o.name === 'string' && o.name.trim())
    .filter((o) => {
      const key = o.name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, count)
    .map((o, i) => ({ ...o, id: `opp-${i + 1}`, name: o.name.trim(), category: o.category ?? 'uncategorised' }));
}

export function scoreOpportunity(entry) {
  const scores = Object.values(entry.reports)
    .map((r) => Number(r?.score))
    .filter((s) => Number.isFinite(s))
    .map((s) => Math.min(10, Math.max(0, s)));
  // Missing departments count as 0 so a half-analysed idea cannot outrank a fully analysed one.
  const totalScore = Math.round((scores.reduce((a, b) => a + b, 0) / DEPARTMENTS.length) * 10) / 10;
  return { ...entry, totalScore };
}

function compactForCeo(r) {
  return { name: r.name, category: r.category, totalScore: r.totalScore, summary: r.summary, reports: r.reports, failures: r.failures.length };
}
