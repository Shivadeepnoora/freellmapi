// Writes each run as JSON (for machines) and Markdown (for people).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEPARTMENTS } from './agents/roles.mjs';

export function writeReports(run, dataDir) {
  const dir = join(dataDir, 'reports');
  mkdirSync(dir, { recursive: true });
  const json = join(dir, `${run.id}.json`);
  const md = join(dir, `${run.id}.md`);
  writeFileSync(json, JSON.stringify(run, null, 2));
  writeFileSync(md, toMarkdown(run));
  writeFileSync(join(dir, 'latest.md'), toMarkdown(run));
  return { json, md };
}

export function toMarkdown(run) {
  const list = (xs) => (Array.isArray(xs) && xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none)');
  const sourceById = new Map((run.research?.sources ?? []).map((src) => [src.id, src]));
  const cite = (ids) => (ids ?? []).map((id) => sourceById.get(id)).filter(Boolean).map((src) => `[${src.id}](${src.url})`).join(' ');

  const lines = [
    `# AI Agents Company — Income Research Report`,
    ``,
    `Run \`${run.id}\` · focus: ${run.focus}`,
    ``,
    ...researchBanner(run),
    `## CEO decision`,
    ``,
    run.decision?.executive_summary ?? '',
    ``,
    `**Priorities**`,
    list(run.decision?.priorities),
    ``,
    `**Next actions**`,
    list(run.decision?.next_actions),
    ``,
    `## Ranking`,
    ``,
    `| # | Opportunity | Category | Score | Evidence | ${DEPARTMENTS.map((d) => d.title).join(' | ')} |`,
    `|---|---|---|---|---|${DEPARTMENTS.map(() => '---').join('|')}|`,
    ...run.ranked.map((r, i) =>
      `| ${i + 1} | ${r.name} | ${r.category} | ${r.totalScore} | ${evidenceLabel(r)} | ${DEPARTMENTS.map((d) => r.reports[d.id]?.score ?? '—').join(' | ')} |`),
    ``,
  ];
  if (run.execution?.length) {
    lines.push(`## Actions taken`, ``);
    for (const e of run.execution) {
      lines.push(`### ${e.opportunity}`, ``, `Workspace: \`${e.workspace}\``, ``, `**Deliverables built**`, list(e.deliverables.map((d) => d.file)), ``);
      lines.push(`**14-day plan**`, ``, `| Day | Task | Type | Needs approval |`, `|---|---|---|---|`);
      e.tasks.forEach((t) => lines.push(`| ${t.day} | ${t.title} | ${t.kind} | ${t.type === 'external' ? 'yes' : 'no'} |`));
      lines.push(``, `**Waiting for your approval:** ${e.approvals.join(', ') || 'none'}`);
      if (e.failures.length) lines.push(``, `**Failures:** ${e.failures.map((f) => `${f.agent}: ${f.error}`).join('; ')}`);
      lines.push(``);
    }
    lines.push(`Approve with \`node src/cli.mjs approve <id|all>\`, then \`node src/cli.mjs execute\`.`, ``);
  }
  for (const r of run.ranked) {
    lines.push(`## ${r.name}`, ``, r.summary ?? '', ``);
    if (r.verified === false) lines.push(`> ⚠ No sources were cited for this opportunity. Treat its figures as unverified estimates.`, ``);
    else if (r.sources?.length) lines.push(`Sources: ${cite(r.sources)}`, ``);
    for (const d of DEPARTMENTS) {
      const rep = r.reports[d.id];
      lines.push(`### ${d.title}`, ``);
      if (!rep) { lines.push('_No report (department failed)._', ''); continue; }
      for (const [k, v] of Object.entries(rep)) {
        if (k === 'sources') continue;
        lines.push(Array.isArray(v) ? `**${k}**\n${list(v)}` : `**${k}:** ${v}`);
      }
      if (rep.sources?.length) lines.push(`**sources:** ${cite(rep.sources)}`);
      lines.push('');
    }
  }
  if (run.research?.sources?.length) {
    lines.push(`## Sources`, ``, ...run.research.sources.map((src) => `- **${src.id}** [${src.title.replace(/[[\]]/g, '')}](${src.url})`), ``);
  }
  if (run.usage) {
    const u = run.usage;
    lines.push(`## Usage`, ``, `- LLM: ${u.provider ?? '?'} / ${u.model ?? '?'}, ${u.calls ?? 0} calls, ${u.inputTokens ?? 0} input + ${u.outputTokens ?? 0} output tokens`);
    if (u.estimatedCostUsd != null) lines.push(`- Estimated LLM cost: $${u.estimatedCostUsd}`);
    lines.push(`- Web searches: ${u.searches ?? 0}`, ``);
  }
  return lines.join('\n');
}

function researchBanner(run) {
  const r = run.research;
  if (!r) return [];
  if (!r.live) {
    return [`> ⚠ **No live web sources.** This research comes from model knowledge only (search: ${r.provider}). Check every figure before acting on it.`, ``];
  }
  const failed = r.failures?.length ? `, ${r.failures.length} failed` : '';
  return [`Research grounded in ${r.sources.length} web sources from ${r.queries.length} searches (${r.provider}${failed}).`, ``];
}

function evidenceLabel(r) {
  if (r.verified === undefined) return '—';
  const n = r.citedSources.length;
  return r.verified ? `${n} source${n === 1 ? '' : 's'}` : '⚠ unverified';
}
