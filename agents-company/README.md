# AI Agents Company

A small company made of AI agents. It researches income sources, gives each one to specialist
sub-agents for analysis, ranks the results, and has a CEO agent decide what to do next. It can
run on a schedule and keeps a memory between runs. All LLM calls go through
FreeLLMAPI's OpenAI-compatible `/v1` endpoint, so it runs on free-tier models.

No dependencies beyond Node ≥ 20.

## Org chart

```
                         ┌──────────────┐
                         │     CEO      │  decides priorities and next actions
                         └──────┬───────┘
                                │ ranked reports + memory
                ┌───────────────┴────────────────┐
                │      Research Director         │  finds N income sources
                └───────────────┬────────────────┘
          each opportunity is sent to every department (in parallel)
   ┌─────────────┬──────────────┬───────────────┬───────────────┬─────────────┐
   │   Market    │  Financial   │  Automation   │   Marketing   │   Risk &    │
   │   Analyst   │   Analyst    │   Engineer    │   Strategist  │ Compliance  │
   └─────────────┴──────────────┴───────────────┴───────────────┴─────────────┘
         each returns a structured JSON report with a 1–10 score
```

One cycle:

1. **Research**: the Research Director proposes `N` legal, low-capital income sources. Ideas
   already in memory are excluded, so each run finds new ones.
2. **Distribute**: every opportunity × department pair becomes a sub-agent task, run through a
   worker pool (`--concurrency`) with retries and backoff on 429 or 5xx. If one department
   fails, its failure is recorded and the run continues.
3. **Rank**: scores are averaged across all five departments. A missing report counts as 0, so a
   half-analysed idea can't outrank a fully analysed one.
4. **Decide**: the CEO reads the ranking plus the best ideas from memory and writes priorities
   and next actions.
5. **Remember and report**: results go to `data/memory.json`. Reports go to
   `data/reports/<run>.json`, `<run>.md` and `latest.md`.

## Quick start

```bash
# offline demo, no server or keys needed
node src/cli.mjs run --mock
```

With real models, start FreeLLMAPI first (`npm run dev` at the repo root), add provider keys,
and copy the unified API key from the Keys page:

```bash
export FREELLMAPI_API_KEY=<unified key>
node src/cli.mjs run --focus "passive income from developer tools" -n 5
```

## Automate it

Built-in scheduler (runs now, then every interval; overlapping cycles are skipped):

```bash
node src/cli.mjs daemon --interval 24h
```

Or with cron, every day at 07:00:

```
0 7 * * * cd /path/to/freellmapi/agents-company && FREELLMAPI_API_KEY=... node src/cli.mjs run >> data/cron.log 2>&1
```

See what the company remembers:

```bash
node src/cli.mjs memory
```

## Configuration

| Flag | Env | Default |
|---|---|---|
| `--base-url` | `FREELLMAPI_BASE_URL` | `http://localhost:3001/v1` |
| (env only) | `FREELLMAPI_API_KEY` | — |
| `--model` | `AGENTS_MODEL` | `auto` (FreeLLMAPI's router picks) |
| `--focus` | `AGENTS_FOCUS` | online income for a solo founder |
| `-n, --opportunities` | `AGENTS_OPPORTUNITIES` | `5` |
| `-c, --concurrency` | `AGENTS_CONCURRENCY` | `3` |
| `--interval` | `AGENTS_INTERVAL` | `24h` |
| `--data-dir` | `AGENTS_DATA_DIR` | `./data` |
| `--mock` | `AGENTS_MOCK=1` | off |

## Extend it

Add a department by appending to `DEPARTMENTS` in `src/agents/roles.mjs`. Give it a system
prompt that returns JSON with a `score`. The orchestrator, ranking and report pick it up
automatically.

## Caveats

The output is LLM-generated research, not financial or legal advice. Free-tier models can be
wrong about market sizes and revenue figures. Treat the numbers as hypotheses to check, and
keep humans in charge of anything involving money, contracts or publishing.

## Tests

```bash
npm test
```
