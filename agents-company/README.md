# AI Agents Company

A small company made of AI agents. It researches income sources, gives each one to specialist
sub-agents for analysis, ranks the results, has a CEO agent decide what to do next, and then
**acts**: action agents build real deliverables for the top ideas and plan the next 14 days.
Anything that touches the outside world waits for your approval. It can
run on a schedule and keeps a memory between runs. Research is based on **live web search**, and
every claim cites its source. Published landing pages **collect real signups**, and each run
**learns from those results**: winners are scaled, losers are dropped, and new ideas follow what
converts.

It works with any OpenAI-compatible LLM API. FreeLLMAPI (free tiers) is the default for testing.
For the real business, switch to paid providers and set `AGENTS_ENV=production`; see
[Testing vs production](#testing-vs-production).

No dependencies beyond Node ≥ 20.

## Org chart

```
                         ┌──────────────┐
                         │     CEO      │  decides priorities and next actions
                         └──────┬───────┘
                                │ ranked reports + memory
                ┌───────────────┴────────────────┐
                │      Research Director         │  proposes N income sources from the sources
                └───────────────┬────────────────┘
                ┌───────────────┴────────────────┐
                │ Research Planner → web search  │  live sources S1, S2, … (Tavily-shaped API)
                └───────────────┬────────────────┘
     each opportunity gets its own searches (market/demand, competitors/pricing),
          then is sent to every department with that evidence (in parallel)
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

0. **Read market results**: views and signups for every landing page already live are scored
   and given a verdict (scale, iterate, kill, or collecting data). See
   [Signups and the feedback loop](#signups-and-the-feedback-loop).
1. **Research**: the Research Planner writes web searches about current demand, trends and
   pricing. The results become numbered sources. The Research Director proposes `N` legal,
   low-capital income sources based on them and on what is converting, citing source ids. Ideas
   already in memory are excluded, so each run finds new ones.
2. **Gather evidence**: each opportunity gets two targeted searches (market size and demand,
   competitors and pricing). The results go to all of its departments.
3. **Distribute**: every opportunity × department pair becomes a sub-agent task, run through a
   worker pool (`--concurrency`) with retries and backoff on 429 or 5xx. If one department
   fails, its failure is recorded and the run continues.
4. **Rank**: scores are averaged across all five departments. A missing report counts as 0, so a
   half-analysed idea can't outrank a fully analysed one. An idea where no agent cited any source
   is flagged **⚠ unverified**.
5. **Decide**: the CEO reads the ranking, the live results and the best ideas from memory. It
   writes priorities, next actions, and a decision for each launched idea. Real results outweigh
   any agent's opinion.
6. **Act**: for the top ideas (`--execute-top`, default 2), the action agents write their
   deliverables to `data/workspace/<run>/<idea>/`. The Operations Manager then writes a 14-day
   plan. Internal tasks are done by agents. External tasks (publish, send email, post, sign up,
   spend money) go into the approval queue. If a task costs money or has an unrecognised
   external kind, it always needs approval, even when the model labels it internal.
7. **Remember and report**: results and action statuses go to `data/memory.json`, so the next
   run's CEO knows what you approved or rejected. Reports go to
   `data/reports/<run>.json`, `<run>.md` and `latest.md`. Each report includes a numbered source
   list with links, the citations for every department report, and LLM and search usage, with
   an estimated cost if you set prices.

## Quick start

```bash
# offline demo, no server or keys needed
node src/cli.mjs run --mock
```

For testing with free models, start FreeLLMAPI first (`npm run dev` at the repo root). Add LLM
keys plus at least one search engine key (Tavily, Exa, Brave, …) on the Keys page, then copy
the unified API key:

```bash
export FREELLMAPI_API_KEY=<unified key>
node src/cli.mjs check
node src/cli.mjs run --focus "passive income from developer tools" -n 5
```

## Testing vs production

FreeLLMAPI's own README says free tiers are *"for personal experimentation and learning, not
production … If you build something real on top of FreeLLMAPI, swap in a paid API before you
ship."* Provider terms for free tiers often restrict commercial use as well. So use FreeLLMAPI
to try things out, and run the business on paid APIs.

**LLM provider** (`AGENTS_LLM_PROVIDER`). All of these speak the OpenAI chat-completions format:

| Provider | Base URL | Key env | Model |
|---|---|---|---|
| `freellmapi` (default) | `FREELLMAPI_BASE_URL` or `http://localhost:3001/v1` | `FREELLMAPI_API_KEY` | `auto` |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | required: `AGENTS_MODEL` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | required: `AGENTS_MODEL` |
| `custom` | `AGENTS_LLM_BASE_URL` | `AGENTS_LLM_API_KEY` | required: `AGENTS_MODEL` |

For paid providers there's no default model on purpose, because model names change. Pick one
from your provider's model list. Optionally set `AGENTS_STRONG_MODEL` to a more capable model for
the two decisions that matter most (Research Director and CEO). The ~30 department and action
calls then use the cheaper `AGENTS_MODEL`.

**Web search** (`AGENTS_SEARCH`). Both backends use Tavily's request and response format:

| Search | Endpoint | Key env |
|---|---|---|
| `auto` (default) | `freellmapi` when the LLM provider is FreeLLMAPI, else `tavily` if `TAVILY_API_KEY` is set, else `off` | |
| `freellmapi` | `<FreeLLMAPI>/v1/search`, which fails over across your search keys | `FREELLMAPI_API_KEY` |
| `tavily` | `https://api.tavily.com/search` | `TAVILY_API_KEY` |
| `custom` | `AGENTS_SEARCH_URL` (anything Tavily-compatible) | `AGENTS_SEARCH_API_KEY` |
| `off` | model knowledge only; reports are marked unverified | |

**Production mode.** With `AGENTS_ENV=production`, the run refuses to start if the LLM or search
goes through FreeLLMAPI free tiers, or if search is off. The override is
`AGENTS_ALLOW_FREE_TIER=1`. A production setup looks like:

```bash
export AGENTS_ENV=production
export AGENTS_LLM_PROVIDER=openai OPENAI_API_KEY=<key> AGENTS_MODEL=<cheap model> AGENTS_STRONG_MODEL=<strong model>
export TAVILY_API_KEY=<key>                      # search switches to tavily automatically
export AGENTS_PRICE_INPUT_PER_MTOK=<$ per 1M input tokens> AGENTS_PRICE_OUTPUT_PER_MTOK=<$ per 1M output tokens>
node src/cli.mjs check                           # prints the resolved setup; exits non-zero on problems
```

**Cost per run** (defaults: 5 ideas, 4 planning searches, top 2 acted on): 38 LLM calls (1 planner, 1 Research
Director, 25 department, 1 CEO, 10 action) and 14 searches (4 broad, plus 2 per idea). Each run logs and reports the exact token counts. With prices set, it also shows an
estimated cost, so you can check your budget against real numbers instead of guesses.

**Untrusted web content.** Search results are wrapped in a `<sources>` block, and the agents are
told to treat them as data only. Citations to source ids that were never provided are removed.
Even if a web page tries to steer the agents, nothing external happens without your approval.

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
approved actions are marked `manual` and listed for you to do by hand. Before the webhook is
tried, built-in executors get the first chance. GitHub Pages is one (below).

To research without acting, pass `--no-act` or set `AGENTS_ACT=0`.

## Publish landing pages to GitHub Pages

Approved `publish` actions for a landing page can go live on GitHub Pages at
`https://<owner>.github.io/<repo>/<idea-slug>/`. On the first publish the publisher creates the
`gh-pages` branch from your default branch and turns Pages on. Republishing the same idea updates
the page.

**1. Make a repo and a token.** Create a public repo (e.g. `alice/launches`) with at least one
commit, for example a README. Then create a
[fine-grained token](https://github.com/settings/personal-access-tokens/new) limited to that
repo, with **Contents: read and write** and **Pages: read and write**.

**2a. Built-in: no server needed.** `execute` and the daemon publish directly:

```bash
export AGENTS_GITHUB_PAGES_REPO=alice/launches
export AGENTS_GITHUB_TOKEN=<token>
node src/cli.mjs approve act-0001
node src/cli.mjs execute
node src/cli.mjs approvals --all     # shows "live: https://alice.github.io/launches/<idea>/"
```

**2b. As a webhook: run it on another machine.** The token then lives only on that machine:

```bash
# on the server
export AGENTS_WEBHOOK_SECRET=<random string, 16+ chars>   # e.g. openssl rand -hex 24
export AGENTS_GITHUB_PAGES_REPO=alice/launches AGENTS_GITHUB_TOKEN=<token>
node src/cli.mjs webhook-server --port 8787

# where the company runs
export AGENTS_WEBHOOK_URL=https://your-host:8787/ AGENTS_WEBHOOK_SECRET=<same secret>
node src/cli.mjs execute
```

The webhook server rejects requests without the right `x-agents-secret` and only publishes
actions that are `approved`, of kind `publish`, and carry HTML content. It answers
`{"status":"ignored"}` for anything else, and the company then marks that action `manual`.
`GET /healthz` reports whether Pages is configured. Put it behind HTTPS (a reverse proxy or a
tunnel) if it is reachable from the internet.

Safety limits: the executor only reads artifacts from inside `data/workspace/`, pages are capped
at 1 MB, and the target path is always `<slug>/index.html`. If Pages can't be enabled
automatically (for example the token lacks the Pages permission), the commit still lands. A
warning tells you to turn it on under repo Settings → Pages.

## Signups and the feedback loop

A landing page is only useful if it tells you whether people want the thing. So each published
page collects email signups and counts visits. Every run then reads those numbers and adjusts.

### How a page collects signups

When an approved landing page is published, the publisher prepares it:

- **Removes every script the model wrote**, so only our own reviewed code runs on your public page.
- **Adds a small signup script.** It connects the page's email form to your `/signup` endpoint,
  adds a required consent checkbox with a link to the privacy notice, adds a hidden spam trap,
  and sends one anonymous page-view beacon to `/event`.
- **Publishes `privacy.html` next to the page**, stating who runs it (`AGENTS_BUSINESS_NAME`), how
  to reach you (`AGENTS_CONTACT_EMAIL`), what is stored, and how to get data deleted. It's a
  starting template, not legal advice, so have it checked for your country.

The `webhook-server` stores the signups. It now also serves the public endpoints, so it has to be
reachable on a **public HTTPS address**. GitHub Pages is HTTPS, and browsers block form posts
from it to plain HTTP. A reverse proxy with a certificate works, as does a tunnel such as
Cloudflare Tunnel.

```bash
# on the server (the same machine can run the company too)
export AGENTS_WEBHOOK_SECRET=<random 16+ chars>
export AGENTS_GITHUB_PAGES_REPO=yourname/launches AGENTS_GITHUB_TOKEN=<token>
export AGENTS_SIGNUP_URL=https://signup.yourdomain.com      # this server's public address
export AGENTS_BUSINESS_NAME="Your Business" AGENTS_CONTACT_EMAIL=you@yourdomain.com
export AGENTS_TRUST_PROXY=1                                  # only if behind a reverse proxy/tunnel
node src/cli.mjs webhook-server --port 8787
```

| Endpoint | Who calls it | Protection |
|---|---|---|
| `POST /signup` | visitors' browsers | allowed origins only (default `https://<owner>.github.io`, or `AGENTS_SIGNUP_ALLOWED_ORIGINS`), consent required, email validated, honeypot, 10/hour per client, 4 KB body limit |
| `POST /event` | visitors' browsers | same origin check, 300/hour per client, counts views per day only |
| `GET /stats` | the company | `x-agents-secret`; returns counts, never emails |

**Privacy by design.** Email addresses are stored only in `data/signups.json` on the server.
Reports, memory and every LLM prompt only see counts (`data/metrics.json`). View counting stores
no IP address or identifier. Duplicate signups are ignored. Rate limiting uses the client
address in memory only.

Manage signups (on the machine running `webhook-server`):

```bash
node src/cli.mjs signups                       # views and signups per page
node src/cli.mjs signups --export my-idea      # CSV with emails, for your email tool
node src/cli.mjs signups --delete a@b.com      # erase a person on request
```

### How results steer the company

At the start of every run (and with `node src/cli.mjs results`), each launched page is scored:

| | Rule (defaults) |
|---|---|
| conversion | signups ÷ views |
| traction score | `10 × conversion ÷ 5%`, capped at 10 (1% → 2, 3% → 6, 5%+ → 10) |
| **collecting data** | fewer than 100 views, too early to judge |
| **🟢 scale** | traction ≥ 7 |
| **🟡 iterate** | traction 3–7 |
| **🔴 kill** | traction < 3 after 100+ views |

Tune with `AGENTS_MIN_VIEWS` and `AGENTS_TARGET_CONVERSION`. The results are then used in four
places:

1. **Research Director**: proposes new ideas close to what converts and avoids the patterns of killed ideas.
2. **CEO**: makes a decision for every launched idea. Grow the scale ones, say what to change on
   the iterate ones, stop the kill ones, and get traffic to the ones still collecting data. These
   decisions appear in the report.
3. **Long-term ranking**: memory blends the agents' score with the traction score 50/50, so an
   idea that looked great on paper but that nobody signed up for drops below one that converts.
4. **Report**: a *Live results* table with views, signups, conversion, traction and verdict per page.

The company reads results from the server's `GET /stats` when `AGENTS_SIGNUP_URL` and
`AGENTS_WEBHOOK_SECRET` are set. Otherwise it reads its local `data/metrics.json`, or you can force
that with `AGENTS_METRICS_SOURCE=local`. Pages need traffic to produce a verdict, so posting the
approved launch content is what makes the loop turn.

`check` warns, and in production refuses to run, when pages would be published without signup
capture or without the business name and contact email the privacy notice needs.

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
| `--env` | `AGENTS_ENV` | `development` (`production` enforces paid providers + search) |
| (env only) | `AGENTS_ALLOW_FREE_TIER=1` | off |
| `--provider` | `AGENTS_LLM_PROVIDER` | `freellmapi` |
| `--base-url` | `AGENTS_LLM_BASE_URL` (or `FREELLMAPI_BASE_URL`) | per provider |
| (env only) | `AGENTS_LLM_API_KEY` (or the provider's key env) | — |
| `--model` | `AGENTS_MODEL` | `auto` on FreeLLMAPI; required otherwise |
| `--strong-model` | `AGENTS_STRONG_MODEL` | same as `--model` |
| (env only) | `AGENTS_PRICE_INPUT_PER_MTOK` / `AGENTS_PRICE_OUTPUT_PER_MTOK` | — (no cost estimate) |
| `--search` | `AGENTS_SEARCH` | `auto` |
| (env only) | `TAVILY_API_KEY`, `AGENTS_SEARCH_URL`, `AGENTS_SEARCH_API_KEY` | — |
| (env only) | `AGENTS_SEARCH_QUERIES` / `AGENTS_SEARCH_RESULTS` | `4` / `5` per query |
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
| `--port` | `AGENTS_WEBHOOK_PORT` | `8787` |
| `--pages-repo` | `AGENTS_GITHUB_PAGES_REPO` | — (off) |
| `--pages-branch` | `AGENTS_GITHUB_PAGES_BRANCH` | `gh-pages` |
| (env only) | `AGENTS_GITHUB_TOKEN` / `GITHUB_TOKEN` | — |
| (env only) | `AGENTS_GITHUB_API_URL` | `https://api.github.com` (set for GitHub Enterprise) |
| `--signup-url` | `AGENTS_SIGNUP_URL` | — (pages don't collect signups) |
| (env only) | `AGENTS_SIGNUP_ALLOWED_ORIGINS` | `https://<pages owner>.github.io` |
| (env only) | `AGENTS_BUSINESS_NAME` / `AGENTS_CONTACT_EMAIL` | — (required in production with signups) |
| (env only) | `AGENTS_TRUST_PROXY=1` | off (use the socket address for rate limits) |
| (env only) | `AGENTS_METRICS_SOURCE=local` | auto (remote `/stats` when signup URL + secret are set) |
| (env only) | `AGENTS_MIN_VIEWS` / `AGENTS_TARGET_CONVERSION` | `100` / `0.05` |

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
