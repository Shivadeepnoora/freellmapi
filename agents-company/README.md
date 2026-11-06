# AI Agents Company

A small company made of AI agents. It researches income sources, gives each one to specialist
sub-agents for analysis, ranks the results, has a CEO agent decide what to do next, and then
**acts**: action agents build real deliverables for the top ideas and plan the next 14 days.
Anything that touches the outside world waits for your approval. It can
run on a schedule and keeps a memory between runs. Research is based on **live web search**, and
every claim cites its source. Published landing pages **collect real signups**, and each run
**learns from those results**: winners are scaled, losers are dropped, and new ideas follow what
converts. A separate **[YouTube Shorts studio](#youtube-shorts-studio)** researches, writes,
fact-checks and produces upload-ready faceless Shorts.

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
   ┌────────────┬────────────┬────────────┬────────────┬────────────┬────────────┐
   │  Product   │  Content   │  Sales &   │ Automation │   Email    │ Operations │
   │  Builder   │  Writer    │  Outreach  │  Builder   │  Marketer  │  Manager   │
   └─────┬──────┴─────┬──────┴─────┬──────┴─────┬──────┴─────┬──────┴─────┬──────┘
   landing-page   content.md  outreach.md automation  newsletter.md   plan.json
      .html                                  .mjs
         └──────────── written to the workspace ────────────┘           │
                                                   external tasks → approval queue
                                         you approve → publish page / email subscribers
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

## Emailing subscribers (Resend)

Subscribers hear from you through [Resend](https://resend.com).

| Email | When | Written by | Needs your approval |
|---|---|---|---|
| **Confirmation** | right after signup (double opt-in) | fixed template | no (it's the response to their own request) |
| **Welcome** | after they click *Confirm* | fixed template | no |
| **Newsletter** | when you approve a `send_email` action | the Email Marketer agent (`newsletter.md`) | **yes**, always |

No AI-written text is ever emailed automatically. The confirmation and welcome emails are fixed
templates. Newsletters are drafts in the approval queue, and you can read them before approving.

### Setup

1. Create a Resend account, add your sending domain, and add the DNS records Resend shows you
   (SPF, DKIM, and DMARC is recommended). Wait until the domain shows *Verified*.
2. Create an API key with *Sending access*.
3. Set these where `webhook-server` runs, and also where the company runs if it's a different
   machine with local subscribers:

```bash
export RESEND_API_KEY=re_...
export AGENTS_EMAIL_FROM="Your Business <hello@yourdomain.com>"   # on the verified domain
export AGENTS_EMAIL_REPLY_TO=you@yourdomain.com                     # optional; replies are gold, read them
export AGENTS_POSTAL_ADDRESS="Your Business, PO Box 123, City, Country"   # required for newsletters (CAN-SPAM)
node src/cli.mjs check
node src/cli.mjs email-test you@yourdomain.com                     # sends one real test email
```

### How it works

- **Double opt-in (default).** A signup is *pending* until the person clicks the link in the
  confirmation email. Only *confirmed* people get newsletters. This keeps fake and mistyped
  addresses off your list and gives you proof of consent. Set `AGENTS_DOUBLE_OPT_IN=0` for single
  opt-in, where the welcome email goes out immediately. Without Resend configured, signups are
  single opt-in and no email is sent.
- **Unsubscribe everywhere.** Every welcome email and newsletter has a personal unsubscribe link
  in the footer, plus `List-Unsubscribe` and `List-Unsubscribe-Post` headers. Those headers let
  Gmail, Yahoo and others show their own one-click *Unsubscribe* button, which they require of
  bulk senders. Unsubscribed people stay on file as *unsubscribed*, so they're never emailed again
  by accident. `signups --delete` erases them completely.
- **Scanner-safe links.** Opening a confirm or unsubscribe link shows a page with a button. Only
  the button press (a POST), or a mail client's one-click POST, changes anything. Email security
  scanners that pre-open links can't confirm or unsubscribe anyone.
- **Newsletters go only to the right people.** An approved newsletter goes to the confirmed
  subscribers of that idea's landing page and nobody else. Cold outreach (`outreach.md`) is never
  sent automatically.
- **Sending.** Newsletters go out in batches of 100 through Resend's batch endpoint. Each batch
  has an idempotency key derived from the action id, so retrying a failed send (re-approve and
  execute) never emails anyone twice. A safety cap (`AGENTS_EMAIL_MAX_RECIPIENTS`, default 1000)
  refuses unexpectedly large sends.
- **Emails name the idea from the page id**, never from anything the visitor typed, so nobody can
  use your signup form to send their own text to someone else's inbox.

Newsletters are sent by whichever machine holds the subscribers. If the company talks to a remote
`webhook-server` (`AGENTS_SIGNUP_URL` and `AGENTS_WEBHOOK_SECRET` set), approved newsletters go to
it through the webhook, together with the approved text. Otherwise the company sends them itself.

`signups` now shows confirmed, pending and unsubscribed counts per page. `signups --export` adds a
status column and never includes the secret link tokens.

## YouTube Shorts studio

A separate production line that runs a faceless YouTube Shorts channel: voiceover over AI visuals,
with burned-in captions. Once you [connect YouTube](#automatic-youtube-upload), approving a video
uploads it; otherwise you upload the finished files yourself.

```
Topic Researcher → Scriptwriter → Standards Reviewer → Producer (voice + images + ffmpeg) → your review → you upload
        ▲                                                                                        │
        └──────────── studio-results: views, retention, subscribers from YouTube Studio ◄─────────┘
```

1. **Topic Researcher** searches the web for your niche and picks specific, sourced topics. It
   never repeats a topic and leans toward what performed (from recorded results).
2. **Scriptwriter** writes a 30–55 second script: a hook, 4–7 scenes (narration plus an image
   prompt each), title, description, tags and sources.
3. **Standards Reviewer** rejects scripts with unsupported claims, misleading titles, advice framed
   as certain, real people, brands or text in visuals, generic filler, or Community Guidelines
   problems. A rejected script gets one rewrite; if it fails again it's skipped and a spare topic
   is used.
4. **Producer** generates a voiceover per scene (`/v1/audio/speech`) and a vertical image per scene
   (`/v1/images/generations`). `ffmpeg` then builds a **1080×1920, 30 fps H.264/AAC** video with a
   slow zoom on each image and big, outlined captions in the lower third, timed to the voice.
5. **Package** in `data/workspace/studio/<run>/<video>/`:
   - `short.mp4` and `cover.jpg`
   - `metadata.md`: title, description, tags
   - `UPLOAD.md`: a step-by-step checklist including the AI disclosure
   - `script.json` and `captions.ass`
6. **Review**: each video becomes a `publish_video` item in `approvals`, showing where to watch it.
   The video file itself is never sent to any webhook.

```bash
export AGENTS_CHANNEL_NICHE="personal finance for students"
export AGENTS_CHANNEL_NAME="Money Basics"
export AGENTS_CHANNEL_LINK=https://you.github.io/launches/money-newsletter/   # your landing page / newsletter
node src/cli.mjs studio --videos 2          # or --mock to try it offline (placeholder images and tones)
node src/cli.mjs approvals                  # watch each video
node src/cli.mjs studio-list
node src/cli.mjs studio-results <slug> --views 1200 --viewed-pct 78 --subscribers 9 --url https://youtube.com/shorts/…
```

**Description safety.** Any URL the model wrote into the description is removed, together with
its sentence. Only the verified source URLs from the research, your `AGENTS_CHANNEL_LINK`, and an
honest AI note are added. Captions escape ASS control characters. ffmpeg runs without a shell.

**Requirements.**
- `ffmpeg` and `ffprobe` (`studio` checks for them).
- A speech model and an image model enabled in FreeLLMAPI (Models page), or set
  `AGENTS_MEDIA_BASE_URL`, `AGENTS_MEDIA_API_KEY`, `AGENTS_TTS_MODEL` and `AGENTS_IMAGE_MODEL` to a
  paid OpenAI-compatible media API. Production mode requires that.

**Cost per video:** about 3 LLM calls (more if a rewrite is needed), 5–7 voiceover clips, 5–7
images and 2 searches, plus the 4 searches and 1 call per run for topics.

### Automatic YouTube upload

When YouTube is connected, approving a `publish_video` item and running `execute` (or letting the
daemon run) uploads the Short through the YouTube Data API:
- the title, description and tags come from the package
- *Made for kids* is set to **No**
- **altered/synthetic content** is disclosed (`AGENTS_YOUTUBE_SYNTHETIC=0` turns that off, but
  only do so if no visual could pass for real)
- privacy is `AGENTS_YOUTUBE_PRIVACY` (`public` by default, or `unlisted` or `private`)

The Shorts link is saved on the approval item and in `studio-list`.

**One-time setup (about 10 minutes):**

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable
   **YouTube Data API v3**.
2. Under **OAuth consent screen**, choose *External*, fill in the app name and your email, and add
   your Google account as a test user.
3. Under **Credentials → Create credentials → OAuth client ID**, choose **Desktop app**. Copy the
   client ID and secret.
4. Connect:
   ```bash
   export YOUTUBE_CLIENT_ID=....apps.googleusercontent.com
   export YOUTUBE_CLIENT_SECRET=...
   node src/cli.mjs youtube-auth
   ```
   Open the printed link, choose the Google account that owns the channel, and allow *Manage your
   YouTube videos*. Only the `youtube.upload` permission is requested. The refresh token is saved
   to `data/youtube-token.json`, readable only by you, or you can provide it as
   `YOUTUBE_REFRESH_TOKEN`.
   **On a server without a browser:** open the link on any device. When the browser ends on a
   `http://127.0.0.1:8976/oauth2callback?…` page that doesn't load, copy that URL and run
   `node src/cli.mjs youtube-auth --redirect "<URL>"`.
5. `node src/cli.mjs check` should show `YouTube: connected`.

**What to expect from Google:**
- **New API projects upload as private.** YouTube locks videos uploaded by unaudited API projects
  to private until the project passes its
  [API compliance audit](https://support.google.com/youtube/contact/yt_api_form). The executor
  notices this and notes it on the item. Until the audit passes, switch videos to public in
  YouTube Studio.
- **"Testing" OAuth apps get tokens that expire after 7 days.** Publish the consent screen (it can
  stay unverified for your own use) to keep the connection. If access lapses, `execute` tells you
  to run `youtube-auth` again.
- **Quota.** An upload costs 1,600 of the default 10,000 daily units, so about 6 uploads a day.
  When the quota or the channel's daily upload limit is reached, the item **stays approved** with
  a note and uploads on the next run.

**Safety.**
- Only a `short.mp4` that the studio wrote under `data/workspace/studio/` can be uploaded, so an
  edited `approvals.json` can't upload anything else.
- A video already linked to a YouTube ID is never uploaded again.
- Interrupted uploads resume from the byte YouTube confirmed.
- `<` and `>` are stripped from the title, description and tags, because YouTube rejects them.

### How a Shorts channel earns, honestly

- **YouTube ad revenue only starts after the YouTube Partner Program:** 1,000 subscribers plus
  4,000 public watch hours in a year, *or* 10 million public Shorts views in 90 days.
- **Before that, the channel earns by sending viewers somewhere.** Every description links to
  `AGENTS_CHANNEL_LINK`, ideally a landing page with signup capture. Your newsletter then turns
  viewers into subscribers you own, and later into customers for an offer. Affiliate links and
  sponsors come next.
- **YouTube demonetizes "inauthentic", mass-produced content.** That's why the studio makes few,
  specific, sourced videos, and why your review step matters. Don't raise `--videos` to churn
  out volume; improve topics using `studio-results` instead.
- **Disclose AI.** Set *Altered or synthetic content* to **Yes** whenever a visual looks like a
  real person, place or event. The upload checklist reminds you.

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
| (env only) | `RESEND_API_KEY` | — (no emails to subscribers) |
| (env only) | `AGENTS_EMAIL_FROM` / `AGENTS_EMAIL_REPLY_TO` | — (from is required with Resend) |
| (env only) | `AGENTS_POSTAL_ADDRESS` | — (required for newsletters) |
| (env only) | `AGENTS_DOUBLE_OPT_IN=0` | on (confirmation email first) |
| (env only) | `AGENTS_EMAIL_MAX_RECIPIENTS` | `1000` per newsletter |
| `--niche` | `AGENTS_CHANNEL_NICHE` | — (required for `studio`) |
| `--videos` | `AGENTS_STUDIO_VIDEOS` | `2` per studio run (1–10) |
| (env only) | `AGENTS_CHANNEL_NAME` / `AGENTS_CHANNEL_LINK` / `AGENTS_CHANNEL_CTA` | — / — / `Free newsletter` |
| (env only) | `AGENTS_MEDIA_BASE_URL` / `AGENTS_MEDIA_API_KEY` | FreeLLMAPI / `FREELLMAPI_API_KEY` |
| (env only) | `AGENTS_TTS_MODEL` / `AGENTS_TTS_VOICE` / `AGENTS_IMAGE_MODEL` | `auto` / `alloy` / `auto` |
| (env only) | `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` | — (manual upload) |
| (env only) | `YOUTUBE_REFRESH_TOKEN` | from `data/youtube-token.json` (`youtube-auth`) |
| `--privacy` | `AGENTS_YOUTUBE_PRIVACY` | `public` |
| (env only) | `AGENTS_YOUTUBE_SYNTHETIC=0` | disclosure on |
| (env only) | `AGENTS_YOUTUBE_AUTH_PORT` | `8976` (loopback port for sign-in) |

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
