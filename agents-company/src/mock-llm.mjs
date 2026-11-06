// Offline stand-in for the LLM so the whole company can run (and be tested)
// without a server. It answers by role, recognised from the system prompt.
const SAMPLE = [
  { name: 'Niche newsletter with sponsorships', category: 'content' },
  { name: 'Micro-SaaS for small agencies', category: 'software' },
  { name: 'Freelance AI automation services', category: 'services' },
  { name: 'Digital templates marketplace store', category: 'digital products' },
  { name: 'Affiliate review site for dev tools', category: 'affiliate' },
  { name: 'Paid online cohort course', category: 'education' },
  { name: 'API-as-a-product for a data niche', category: 'software' },
];

const FILES = {
  product_builder: '```html\n<!doctype html><html><head><title>Launch</title></head><body><h1>Coming soon</h1><form action="#"><input type="email"><button>Join</button></form></body></html>\n```',
  content_writer: '# Launch post\n\nWhy this matters...\n\n## Social posts\n1. We are building something.',
  sales_rep: '# Outreach\n\nHi {{first_name}}, ...\n\nReply STOP to opt out.',
  automation_builder: '// Generates weekly content drafts locally.\nconsole.log("draft written");',
};

export class MockLLMClient {
  constructor() { this.calls = []; }

  async chat(messages) {
    const system = messages[0]?.content ?? '';
    const user = messages.at(-1)?.content ?? '';
    this.calls.push({ system, user });
    const role = /ROLE:\s*([a-z_]+)/.exec(system)?.[1];
    if (role in FILES) return FILES[role];
    return JSON.stringify(this.#answer(role, user));
  }

  async chatJSON(messages) { return JSON.parse(await this.chat(messages)); }

  #answer(role, user) {
    const count = Number(/exactly (\d+)/.exec(user)?.[1] ?? 5);
    const avoid = user.toLowerCase();
    switch (role) {
      case 'research_director':
        return {
          opportunities: SAMPLE.filter((s) => !avoid.includes(s.name.toLowerCase())).slice(0, count).map((s, i) => ({
            id: `opp-${i + 1}`,
            ...s,
            summary: `${s.name}: a repeatable income stream in ${s.category}.`,
            why_now: 'Free AI tooling has cut the cost to start.',
            startup_cost_usd: 100 * (i + 1),
            time_to_first_revenue_weeks: 2 + i,
          })),
        };
      case 'market_analyst':
        return { demand: 'medium', competition: 'medium', target_customer: 'small businesses', score: 7, evidence: ['Search interest growing'] };
      case 'financial_analyst':
        return { monthly_revenue_month_6_usd: 1500, monthly_costs_usd: 120, break_even_month: 3, score: 7, assumptions: ['2% conversion'] };
      case 'automation_engineer':
        return { automatable_percent: 70, workflow: ['Research topics', 'Draft with LLM', 'Human review', 'Publish', 'Report metrics'], tools: ['FreeLLMAPI', 'cron'], score: 8 };
      case 'marketing_strategist':
        return { channels: ['SEO', 'X/Twitter', 'Communities'], first_30_days: ['Launch landing page', 'Post 10 pieces'], score: 6 };
      case 'risk_officer':
        return { risks: ['Platform dependence'], legal_notes: ['Disclose affiliate links'], ethical_flags: [], score: 8 };
      case 'operations_manager':
        return {
          tasks: [
            { day: 1, title: 'Review generated landing page', type: 'internal', kind: 'internal', artifact: 'landing-page.html' },
            { day: 2, title: 'Publish landing page', type: 'external', kind: 'publish', artifact: 'landing-page.html', details: 'Deploy to static host' },
            { day: 3, title: 'Post launch thread', type: 'external', kind: 'post_social', artifact: 'content.md' },
            { day: 5, title: 'Buy domain', type: 'internal', kind: 'internal', cost_usd: 12 },
          ],
        };
      case 'ceo':
        return { executive_summary: 'Prioritise the highest-scoring, most automatable streams.', priorities: ['Start with the top 2 ranked opportunities'], next_actions: ['Build MVP for #1 this week'] };
      default:
        return { note: 'unknown role' };
    }
  }
}
