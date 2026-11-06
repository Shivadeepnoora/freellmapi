# AI Agents Company

A small company made of AI agents. It researches income sources, gives each one to specialist
sub-agents for analysis, ranks the results, has a CEO agent decide what to do next, and then
**acts**: action agents build real deliverables for the top ideas and plan the next 14 days.
Anything that touches the outside world waits for your approval. It can
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
                                │
                    CEO picks the top ideas (--execute-top)
   ┌──────────────┬─────────────┬──────────────┬───────────────┬───────────────┐
   │   Product    │   Content   │   Sales &    │  Automation   │  Operations   │
   │   Builder    │   Writer    │   Outreach   │   Builder     │   Manager     │
   └──────┬───────┴──────┬──────┴──────┬───────┴───────┬───────┴───────┬───────┘
   landing-page.html  content.md   outreach.md   automation.mjs    plan.json
          └────────── written to the workspace ──────────┘             │
                                                   external tasks → approval queue
                                                   you approve → webhook executes
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
5. **Act**: for the top ideas (`--execute-top`, default 2), the action agents write their
   deliverables to `data/workspace/<run>/<idea>/`. The Operations Manager then writes a 14-day
   plan. Internal tasks are done by agents. External tasks (publish, send email, post, sign up,
   spend money) go into the approval queue. If a task costs money or has an unrecognised
   external kind, it always needs approval, even when the model labels it internal.
6. **Remember and report**: results and action statuses go to `data/memory.json`, so the next
   run's CEO knows what you approved or rejected. Reports go to
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

## Approve and execute actions

The agents never publish, email, post or spend on their own. You decide:

```bash
node src/cli.mjs approvals              # what is waiting (with the file each action uses)
node src/cli.mjs approve act-0001 act-0003 --note "ship it"
node src/cli.mjs reject act-0002
node src/cli.mjs approve all
node src/cli.mjs execute                # carry out everything approved
node src/cli.mjs approvals --all        # full history with statuses
```

`execute` POSTs each approved action as `{"action": {...}}` to `AGENTS_WEBHOOK_URL`, plus an
`x-agents-secret` header if `AGENTS_WEBHOOK_SECRET` is set. Point the URL at an n8n, Zapier or
Make workflow, or your own service, that does the real work: deploy the landing page, schedule
the posts, send the emails. Each action ends up `executed` or `failed`. Without a webhook,
approved actions are marked `manual` and listed for you to do by hand.

To research without acting, pass `--no-act` or set `AGENTS_ACT=0`.

## Automate it

Built-in scheduler. Each cycle first sends out whatever you approved since the last cycle, then
runs research and acts. Overlapping cycles are skipped:

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
| `--no-act` | `AGENTS_ACT=0` | acting on |
| `--execute-top` | `AGENTS_EXECUTE_TOP` | `2` |
| `--webhook` | `AGENTS_WEBHOOK_URL` | — (manual) |
| (env only) | `AGENTS_WEBHOOK_SECRET` | — |

## Extend it

Add a department by appending to `DEPARTMENTS` in `src/agents/roles.mjs`. Give it a system
prompt that returns JSON with a `score`. The orchestrator, ranking and report pick it up
automatically. Add an action agent by appending to `FILE_AGENTS` in
`src/agents/action-roles.mjs` with a fixed output file name.

## Caveats

The output is LLM-generated research, not financial or legal advice. Free-tier models can be
wrong about market sizes and revenue figures. Treat the numbers as hypotheses to check, and
keep humans in charge of anything involving money, contracts or publishing. The approval queue
exists for that reason. Read the generated files, especially `automation.mjs`, before you use
or run them.

## Tests

```bash
npm test
```
