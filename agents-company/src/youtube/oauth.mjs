// Google OAuth for an installed app (loopback redirect + PKCE), as Google
// recommends for command-line tools. Scopes: youtube.upload, plus the
// read-only yt-analytics.readonly unless analytics is turned off. Nothing
// else on the account is requested. The refresh token is stored in
// data/youtube-token.json (mode 600) or read from YOUTUBE_REFRESH_TOKEN.
//
//   youtube-auth                 prints the consent URL and waits on 127.0.0.1 for Google's redirect
//   youtube-auth --redirect URL  finishes by hand (paste the URL the browser ended on), for headless servers
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
export const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function tokenFile(dataDir) { return join(dataDir, 'youtube-token.json'); }
function pendingFile(dataDir) { return join(dataDir, 'youtube-auth-pending.json'); }

function writePrivate(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// Step 1: build the consent URL and remember the PKCE verifier + state.
export function startAuth({ clientId, dataDir, port, analytics = true }) {
  if (!clientId) throw new Error('Set YOUTUBE_CLIENT_ID (a Google Cloud OAuth client of type "Desktop app")');
  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(24));
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: analytics ? `${SCOPE} ${ANALYTICS_SCOPE}` : SCOPE,
    access_type: 'offline',
    prompt: 'consent', // always return a refresh token
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    state,
  }).toString();
  writePrivate(pendingFile(dataDir), { verifier, state, redirectUri, createdAt: new Date().toISOString() });
  return { url: url.toString(), redirectUri, state };
}

// Step 2: exchange the code from the redirect for tokens and store the refresh token.
export async function finishAuth({ clientId, clientSecret, dataDir, redirectedUrl, fetchImpl = globalThis.fetch }) {
  const pf = pendingFile(dataDir);
  if (!existsSync(pf)) throw new Error('No sign-in in progress: run `youtube-auth` first');
  const pending = JSON.parse(readFileSync(pf, 'utf8'));
  const u = new URL(redirectedUrl);
  if (u.searchParams.get('error')) throw new Error(`Google sign-in was not completed: ${u.searchParams.get('error')}`);
  const state = u.searchParams.get('state') ?? '';
  const a = Buffer.from(state);
  const b = Buffer.from(pending.state);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Sign-in state did not match; run `youtube-auth` again');
  const code = u.searchParams.get('code');
  if (!code) throw new Error('The redirect URL has no authorization code');

  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret ?? '', code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, grant_type: 'authorization_code' }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google token exchange failed: ${data.error ?? res.status} ${data.error_description ?? ''}`.trim());
  if (!data.refresh_token) throw new Error('Google returned no refresh token; remove the app from your Google account permissions and run `youtube-auth` again');
  if (!String(data.scope ?? '').split(' ').includes(SCOPE)) throw new Error('The YouTube upload permission was not granted');
  writePrivate(tokenFile(dataDir), { refresh_token: data.refresh_token, scope: data.scope, obtainedAt: new Date().toISOString() });
  unlinkSync(pf);
  return { scope: data.scope, analytics: String(data.scope).split(' ').includes(ANALYTICS_SCOPE) };
}

// Scopes the stored token was granted. A token given via YOUTUBE_REFRESH_TOKEN
// is not inspectable, so it is assumed to have what was asked for; a missing
// scope then surfaces as a clear error on first use.
export function grantedScopes(config) {
  if (config.youtubeRefreshToken) return [SCOPE, ANALYTICS_SCOPE];
  const f = tokenFile(config.dataDir);
  if (!existsSync(f)) return [];
  return String(JSON.parse(readFileSync(f, 'utf8')).scope ?? '').split(' ').filter(Boolean);
}

// Runs a one-shot loopback server that catches Google's redirect.
export function waitForRedirect({ port, onUrl, timeoutMs = 10 * 60_000, host = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      if (!req.url.startsWith('/oauth2callback')) { res.writeHead(404); return res.end(); }
      try {
        await onUrl(`http://${host}:${port}${req.url}`);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<p style="font:16px system-ui">YouTube is connected. You can close this tab.</p>');
        clearTimeout(timer);
        server.close();
        resolve();
      } catch (err) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<p style="font:16px system-ui">Sign-in failed: ${String(err.message).replace(/[<>&]/g, '')}</p>`);
        clearTimeout(timer);
        server.close();
        reject(err);
      }
    });
    const timer = setTimeout(() => { server.close(); reject(new Error('Timed out waiting for Google sign-in')); }, timeoutMs);
    server.on('error', reject);
    server.listen(port, host);
  });
}

// Short-lived access tokens from the stored refresh token.
export class GoogleAuth {
  constructor({ clientId, clientSecret, refreshToken, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    if (!clientId || !refreshToken) throw new Error('YouTube is not connected: set YOUTUBE_CLIENT_ID and run `youtube-auth`');
    Object.assign(this, { clientId, clientSecret, refreshToken, fetch: fetchImpl, now });
    this.cached = null;
  }

  async accessToken({ force = false } = {}) {
    if (!force && this.cached && this.cached.expiresAt - 60_000 > this.now()) return this.cached.token;
    const res = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret ?? '', refresh_token: this.refreshToken, grant_type: 'refresh_token' }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.error === 'invalid_grant') throw new Error('YouTube access was revoked or expired: run `youtube-auth` again (apps in Google "Testing" mode get 7-day tokens; publish the OAuth app to avoid this)');
      throw new Error(`Google token refresh failed: ${data.error ?? res.status}`);
    }
    this.cached = { token: data.access_token, expiresAt: this.now() + (Number(data.expires_in) || 3600) * 1000 };
    return this.cached.token;
  }
}

export function refreshTokenFrom(config) {
  if (config.youtubeRefreshToken) return config.youtubeRefreshToken;
  const f = tokenFile(config.dataDir);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).refresh_token ?? '' : '';
}
