// The company: the Research Planner writes web searches, the Research Director
// proposes income sources grounded in those results, each opportunity gets its
// own targeted searches and is sent to every department sub-agent (in
// parallel, with a concurrency cap), scores are aggregated and ranked, and the
// CEO writes the decision memo. Every claim cites a source id (S1, S2, …).
import { RESEARCH_PLANNER, RESEARCH_DIRECTOR, DEPARTMENTS, CEO } from './agents/roles.mjs';
import { SourceLibrary, gather } from './search.mjs';
import { runPool } from './pool.mjs';
import { ExecutionTeam } from './execution.mjs';

export class Company {
  constructor({ llm, memory, config, approvals = null, search = null, log = () => {} }) {
    this.llm = llm;
    this.search = search;
    this.approvals = approvals;
    this.memory = memory;
    this.config = config;
    this.log = log;
  }

  async run() {
    const { focus, opportunities: count, concurrency } = this.config;
    const run = { id: new Date().toISOString().replace(/[:.]/g, '-'), focus, startedAt: new Date().toISOString() };

    this.llm.takeUsage?.(); // start this run's usage count from zero
    const searchesBefore = this.search?.count ?? 0;
    const library = new SourceLibrary();
    const known = this.memory.knownOpportunityNames();
    const avoid = known.length ? `\nAlready researched in earlier runs (find NEW ones): ${known.join('; ')}` : '';

    // 1a. Live web research
    if (this.search) {
      this.log(`[Research Planner] planning ${this.config.searchQueries} web searches`);
      try {
        const plan = await this.llm.chatJSON([
          { role: 'system', content: RESEARCH_PLANNER.system },
          { role: 'user', content: `Focus: ${focus}\nToday: ${run.startedAt.slice(0, 10)}\nWrite exactly ${this.config.searchQueries} queries.${avoid}` },
        ], { temperature: 0.4 });
        await gather(this.search, library, normaliseQueries(plan, this.config.searchQueries), { concurrency, log: this.log });
      } catch (err) {
        this.log(`[Research Planner] FAILED: ${err.message}; continuing without the broad search`);
      }
    }

    // 1b. Research Director proposes opportunities grounded in the sources
    this.log(`[Research Director] proposing ${count} income sources from ${library.all().length} sources: ${focus}`);
    const research = await this.llm.chatJSON([
      { role: 'system', content: RESEARCH_DIRECTOR.system },
      { role: 'user', content: `Focus: ${focus}\nReturn exactly ${count} distinct opportunities.${avoid}\n\n${library.toPrompt()}` },
    ], { tier: 'strong' });
    const opps = normaliseOpportunities(research, count).map((o) => ({ ...o, sources: library.validIds(o.sources) }));
    if (!opps.length) throw new Error('Research Director returned no opportunities');

    // 1c. Targeted evidence for each opportunity, shared by all its departments
    const evidence = new Map(opps.map((o) => [o.id, o.sources.map((id) => library.get(id))]));
    if (this.search) {
      this.log(`[Research] gathering evidence for ${opps.length} opportunities`);
      await runPool(opps, concurrency, async (opp) => {
        const hits = await gather(this.search, library, evidenceQueries(opp), { concurrency: 2, log: this.log });
        evidence.set(opp.id, uniqueById([...evidence.get(opp.id), ...hits]));
      });
    }

    // 2. Distribute: every (opportunity, department) pair is one sub-agent task.
    const tasks = opps.flatMap((opp) => DEPARTMENTS.map((dept) => ({ opp, dept })));
    this.log(`[CEO] distributing ${opps.length} opportunities to ${DEPARTMENTS.length} departments (${tasks.length} tasks, ${concurrency} at a time)`);
    const results = await runPool(tasks, concurrency, async ({ opp, dept }) => {
      const report = await this.llm.chatJSON([
        { role: 'system', content: dept.system },
        { role: 'user', content: `Opportunity:\n${JSON.stringify(opp, null, 2)}\n\n${library.toPrompt(evidence.get(opp.id))}` },
      ]);
      this.log(`  [${dept.title}] done: ${opp.name}`);
      return report && typeof report === 'object' ? { ...report, sources: library.validIds(report.sources) } : report;
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
    const ranked = [...byOpp.values()]
      .map((o) => ({ ...scoreOpportunity(o), citedSources: citedSources(o) }))
      .map((o) => ({ ...o, verified: o.citedSources.length > 0 }))
      .sort((a, b) => b.totalScore - a.totalScore);

    // 4. CEO decision
    this.log('[CEO] writing decision memo');
    let decision;
    try {
      decision = await this.llm.chatJSON([
        { role: 'system', content: CEO.system },
        { role: 'user', content: `Ranked opportunities with department reports:\n${JSON.stringify(ranked.map(compactForCeo), null, 2)}\n\nBest past opportunities from memory:\n${JSON.stringify(this.memory.topOpportunities())}\n\nActions from earlier runs (status):\n${JSON.stringify(this.memory.recentActions(10, this.approvals))}` },
      ], { temperature: 0.3, tier: 'strong' });
    } catch (err) {
      decision = { executive_summary: `CEO step failed: ${err.message}`, priorities: ranked.slice(0, 2).map((r) => r.name), next_actions: [] };
    }

    // 5. Act on the decision: build deliverables, plan, queue external actions for approval.
    let execution = [];
    if (this.config.act && this.approvals) {
      execution = await new ExecutionTeam({ llm: this.llm, approvals: this.approvals, config: this.config, log: this.log }).execute({ id: run.id, ranked, decision });
    }

    const researchSummary = {
      live: library.all().length > 0,
      provider: this.search ? this.config.searchProvider : 'off',
      queries: library.queries,
      failures: library.failures,
      sources: library.all().map(({ id, title, url }) => ({ id, title, url })),
    };
    const usage = { ...(this.llm.takeUsage?.() ?? {}), searches: (this.search?.count ?? 0) - searchesBefore, model: this.config.model, provider: this.config.provider };
    Object.assign(run, { opportunities: opps, ranked, decision, execution, research: researchSummary, usage, finishedAt: new Date().toISOString() });
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

export function normaliseQueries(plan, max) {
  const list = Array.isArray(plan) ? plan : plan?.queries ?? [];
  const seen = new Set();
  return list
    .filter((q) => typeof q === 'string')
    .map((q) => q.replace(/\s+/g, ' ').trim().slice(0, 200))
    .filter((q) => q && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()))
    .slice(0, max);
}

export function evidenceQueries(opp) {
  return [`${opp.name} market size demand`, `${opp.name} competitors pricing`];
}

function citedSources(entry) {
  const ids = [...(entry.sources ?? []), ...Object.values(entry.reports).flatMap((r) => r?.sources ?? [])];
  return [...new Set(ids)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function uniqueById(sources) {
  return [...new Map(sources.filter(Boolean).map((s) => [s.id, s])).values()];
}

function compactForCeo(r) {
  return { name: r.name, category: r.category, totalScore: r.totalScore, verified: r.verified, summary: r.summary, reports: r.reports, failures: r.failures.length };
}
