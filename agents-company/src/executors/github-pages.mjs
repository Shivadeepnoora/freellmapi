// Publishes an approved landing page to GitHub Pages through the GitHub REST
// API: commits <slug>/index.html to the Pages branch (creating the branch and
// enabling Pages on first use) and returns the public URL.
//
// Token needs, on the target repo only: Contents read/write, Pages read/write
// (fine-grained PAT), or the `repo` scope (classic PAT).

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const PAGE_PATH_RE = /^[a-z0-9-]{1,60}\/(index|privacy)\.html$/;
export const MAX_PAGE_BYTES = 1_000_000;

export class GitHubPagesPublisher {
  constructor({ repo, token, branch = 'gh-pages', apiUrl = 'https://api.github.com', fetchImpl = globalThis.fetch, log = () => {} }) {
    if (!REPO_RE.test(repo ?? '')) throw new Error(`GitHub Pages repo must look like "owner/name", got "${repo}"`);
    if (!token) throw new Error('GitHub Pages publishing needs a token (AGENTS_GITHUB_TOKEN or GITHUB_TOKEN)');
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch)) throw new Error(`Invalid branch name "${branch}"`);
    [this.owner, this.name] = repo.split('/');
    this.repo = repo;
    this.token = token;
    this.branch = branch;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.log = log;
    this.ready = null; // branch + Pages setup runs once per publisher
  }

  // Can this executor carry out the action? Only approved "publish" actions for an HTML page.
  canHandle(action) {
    return action?.kind === 'publish' && typeof action.artifact === 'string' && action.artifact.endsWith('.html');
  }

  pagesUrl(path) {
    const owner = this.owner.toLowerCase();
    const isUserSite = this.name.toLowerCase() === `${owner}.github.io`;
    const base = isUserSite ? `https://${owner}.github.io/` : `https://${owner}.github.io/${this.name}/`;
    return base + path.replace(/index\.html$/, '');
  }

  async publish({ path, content, message }) {
    if (!PAGE_PATH_RE.test(path)) throw new Error(`Refusing to publish to unexpected path "${path}"`);
    if (typeof content !== 'string' || !content.trim()) throw new Error('Nothing to publish: page content is empty');
    if (Buffer.byteLength(content) > MAX_PAGE_BYTES) throw new Error('Page is larger than 1 MB; refusing to publish');

    this.ready ??= this.#setup().catch((err) => { this.ready = null; throw err; });
    await this.ready;

    const existing = await this.#api('GET', `/contents/${path}?ref=${encodeURIComponent(this.branch)}`, null, [404]);
    const res = await this.#api('PUT', `/contents/${path}`, {
      message: message ?? `Publish ${path}`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: this.branch,
      ...(existing?.sha ? { sha: existing.sha } : {}),
    });
    const url = this.pagesUrl(path);
    this.log(`[GitHub Pages] committed ${path} to ${this.repo}@${this.branch} -> ${url}`);
    return { url, commitSha: res?.commit?.sha ?? null, updated: Boolean(existing?.sha) };
  }

  async #setup() {
    await this.#ensureBranch();
    await this.#ensurePagesEnabled();
  }

  async #ensureBranch() {
    const branch = await this.#api('GET', `/branches/${encodeURIComponent(this.branch)}`, null, [404]);
    if (branch) return;
    const repo = await this.#api('GET', '');
    const head = await this.#api('GET', `/git/ref/heads/${encodeURIComponent(repo.default_branch)}`, null, [404, 409]);
    if (!head?.object?.sha) throw new Error(`${this.repo} has no commits yet; push one commit before publishing`);
    await this.#api('POST', '/git/refs', { ref: `refs/heads/${this.branch}`, sha: head.object.sha });
    this.log(`[GitHub Pages] created branch ${this.branch} in ${this.repo}`);
  }

  async #ensurePagesEnabled() {
    const pages = await this.#api('GET', '/pages', null, [404]);
    if (pages) {
      const src = pages.source;
      if (src && src.branch !== this.branch) {
        this.log(`[GitHub Pages] warning: Pages serves branch "${src.branch}", not "${this.branch}"; pages may not appear until you change it in repo Settings → Pages`);
      }
      return;
    }
    try {
      await this.#api('POST', '/pages', { source: { branch: this.branch, path: '/' } }, [409]);
      this.log(`[GitHub Pages] enabled Pages for ${this.repo} from ${this.branch}`);
    } catch (err) {
      // The commit can still succeed; the user can enable Pages by hand.
      this.log(`[GitHub Pages] warning: could not enable Pages automatically (${err.message}). Enable it in repo Settings → Pages → branch "${this.branch}".`);
    }
  }

  // Calls /repos/{owner}/{repo}{path}. Statuses in `allow` resolve to null.
  async #api(method, path, body, allow = []) {
    const res = await this.fetch(`${this.apiUrl}/repos/${this.owner}/${this.name}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'freellmapi-agents-company',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (allow.includes(res.status)) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = text;
      try { msg = JSON.parse(text).message ?? text; } catch { /* keep raw */ }
      throw new Error(`GitHub API ${method} ${path || '/'} -> ${res.status}: ${String(msg).slice(0, 200)}`);
    }
    return res.status === 204 ? {} : res.json();
  }
}

export function publisherFromConfig(config, { fetchImpl, log } = {}) {
  if (!config.githubPagesRepo) return null;
  return new GitHubPagesPublisher({
    repo: config.githubPagesRepo,
    token: config.githubToken,
    branch: config.githubPagesBranch,
    apiUrl: config.githubApiUrl,
    fetchImpl,
    log,
  });
}
