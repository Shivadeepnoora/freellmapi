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
  const lines = [
    `# AI Agents Company — Income Research Report`,
    ``,
    `Run \`${run.id}\` · focus: ${run.focus}`,
    ``,
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
    `| # | Opportunity | Category | Score | ${DEPARTMENTS.map((d) => d.title).join(' | ')} |`,
    `|---|---|---|---|${DEPARTMENTS.map(() => '---').join('|')}|`,
    ...run.ranked.map((r, i) =>
      `| ${i + 1} | ${r.name} | ${r.category} | ${r.totalScore} | ${DEPARTMENTS.map((d) => r.reports[d.id]?.score ?? '—').join(' | ')} |`),
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
    for (const d of DEPARTMENTS) {
      const rep = r.reports[d.id];
      lines.push(`### ${d.title}`, ``);
      if (!rep) { lines.push('_No report (department failed)._', ''); continue; }
      for (const [k, v] of Object.entries(rep)) {
        lines.push(Array.isArray(v) ? `**${k}**\n${list(v)}` : `**${k}:** ${v}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
