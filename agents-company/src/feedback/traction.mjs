// Turns live page results into a score and a verdict the company acts on.
//
//   conversion   = signups / views
//   tractionScore = 10 × conversion / target, capped at 10
//                   (with the default 5% target: 1% → 2, 3% → 6, 5%+ → 10)
//   verdict      collecting data  fewer than minViews views, too early to judge
//                scale            score ≥ 7, double down
//                iterate          score 3–7, improve the offer, page or audience
//                kill             score < 3 after enough views, stop spending effort
//
// The thresholds are deliberately simple so a human can sanity-check them;
// tune them with AGENTS_MIN_VIEWS and AGENTS_TARGET_CONVERSION.

export const VERDICTS = ['collecting data', 'scale', 'iterate', 'kill'];

export function evaluateTraction({ views = 0, signups = 0 }, { minViews = 100, targetConversion = 0.05 } = {}) {
  const conversion = views > 0 ? signups / views : 0;
  if (views < minViews) {
    return { views, signups, conversion: round(conversion, 4), tractionScore: null, verdict: 'collecting data' };
  }
  const tractionScore = round(Math.min(10, (10 * conversion) / targetConversion), 1);
  const verdict = tractionScore >= 7 ? 'scale' : tractionScore >= 3 ? 'iterate' : 'kill';
  return { views, signups, conversion: round(conversion, 4), tractionScore, verdict };
}

// Matches every published page (an executed GitHub Pages action) with its
// counts. Re-published pages keep one row, using the latest publish.
export async function collectResults({ approvals, metrics, config, now = new Date(), log = () => {} }) {
  if (!approvals || !metrics) return [];
  const launched = new Map();
  for (const a of approvals.list('executed')) {
    if (!a.page || !a.resultUrl) continue;
    const prev = launched.get(a.page);
    if (!prev || a.executedAt > prev.executedAt) launched.set(a.page, a);
  }
  if (!launched.size) return [];

  let stats;
  try {
    stats = await metrics.stats();
  } catch (err) {
    log(`[Results] could not read page metrics: ${err.message}`);
    return [];
  }
  const opts = { minViews: config.minViews ?? 100, targetConversion: config.targetConversion ?? 0.05 };
  return [...launched.values()].map((a) => {
    const s = stats[a.page] ?? { views: 0, signups: 0 };
    const days = Math.max(0, Math.floor((now - new Date(a.executedAt)) / 864e5));
    return { page: a.page, opportunity: a.opportunity, url: a.resultUrl, publishedAt: a.executedAt, daysLive: days, ...evaluateTraction(s, opts) };
  }).sort((x, y) => (y.tractionScore ?? -1) - (x.tractionScore ?? -1) || y.views - x.views);
}

// A compact, email-free summary for prompts.
export function resultsForPrompt(results) {
  if (!results.length) return 'No landing pages are live yet, so there is no market feedback.';
  const rows = results.map((r) => `- ${r.opportunity}: ${r.views} views, ${r.signups} signups (${(r.conversion * 100).toFixed(1)}%), ${r.daysLive} days live → ${r.verdict}${r.tractionScore != null ? ` (traction ${r.tractionScore}/10)` : ''}`);
  return `Real results from landing pages already launched (this is evidence from the market and outweighs model opinion):\n${rows.join('\n')}`;
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
