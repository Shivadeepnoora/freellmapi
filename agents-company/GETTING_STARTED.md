# Getting started: your first real Short, then autopilot

This takes about an hour the first time. Testing is free on free tiers; there is no cost until you
choose paid APIs. Each step ends with a check, so you know it worked before moving on.

## 1. Install the tools

**Windows** (PowerShell):

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Gyan.FFmpeg
```

Close and reopen PowerShell afterwards so the new commands are found.

**macOS:** `brew install node git ffmpeg`  ·  **Ubuntu/Debian:** `sudo apt install nodejs npm git ffmpeg`
(check `node -v` shows 20.18 or newer; if not, install Node from nodejs.org)

✅ **Check:** `node -v`, `git --version` and `ffmpeg -version` each print a version.

## 2. Get the code

```bash
git clone https://github.com/Shivadeepnoora/freellmapi.git
cd freellmapi
git checkout claude/dreamy-albattani-rf89h8
cd agents-company
```

(After the pull request is merged, skip the `git checkout` line.)

Create your settings file from the template:

```bash
cp .env.example .env
```

On Windows: `copy .env.example .env`. Open `.env` in any text editor; you'll fill it in as you go.

## 3. Offline test: no keys, no accounts

```bash
npm run demo-short
```

This runs the whole studio with placeholder images and a test tone, so it proves Node and ffmpeg
work on your machine. The last lines print where `short.mp4` is.

✅ **Check:** the video opens and plays: coloured backgrounds, white captions, about 30 seconds.

## 4. Connect the AI (script, voice, images)

**Option A: FreeLLMAPI (free, for testing).** Install it the recommended way for your system:

- **Windows / macOS:** the desktop app (`.exe` / `.dmg`) from
  [FreeLLMAPI Releases](https://github.com/tashfeenahmed/freellmapi/releases/latest). It runs from
  your tray and serves on port **31415**, so add this to `.env`:
  `FREELLMAPI_BASE_URL=http://localhost:31415/v1`. If the tray popover shows a different port, use
  that one.
- **Linux (or a server):** the Docker one-liner from the main [README](../README.md#quick-start).
  It serves on port 3001, which is already the default, so you don't need `FREELLMAPI_BASE_URL`.

Then open its dashboard (from the tray, or http://localhost:3001 for Docker):

1. **Keys page:** add keys for the free providers you have accounts with. The README lists them.
2. **Models → Audio:** enable at least one **speech (TTS)** model.
3. **Models → Image:** enable at least one **image** model.
4. Optional: add a **search** key (Tavily, Exa, Brave…) so research uses live sources.
5. Copy the **unified API key** (Keys page header, or the tray popover) into `.env`: `FREELLMAPI_API_KEY=...`

**Option B: a paid OpenAI-compatible API.** Fill in the "Option B" block in `.env`, using model
names from your provider's model list.

Then set your niche in `.env` (Step 2 block): `AGENTS_CHANNEL_NICHE`, `AGENTS_CHANNEL_NAME`, and
`AGENTS_CHANNEL_LINK` if you have a newsletter or product page.

✅ **Check:** back in `agents-company`, `npm run check` shows your LLM with `key set` and no `error:` lines.

## 5. Your first real Short

```bash
npm run first-short
```

It takes a few minutes: research, script, review, a voice and an image per scene, then the video.

✅ **Check:** watch the `short.mp4` it prints. Be picky:

- **Voice:** to try another, set `AGENTS_TTS_VOICE` in `.env`. Available names depend on the speech model.
- **Images:** do they match the lines? Do any look like real people? (If so, disclose it as AI when uploading.)
- **Facts:** `script.json` next to the video lists the sources behind each claim.

If you're happy, the pipeline works for real. If not, send me the video's `script.json` and what's
off, and I'll tune the prompts.

## 6. Connect YouTube (once)

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and create a project.
2. **APIs & Services → Library:** enable **YouTube Data API v3** and **YouTube Analytics API**.
3. **OAuth consent screen:** choose External, enter an app name and your email, and add your
   Google account under *Test users*.
4. **Credentials → Create credentials → OAuth client ID → Desktop app.** Copy the client ID and
   secret into `.env` (`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`).
5. Run this, open the printed link, pick the Google account that owns your channel, and allow both
   permissions:
   ```bash
   npm run youtube-auth
   ```
6. Upload your first Short (unlisted, as set in `.env`):
   ```bash
   npm run approvals
   node src/cli.mjs approve act-0001
   npm run execute
   ```

✅ **Check:** the output shows a `youtube.com/shorts/…` link, and the video is in YouTube Studio.

Expect the first uploads to be **private**. YouTube keeps uploads from new API projects private
until Google audits the project (the output says so). Switch videos to public in YouTube Studio
meanwhile, and request the audit through YouTube's API compliance form when you're ready.

## 7. Autopilot

`.env` is already set to make **1 Short a day** (`AGENTS_STUDIO_VIDEOS=1`, `AGENTS_STUDIO_EVERY=24h`).
Keep the daemon running with pm2, so it survives crashes and reboots:

```bash
npm install -g pm2
pm2 start src/cli.mjs --name agents-company -- daemon
pm2 save
pm2 logs agents-company
```

On macOS/Linux, also run `pm2 startup` once and follow what it prints. On Windows, install
[pm2-installer](https://github.com/jessety/pm2-installer) or keep a PowerShell window open.
FreeLLMAPI must keep running too (Option A): leave the desktop app in the tray, or the Docker
container up. The machine has to stay on and awake for the daily Short to be made.

**Your daily routine:** `npm run approvals`, watch the new Short, then `node src/cli.mjs approve
act-000N`. It uploads within about 10 minutes, and `npm run studio-list` shows views, retention and
subscribers once YouTube Analytics catches up (1–3 days).

When it's going well: set `AGENTS_YOUTUBE_PRIVACY=public`, and raise `AGENTS_STUDIO_VIDEOS` to 2 if
your review time allows. Quality beats volume on YouTube.

## Troubleshooting

| You see | Fix |
|---|---|
| `ffmpeg and ffprobe are required` | Install ffmpeg (step 1), then reopen the terminal |
| `FREELLMAPI_API_KEY is not set` / `401` | Copy the unified key into `.env`; is FreeLLMAPI still running? |
| `fetch failed` / `ECONNREFUSED` on port 3001 | FreeLLMAPI isn't running, or it's the desktop app: set `FREELLMAPI_BASE_URL=http://localhost:31415/v1` |
| `/audio/speech -> 503` or `no … models` | Enable a speech model (Models → Audio) and an image model (Models → Image) in FreeLLMAPI |
| `script narration is N words` / `rejected by the Standards Reviewer` | Normal now and then; it tries a spare topic. If every topic fails, send me the log |
| `YouTube access was revoked or expired` | Run `npm run youtube-auth` again. "Testing" consent screens expire tokens after 7 days; publish the consent screen to stop that |
| `YouTube daily upload quota reached` | Nothing to do: it stays approved and uploads on the next day |
| `Analytics is not granted` | Run `npm run youtube-auth` again and tick "View YouTube Analytics reports" |

**Stuck?** Send me the output of `npm run check` plus the error lines. Your keys never appear in
that output, but check before pasting anything else.
