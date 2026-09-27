/**
 * GitHub publisher — a zero-dependency DSH host plugin.
 *
 * Three model-facing tools:
 *   - github_account  resolve the configured token and report the signed-in account
 *   - github_publish  publish content as a secret/public gist, or commit it into a repository
 *   - github_intro    write a README-style introduction for the content, through this session's model
 *
 * Credential resolution is per operation and layered (first hit wins):
 *   config.token or the `token` argument
 *     -> ctx.credentials.resolve("GITHUB_TOKEN") when that service exists
 *       -> process.env.GITHUB_TOKEN / GH_TOKEN / GITHUB_PAT
 *         -> config.envFile, when set (the reliable path: the DSH process does
 *            not reliably export DSH_PROFILE_DIR)
 *           -> GITHUB_TOKEN / GH_TOKEN / GITHUB_PAT in <profile>/.env and <profile>/../.env
 * The token value is never returned, logged, or embedded in a tool result.
 *
 * @module @local/github-publisher
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Cordis plugin name used by loader diagnostics. */
export const name = "github-publisher";

/**
 * Services this plugin uses. `webServer` carries the composer button's API;
 * `llm` and `agentDefaultModel` are read optionally through `ctx.get` so the
 * plugin still loads in a composition that has no model route.
 */
export const inject = ["tools", "webServer"];

const API_DEFAULT = "https://api.github.com";
const RAW_HOST_DEFAULT = "https://gist.githubusercontent.com";
/**
 * jsDelivr serves repository content and stays reachable from networks that
 * block `gist.github.com` and `raw.githubusercontent.com`.
 */
const CDN_HOST_DEFAULT = "https://cdn.jsdelivr.net";
/** Repository the panel publishes into when no other target is given. */
const DEFAULT_REPO = "ai-notes";
const DEFAULT_TIMEOUT_MS = 180_000;
/**
 * Output budget for one introduction. It must cover the reasoning a reasoning-capable route spends
 * before any text: a budget sized for the finished paragraph alone ends the stream with `max-tokens`
 * and no introduction at all. The prompt asks for at most 350 characters, so the visible answer is a
 * small part of this number.
 */
const DEFAULT_INTRO_TOKENS = 8_000;
const TOKEN_ENV_NAMES = ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT"];
const MAX_TEXT_CHARS = 200_000;

/* ------------------------------------------------------------------ errors */

/** One failure that carries a stable machine-readable code. */
class GitHubPublisherError extends Error {
  /**
   * @param {string} message - human-readable account of the failure.
   * @param {string} code - stable machine-readable code.
   */
  constructor(message, code) {
    super(message);
    this.name = "GitHubPublisherError";
    this.code = code;
  }
}

/**
 * Re-shape any thrown value into the canonical error envelope every tool returns.
 * @param {unknown} error - the caught value.
 * @returns {{ok: false, error: string, code: string}} the envelope.
 */
function failure(error) {
  if (error instanceof GitHubPublisherError) return { ok: false, error: error.message, code: error.code };
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: message, code: "UNEXPECTED" };
}

/**
 * Derive a short description from the content itself.
 *
 * The introduction is a description, not decoration: GitHub shows it right next
 * to the gist. A model failure must not cost you the publish, so this produces
 * a usable one-line description from the first meaningful line of the draft.
 * @param {string} content - the document being published.
 * @param {string} [summary] - an explicit summary, preferred over the content.
 * @returns {string} a single-line description, at most 200 characters.
 */
function fallbackIntro(content, summary) {
  const source = text(summary) ?? content;
  const line = source
    .split(/\r?\n/u)
    .map((entry) => entry.replace(/^\s{0,3}#{1,6}\s*/u, "").trim())
    .find((entry) => entry.length > 0);
  const candidate = text(line) ?? "Published from the DeepSeek Harness";
  return candidate.length <= 200 ? candidate : `${candidate.slice(0, 199)}…`;
}

/**
 * Read a string option, treating an empty or whitespace-only value as absent.
 * @param {unknown} value - candidate value.
 * @returns {string | undefined} the trimmed value, or undefined.
 */
function text(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Read a boolean option.
 * @param {unknown} value - candidate value.
 * @param {boolean} fallback - value used when the option is absent.
 * @returns {boolean} the resolved flag.
 */
function flag(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

/** Default configuration used when the loader supplies no config. */
const DEFAULTS = Object.freeze({
  token: undefined,
  owner: undefined,
  repo: undefined,
  branch: undefined,
  apiBaseUrl: API_DEFAULT,
  rawHost: RAW_HOST_DEFAULT,
  cdnHost: CDN_HOST_DEFAULT,
  introProvider: undefined,
  introModel: undefined,
  introMaxTokens: DEFAULT_INTRO_TOKENS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  envFile: undefined,
});

/**
 * Normalize the loader config into the exact shape the tools use.
 * @param {unknown} config - raw plugin config.
 * @returns {typeof DEFAULTS} the resolved configuration.
 */
function resolveConfig(config) {
  const raw = config !== null && typeof config === "object" ? config : {};
  const maxTokens = Number.isInteger(raw.introMaxTokens) && raw.introMaxTokens > 0 ? raw.introMaxTokens : DEFAULT_INTRO_TOKENS;
  const timeoutMs = Number.isInteger(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULT_TIMEOUT_MS;
  return Object.freeze({
    token: text(raw.token),
    owner: text(raw.owner),
    repo: text(raw.repo),
    branch: text(raw.branch),
    apiBaseUrl: text(raw.apiBaseUrl) ?? API_DEFAULT,
    rawHost: text(raw.rawHost) ?? RAW_HOST_DEFAULT,
    cdnHost: text(raw.cdnHost) ?? CDN_HOST_DEFAULT,
    introProvider: text(raw.introProvider),
    introModel: text(raw.introModel),
    introMaxTokens: maxTokens,
    timeoutMs,
    envFile: text(raw.envFile),
  });
}

/* ------------------------------------------------------------- the `.env` */

/**
 * Parse the `KEY=value` lines of one `.env` file.
 * @param {string} source - file contents.
 * @returns {Record<string, string>} the parsed assignments.
 */
function parseDotEnv(source) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(trimmed);
    if (match === null) continue;
    const key = match[1];
    let value = match[2] ?? "";
    const quoted = /^(['"])(.*)\1$/su.exec(value);
    if (quoted !== null) value = quoted[2] ?? "";
    else value = value.replace(/\s+#.*$/u, "").trim();
    if (value.length > 0) values[key] = value;
  }
  return values;
}

/**
 * Locate this profile's directory from the plugin's own location.
 *
 * Installed bundles are linked into `<profile>/node_modules/@local/<pkg>`, so
 * walking up to the `node_modules` segment recovers the profile directory
 * without depending on `DSH_PROFILE_DIR`, which the DSH process does not
 * reliably export. Returns undefined for the workspace copy of the plugin.
 * @returns {string | undefined} the profile directory, if one can be derived.
 */
function profileDirFromModule() {
  if (typeof import.meta?.url !== "string") return undefined;
  let url;
  try {
    url = fileURLToPath(import.meta.url);
  } catch {
    return undefined;
  }
  const parts = dirname(url).split(sep);
  for (let index = parts.length - 1; index >= 1; index -= 1) {
    if (parts[index] === "node_modules") return parts.slice(0, index).join(sep);
  }
  return undefined;
}

/**
 * Every profile directory this process could plausibly be serving from.
 *
 * A linked bundle resolves to its real path, so `profileDirFromModule` finds no
 * `node_modules` segment and the only remaining source would be
 * `DSH_PROFILE_DIR` — which the DSH process does not reliably export. A token
 * that is plainly present in the profile's `.env` therefore surfaced as
 * `NO_TOKEN`. Collect every candidate instead of one, so discovery survives
 * whichever of these the running process happens to provide.
 * @returns {string[]} absolute profile directories, most specific first.
 */
function profileCandidates() {
  const found = [];
  const push = (value) => {
    const candidate = text(value);
    if (candidate === undefined || candidate.length === 0) return;
    if (!found.includes(candidate)) found.push(candidate);
  };
  push(process.env.DSH_PROFILE_DIR);
  const home = text(process.env.DSH_HOME);
  const profile = text(process.env.DSH_PROFILE);
  if (home !== undefined) {
    if (profile !== undefined) push(join(home, "profiles", profile));
    push(join(home, "profiles", "web"));
    push(home);
  }
  push(profileDirFromModule());
  return found;
}

/**
 * Read one `.env` file and return the first GitHub token found in it.
 * @param {string} file - absolute path to the file.
 * @returns {Promise<string | undefined>} the configured value, if any.
 */
async function tokenFromFile(file) {
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const values = parseDotEnv(source);
  for (const key of TOKEN_ENV_NAMES) {
    const value = text(values[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Read `GITHUB_TOKEN` and friends from the profile `.env` files.
 *
 * Every candidate directory is tried with both `<dir>/.env` and `<dir>/../.env`,
 * and the directories that were searched are returned alongside the value so a
 * missing token can name the exact files it looked in.
 * @param {string[]} [directories] - profile directories; defaults to the discovered ones.
 * @returns {Promise<{token?: string, searched: string[]}>} the first configured value.
 */
async function tokenFromDotEnv(directories) {
  const bases = Array.isArray(directories) ? directories : profileCandidates();
  const searched = [];
  for (const base of bases) {
    for (const file of [join(base, ".env"), join(dirname(base), ".env")]) {
      if (searched.includes(file)) continue;
      searched.push(file);
      let source;
      try {
        source = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const values = parseDotEnv(source);
      for (const key of TOKEN_ENV_NAMES) {
        const value = text(values[key]);
        if (value !== undefined) return { token: value, searched };
      }
    }
  }
  return { searched };
}

/* ----------------------------------------------------------- credentials */

/**
 * Resolve the GitHub token for exactly this operation, with its provenance.
 * @param {import("./index.js").Ctx} ctx - plugin context.
 * @param {typeof DEFAULTS} config - resolved plugin config.
 * @param {string | undefined} inline - token passed as a tool argument.
 * @returns {Promise<{token: string, source: string} | undefined>} the credential, or undefined.
 */
async function resolveToken(ctx, config, inline) {
  const direct = text(inline) ?? config.token;
  if (direct !== undefined) return { token: direct, source: text(inline) === undefined ? "plugin config" : "tool argument" };

  const credentials = typeof ctx.get === "function" ? ctx.get("credentials") : undefined;
  if (credentials !== undefined && typeof credentials.resolve === "function") {
    for (const key of TOKEN_ENV_NAMES) {
      try {
        const resolved = await credentials.resolve(key);
        const value = text(resolved?.value);
        if (value !== undefined) return { token: value, source: `credentials:${resolved?.source ?? "store"}` };
      } catch {
        /* an unset or unwritable reference is simply not a source */
      }
    }
  }

  for (const key of TOKEN_ENV_NAMES) {
    const value = text(process.env[key]);
    if (value !== undefined) return { token: value, source: `env:${key}` };
  }

  // An explicit `envFile` from the plugin config always works, because the
  // running DSH process does not reliably expose DSH_PROFILE_DIR.
  if (config.envFile !== undefined) {
    const fromConfigFile = await tokenFromFile(config.envFile);
    if (fromConfigFile !== undefined) return { token: fromConfigFile, source: `file:${config.envFile}` };
  }

  const fromFile = await tokenFromDotEnv();
  if (fromFile.token !== undefined) return { token: fromFile.token, source: "profile .env", searched: fromFile.searched };
  return undefined;
}

/* -------------------------------------------------------------- transport */

/**
 * Explain a failure in terms the caller can act on.
 *
 * A fine-grained personal access token carries no OAuth scopes, so GitHub
 * answers a missing permission with a flat `403 Resource not accessible by
 * personal access token`. Translating that one case turns the commonest setup
 * mistake into a fixable instruction.
 * @param {number} status - the HTTP status.
 * @param {string} route - the requested path.
 * @param {string} method - the HTTP method.
 * @param {string} detail - GitHub's own message.
 * @param {unknown} documentationUrl - GitHub's documentation link, when present.
 * @returns {string} the model-facing message.
 */
function explainFailure(status, route, method, detail, documentationUrl) {
  if (status === 403 && /not accessible by personal access token/iu.test(detail)) {
    const writes = method !== "GET" && method !== "HEAD";
    const isGist = typeof documentationUrl === "string" ? documentationUrl.includes("/gists/") : route.startsWith("/gists");
    const permission = isGist ? "Gists" : "Contents";
    const level = writes ? "Read and write" : "Read-only";
    return (
      `GitHub 403 on ${route}: this token is missing the ${permission} permission. ` +
      `Fine-grained tokens have no scopes — they need explicit permissions. ` +
      `Open https://github.com/settings/personal-access-tokens, edit this token, set ` +
      `"${permission}" to "${level}", save it, and make sure it is approved for the ` +
      `account or organization that owns the target. GitHub said: ${detail}`
    );
  }
  return `GitHub ${String(status)} on ${route}: ${detail}`;
}

/**
 * Explain a transport failure in terms the caller can act on.
 *
 * On a machine behind a proxy client, `api.github.com` can resolve but not
 * answer (a fake-IP resolver hands out an address no route serves), which
 * surfaces as a bare `fetch failed` that reads like a plugin bug. Naming the
 * likely cause turns that into a fixable instruction.
 * @param {string} route - the requested path.
 * @param {unknown} error - the thrown transport error.
 * @returns {string} the model-facing message.
 */
function explainNetworkFailure(route, error) {
  const cause = error !== null && typeof error === "object" ? error.cause : undefined;
  const code = cause !== null && typeof cause === "object" && typeof cause.code === "string" ? cause.code : undefined;
  const reason = code !== undefined ? code : error instanceof Error ? error.message : String(error);
  return (
    `GitHub request to ${route} never reached the API (${reason}). ` +
    `The usual cause is the network path: on this machine the GitHub hosts resolve to a proxy ` +
    `client's fake-IP range (198.18.0.0/15), and when that proxy cannot route github.com the ` +
    `connection simply times out. Test with \`Invoke-WebRequest https://api.github.com/zen\`, ` +
    `switch or refresh the proxy node, then retry.`
  );
}

/**
 * Call the GitHub REST API and decode the JSON reply.
 * @param {typeof DEFAULTS} config - resolved plugin config.
 * @param {string} token - the bearer token.
 * @param {string} route - path below the API base, beginning with `/`.
 * @param {{method?: string, body?: unknown, signal?: AbortSignal}} [options] - request options.
 * @returns {Promise<{status: number, data: any, headers: Headers}>} the decoded reply.
 */
async function github(config, token, route, options = {}) {
  const url = `${config.apiBaseUrl.replace(/\/+$/u, "")}${route}`;
  const method = options.method ?? "GET";
  const init = {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "dsh-github-publisher",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    signal: options.signal ?? AbortSignal.timeout(config.timeoutMs),
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new GitHubPublisherError(explainNetworkFailure(route, error), "NETWORK");
  }

  const body = await response.text();
  let data;
  if (body.length > 0) {
    try {
      data = JSON.parse(body);
    } catch {
      data = undefined;
    }
  }
  if (!response.ok) {
    const detail = text(data?.message) ?? body.slice(0, 300);
    throw new GitHubPublisherError(explainFailure(response.status, route, method, detail, data?.documentation_url), `HTTP_${String(response.status)}`);
  }
  return { status: response.status, data, headers: response.headers };
}

/* ----------------------------------------------------- publication shapes */

/**
 * Build the jsDelivr address for one file in a repository.
 *
 * jsDelivr is reachable from networks where `gist.github.com` and
 * `raw.githubusercontent.com` are not, so the panel offers this link next to the
 * github.com one.
 * @param {string} cdnHost - configured jsDelivr host.
 * @param {string} owner - repository owner.
 * @param {string} repo - repository name.
 * @param {string} branch - branch the file lives on.
 * @param {string} path - repository-relative file path.
 * @returns {string} the CDN URL.
 */
function cdnUrlFor(cdnHost, owner, repo, branch, path) {
  const base = cdnHost.replace(/\/+$/u, "");
  const segments = [encodeURIComponent(owner), encodeURIComponent(repo)].join("/");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${base}/gh/${segments}@${encodeURIComponent(branch)}/${encodedPath}`;
}

/**
 * Resolve the signed-in login, which is also the default repository owner.
 * @param {typeof DEFAULTS} config - resolved plugin config.
 * @param {string} token - the bearer token.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<string>} the login.
 */
async function loginOf(config, token, signal) {
  const { data } = await github(config, token, "/user", { signal });
  const login = text(data?.login);
  if (login === undefined) throw new GitHubPublisherError("GitHub did not report the signed-in account", "NO_LOGIN");
  return login;
}

/**
 * Make sure the publishing repository exists, creating it when it does not.
 *
 * A missing repository is the normal first-run state, so this treats the 404 as
 * "create it" rather than as a failure, and only asks for an existing one when
 * creation is refused.
 * @param {typeof DEFAULTS} config - resolved plugin config.
 * @param {string} token - the bearer token.
 * @param {{owner?: string, repo: string, description?: string, private?: boolean}} target - desired repository.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<{owner: string, repo: string, branch: string, created: boolean, description?: string}>} the repository identity.
 */
async function ensureRepo(config, token, target, signal) {
  const owner = text(target.owner) ?? (await loginOf(config, token, signal));
  const repo = target.repo;
  const route = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  try {
    const { data } = await github(config, token, route, { signal });
    return {
      owner,
      repo,
      branch: text(data?.default_branch) ?? config.branch ?? "main",
      created: false,
      ...(text(data?.description) === undefined ? {} : { description: text(data?.description) }),
    };
  } catch (error) {
    if (!(error instanceof GitHubPublisherError) || error.code !== "HTTP_404") {
      throw new GitHubPublisherError(
        `the repository ${owner}/${repo} could not be created or read: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof GitHubPublisherError ? error.code : "REPO_UNAVAILABLE",
      );
    }
  }

    const body = {
      name: repo,
      // Created private by default: a new repository on someone's account is not
      // something a publish button should make public on their behalf.
      private: flag(target.private, true),
      has_issues: false,
      has_wiki: false,
      has_projects: false,
      auto_init: true,
      ...(text(target.description) === undefined ? {} : { description: text(target.description) }),
    };
  try {
    const { data } = await github(config, token, "/user/repos", { method: "POST", body, signal });
    return { owner, repo, branch: text(data?.default_branch) ?? "main", created: true };
  } catch (error) {
    throw new GitHubPublisherError(
      `${owner}/${repo} does not exist and creating it was refused: ${error instanceof Error ? error.message : String(error)}. ` +
        "Creating a repository needs the token's 存储库权限 → Administration: 读取和写入, or create the repository by hand.",
      error instanceof GitHubPublisherError ? error.code : "REPO_CREATE_FAILED",
    );
  }
}

/**
 * Render one publication outcome into the canonical lossless-JSON value.
 * @param {{kind: string, url: string, htmlUrl?: string, files: any[], rawFiles?: any[], secret?: boolean, commitMessage?: string}} outcome - shaped outcome.
 * @returns {Record<string, unknown>} the canonical value.
 */
function publishValue(outcome) {
  return {
    ok: true,
    kind: outcome.kind,
    url: outcome.url,
    htmlUrl: outcome.htmlUrl ?? outcome.url,
    ...(outcome.secret === undefined ? {} : { secret: outcome.secret }),
    files: outcome.files,
    ...(outcome.rawFiles === undefined ? {} : { rawFiles: outcome.rawFiles }),
    ...(outcome.commitMessage === undefined ? {} : { commitMessage: outcome.commitMessage }),
  };
}

/**
 * Publish the payload as a gist.
 * @param {typeof DEFAULTS} config - resolved plugin config.
 * @param {string} token - the bearer token.
 * @param {Record<string, any>} args - validated tool arguments.
 * @param {string} intro - the description to publish.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<Record<string, unknown> & {title?: string}>} the canonical value.
 */
async function publishGist(config, token, args, intro, signal) {
  /** @type {Record<string, {content: string}>} */
  const files = {};
  for (const file of args.files) files[file.path] = { content: file.content };
  const body = { files, public: flag(args.public, false) };
  if (intro.length > 0) body.description = intro;

  const { data } = await github(config, token, "/gists", { method: "POST", body, signal });
  const owner = text(data?.owner?.login) ?? "anonymous";
  const id = text(data?.id) ?? "";
  // GitHub returns the gist file map as an object keyed by filename, not an array.
  const published = data?.files !== null && typeof data?.files === "object" ? Object.values(data.files) : [];
  return publishValue({
    kind: "gist",
    url: text(data?.url) ?? `https://api.github.com/gists/${id}`,
    htmlUrl: text(data?.html_url) ?? `https://gist.github.com/${owner}/${id}`,
    secret: !flag(args.public, false),
    files: published.map((file) => ({ path: String(file?.filename ?? ""), status: "published", url: String(file?.raw_url ?? "") })),
    rawFiles: published.map((file) => {
      const name = String(file?.filename ?? "");
      const raw = text(file?.raw_url) ?? `${config.rawHost.replace(/\/+$/u, "")}/${owner}/${id}/raw/${name}`;
      return { path: name, rawUrl: raw, language: text(file?.language) ?? null };
    }),
  });
}

/**
 * Commit the payload into a repository through the contents API.
 * @param {typeof DEFAULTS} config - resolved plugin config.
 * @param {string} token - the bearer token.
 * @param {Record<string, any>} args - validated tool arguments.
 * @param {string} intro - the commit message to publish.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<Record<string, unknown>>} the canonical value.
 */
async function publishRepo(config, token, args, intro, signal) {
  const owner = text(args.owner) ?? config.owner;
  const repo = text(args.repo) ?? config.repo;
  const branch = text(args.branch) ?? config.branch ?? "main";
  if (owner === undefined || repo === undefined) {
    throw new GitHubPublisherError(
      "publishing to a repository needs an owner and a repo: pass them as arguments or set `owner`/`repo` in the github-publisher config.",
      "MISSING_TARGET",
    );
  }
  const message = intro.length > 0 ? intro : `Publish ${String(args.files.length)} file(s)`;
  // `path` names the destination itself, so its directory part is the prefix the
  // file name hangs under — appending the whole path to the file lands the content
  // in a literal `<path>/<path>` tree.
  const destination = text(args.path);
  const prefix = destination === undefined ? undefined : dirname(destination) === "." ? undefined : dirname(destination);

  /** @type {any[]} */
  const results = [];
  for (const file of args.files) {
    const path = prefix === undefined ? file.path : `${prefix}/${file.path}`;
    const route = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
    let sha;
    try {
      const existing = await github(config, token, `${route}?ref=${encodeURIComponent(branch)}`, { signal });
      // A path that is currently a directory answers with a listing, and a listing has
      // no `sha` of its own: sending one from the array would be rejected, and sending
      // none is what replaces the directory with the file.
      sha = Array.isArray(existing.data) ? undefined : text(existing.data?.sha);
    } catch (error) {
      if (!(error instanceof GitHubPublisherError) || error.code !== "HTTP_404") throw error;
    }
    const body = {
      message,
      content: Buffer.from(file.content, "utf8").toString("base64"),
      branch,
      ...(sha === undefined ? {} : { sha }),
    };
    const { data } = await github(config, token, route, { method: "PUT", body, signal });
    results.push({
      path,
      status: sha === undefined ? "created" : "updated",
      url: text(data?.content?.html_url) ?? `https://github.com/${owner}/${repo}/blob/${branch}/${path}`,
    });
  }

  return publishValue({
    kind: "repo-files",
    url: `https://github.com/${owner}/${repo}`,
    htmlUrl: results[0]?.url ?? `https://github.com/${owner}/${repo}`,
    files: results.map((file) => ({
      ...file,
      cdnUrl: cdnUrlFor(config.cdnHost, owner, repo, branch, file.path),
    })),
    commitMessage: message,
  });
}

/* -------------------------------------------------------------- intro LLM */

/**
 * Ask this session's model to write an introduction for one set of files.
 * This is the exact path `github_publish` uses when `intro` is left empty.
 * @param {any} ctx - plugin context.
 * @param {typeof DEFAULTS} config - resolved plugin config.
 * @param {any[]} files - the `{path, content}` payloads about to be published.
 * @param {{kind?: string, language?: string, hint?: string}} [options] - publication context.
 * @param {AbortSignal | undefined} [signal] - caller cancellation.
 * @returns {Promise<{text: string, route: {provider: string, model: string}}>} the introduction.
 */
export async function writeIntroduction(ctx, config, files, options = {}, signal) {
  return writeIntro(ctx, config, {
    content: files.map((file) => ({ title: file.path, text: file.content })),
    kind: options.kind,
    language: options.language,
    hint: options.hint,
  }, signal);
}

/**
 * Ask this session's model to write an introduction for the content.
 * @param {any} ctx - plugin context.
 * @param {typeof DEFAULTS} config - resolved plugin config.
 * @param {Record<string, any>} args - validated tool arguments.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<{text: string, route: {provider: string, model: string}}>} the introduction.
 */
async function writeIntro(ctx, config, args, signal) {
  const llm = ctx.get("llm");
  if (llm === undefined || typeof llm.stream !== "function") {
    throw new GitHubPublisherError("no llm service is available to write the introduction", "NO_LLM");
  }
  const defaultModel = typeof ctx.get === "function" ? ctx.get("agentDefaultModel") : undefined;
  let selection;
  if (config.introProvider !== undefined && config.introModel !== undefined) {
    selection = { provider: config.introProvider, model: config.introModel };
  } else if (defaultModel !== undefined && typeof defaultModel.currentSelection === "function") {
    selection = defaultModel.currentSelection();
  } else {
    throw new GitHubPublisherError(
      "no model route is available to write the introduction; set introProvider and introModel in the github-publisher config",
      "NO_MODEL",
    );
  }
  const provider = text(selection?.provider);
  const model = text(selection?.model);
  if (provider === undefined || model === undefined) {
    throw new GitHubPublisherError("no model route is selected; configure a default model or pass introProvider/introModel", "NO_MODEL");
  }

  const language = text(args.language) ?? "the same language the user writes in";
  const system = text(args.system) ??
    "You write release-ready introductions for content that is about to be published on GitHub. " +
    "Answer with the introduction itself and nothing else: no code fences, no headings, no preamble, no closing question. " +
    "It must be a single paragraph of at most 350 characters that still leads with what the content is, who it is for, and what it does.";
  const body = describeContent(args);
  const prompt = [
    `Write the introduction for this publication. Use ${language}.`,
    args.kind === undefined ? "" : `Publication target: ${String(args.kind)}.`,
    text(args.hint) === undefined ? "" : `Extra direction from the user: ${String(args.hint)}`,
    "",
    "Content to introduce:",
    body,
  ].filter((line) => line !== "").join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(new Error("intro generation timed out")); }, config.timeoutMs);
  const forward = () => { controller.abort(signal?.reason); };
  if (signal !== undefined) {
    if (signal.aborted) forward();
    else signal.addEventListener("abort", forward, { once: true });
  }

  try {
    const message = Object.freeze({
      id: globalThis.crypto.randomUUID(),
      role: "user",
      source: Object.freeze({ kind: "github-publisher" }),
      content: Object.freeze([Object.freeze({ type: "text", text: prompt })]),
    });
    const options = Object.freeze({
      provider,
      model,
      messages: Object.freeze([message]),
      system,
      maxTokens: config.introMaxTokens,
      signal: controller.signal,
    });
    const finished = await collectText(llm.stream(options));
    const intro = normalizeIntro(finished.text);
    if (intro.length === 0) throw new GitHubPublisherError("the model produced no introduction", "EMPTY_INTRO");
    return { text: intro, route: { provider, model } };
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof GitHubPublisherError)) {
      throw new GitHubPublisherError("the introduction was cancelled or timed out", "ABORTED");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", forward);
  }
}

/**
 * Describe the content under its character budget.
 * @param {Record<string, any>} args - validated tool arguments.
 * @returns {string} the model-facing description.
 */
function describeContent(args) {
  const chunks = [];
  const summary = text(args.summary);
  if (summary !== undefined) chunks.push(summary);
  const chunksBudget = Math.max(4_000, Math.floor((MAX_TEXT_CHARS - (summary?.length ?? 0)) / Math.max(1, args.content?.length ?? 1)));
  for (const entry of args.content ?? []) {
    const label = text(entry.title) ?? text(entry.path) ?? "内容";
    const value = String(entry.text ?? "").slice(0, chunksBudget);
    chunks.push(`### ${label}\n${value}`);
  }
  return chunks.join("\n\n");
}

/**
 * Assemble the visible text of one streamed model call.
 * @param {AsyncIterable<any>} stream - the chunk stream.
 * @returns {Promise<{text: string, finish: any}>} the joined text and terminal reason.
 */
async function collectText(stream) {
  let text = "";
  let finish;
  for await (const chunk of stream) {
    if (chunk?.type === "text-delta") text += String(chunk.text ?? "");
    else if (chunk?.type === "finish") finish = chunk.reason;
  }
  const kind = finish?.kind;
  if (kind === "error" || kind === "aborted") {
    throw new GitHubPublisherError(finish?.failure?.message ?? "the model call failed", finish?.failure?.code ?? "LLM_FAILED");
  }
  if (kind === "max-tokens") throw new GitHubPublisherError("the introduction hit the output token limit", "MAX_TOKENS");
  return { text, finish };
}

/**
 * Clean one model answer into publishable introduction text.
 * @param {string} value - the raw answer.
 * @returns {string} a single paragraph.
 */
function normalizeIntro(value) {
  const withoutFence = value.replace(/```[a-zA-Z]*\n?/gu, "").replace(/```/gu, "");
  const lines = withoutFence.split(/\r?\n/u).map((line) => line.replace(/^#+\s*/u, "").trim()).filter((line) => line.length > 0);
  const joined = lines.join(" ").replace(/\s+/gu, " ").trim();
  const quoted = /^(["'“”「『])(.*)(["'“”」』])$/su.exec(joined);
  return (quoted?.[2] ?? joined).trim();
}

/* --------------------------------------------------------- composer route */

/** Exact mount point of the composer button's same-origin API. */
const ROUTE_PREFIX = "/github-publisher";
/** Refuse absurd request bodies rather than buffering them. */
const ROUTE_BODY_LIMIT = 4_000_000;

/**
 * Read one request body into text, refusing anything past the limit.
 * @param {import("node:http").IncomingMessage} req - the request.
 * @returns {Promise<string>} the decoded body.
 */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > ROUTE_BODY_LIMIT) throw new GitHubPublisherError("the request body is too large", "BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Parse a JSON request body.
 * @param {import("node:http").IncomingMessage} req - the request.
 * @returns {Promise<Record<string, any>>} the decoded object.
 */
async function readJson(req) {
  const body = (await readBody(req)).trim();
  if (body.length === 0) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new GitHubPublisherError("the request body is not valid JSON", "BAD_JSON");
  }
}

/**
 * Answer one request with JSON.
 * @param {import("node:http").ServerResponse} res - the response.
 * @param {number} status - the HTTP status.
 * @param {unknown} payload - the JSON value.
 * @returns {void}
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Serve one composer-button call, converting every failure into a JSON envelope.
 * @param {import("node:http").ServerResponse} res - the response.
 * @param {() => Promise<unknown>} operation - the route body.
 * @returns {Promise<void>} resolves once the response is written.
 */
async function respond(res, operation) {
  try {
    sendJson(res, 200, await operation());
  } catch (error) {
    sendJson(res, 200, failure(error));
  }
}

/**
 * Register the composer button's same-origin API on the web server.
 *
 * `inject` requires `webServer`, so this is always reached through
 * `ctx.webServer`; the optional read keeps the plugin usable in a composition
 * that has no web server at all (headless runs), where the button is absent.
 * @param {any} ctx - the plugin context.
 * @param {typeof DEFAULTS} config - resolved plugin config.
 * @returns {void}
 */
function registerRoutes(ctx, config) {
  const webServer = typeof ctx.get === "function" ? ctx.get("webServer") : undefined;
  if (webServer === undefined || typeof webServer.register !== "function") return;

  ctx.effect(() => webServer.register({
    kind: "prefix",
    path: ROUTE_PREFIX,
    async handler(req, res) {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname.replace(/\/+$/u, "") || ROUTE_PREFIX;
      const method = req.method ?? "GET";

      if (path === `${ROUTE_PREFIX}/status`) {
        if (method !== "GET") return sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", error: "use GET" });
        return respond(res, async () => {
          const credential = await resolveToken(ctx, config, undefined);
          if (credential === undefined) {
            const searched = (await tokenFromDotEnv(profileCandidates())).searched;
            return {
              ok: false,
              code: "NO_TOKEN",
              error: "no GitHub token is configured",
              searched,
            };
          }
          const { data } = await github(config, credential.token, "/user");
          return {
            ok: true,
            login: text(data?.login) ?? "",
            name: text(data?.name) ?? "",
            source: credential.source,
            tokenPreview: maskToken(credential.token),
            defaultRepo: config.repo ?? DEFAULT_REPO,
            defaultBranch: config.branch ?? null,
          };
        });
      }

      if (path === `${ROUTE_PREFIX}/publish`) {
        if (method !== "POST") return sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", error: "use POST" });
        return respond(res, async () => {
          const args = await readJson(req);
          const content = text(args.content);
          if (content === undefined) throw new GitHubPublisherError("there is nothing to publish", "NO_CONTENT");
          const filename = text(args.filename) ?? "README.md";
          const summary = text(args.summary);
          const language = text(args.language);
          const publicGist = flag(args.public, true);

          const credential = await resolveToken(ctx, config, undefined);
          if (credential === undefined) {
            const searched = (await tokenFromDotEnv(profileCandidates())).searched;
            throw new GitHubPublisherError(
              "no GitHub token is configured. Put GITHUB_TOKEN=... in the profile .env file, or set `token` in the github-publisher plugin config. " +
                `Searched: ${searched.length === 0 ? "no profile directory could be derived" : searched.join(", ")}`,
              "NO_TOKEN",
            );
          }

          const target = text(args.target) ?? "repo";
          const wantsRepo = target !== "gist";
          const repoName = text(args.repo) ?? config.repo ?? DEFAULT_REPO;
          // `path` is the repository-relative destination, `filename` only names the
          // content for the introduction prompt. Passing `filename` on as the
          // repository destination makes a path such as ​notes/x.md land in a literal
          // `notes/x.md/notes/x.md` tree, so the two are kept apart here.
          const filePath = wantsRepo ? text(args.path) ?? filename : filename;

          let intro = text(args.intro) ?? "";
          let introSource = intro.length === 0 ? "" : "supplied";
          let introNote;
          // The introduction is a description, not a gate: a failing model route
          // must not cost the publish. Derive a local description instead and
          // report which path produced it.
          if (intro.length === 0) {
            try {
              intro = (await writeIntro(ctx, config, {
                summary,
                content: [{ title: filename, text: content }],
                kind: wantsRepo ? "a repository commit" : "a gist",
                language,
                hint: text(args.hint),
              }, AbortSignal.timeout(config.timeoutMs))).text;
              introSource = "model";
            } catch (error) {
              const shaped = failure(error);
              intro = fallbackIntro(content, summary);
              introSource = "fallback";
              introNote = `${shaped.code}: ${shaped.error}`;
            }
          }

          if (wantsRepo) {
            const signal = AbortSignal.timeout(config.timeoutMs);
            const repository = await ensureRepo(config, credential.token, {
              owner: text(args.owner) ?? config.owner,
              repo: repoName,
              description: summary,
              private: flag(args.private, true),
            }, signal);
            const value = await publishRepo(config, credential.token, {
              owner: repository.owner,
              repo: repository.repo,
              branch: text(args.branch) ?? config.branch ?? repository.branch,
              path: filePath,
              files: [{ path: basename(filePath), content }],
            }, intro, signal);
            return {
              ...value,
              intro,
              introSource,
              introNote,
              filename: filePath,
              target: "repo",
              repo: `${repository.owner}/${repository.repo}`,
              repoCreated: repository.created,
              login: text(args.login),
            };
          }

          const value = await publishGist(config, credential.token, {
            files: [{ path: filename, content }],
            public: publicGist,
          }, intro, AbortSignal.timeout(config.timeoutMs));

          return { ...value, intro, introSource, introNote, filename, target: "gist", login: text(args.login) };
        });
      }

      return sendJson(res, 404, { ok: false, code: "NOT_FOUND", error: `unknown github-publisher route ${path}` });
    },
  }), "github-publisher.routes");
}

/* ------------------------------------------------------- tool definitions */

/** JSON Schema for one `{path, content}` payload entry. */
const FILE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["path", "content"],
  properties: {
    path: { type: "string", description: "Repository-relative path, or the gist filename, such as src/index.js or NOTES.md." },
    content: { type: "string", description: "Exact file body. Text only; it is published verbatim." },
  },
});

/** JSON Schema for one `{title, path, text}` intro input entry. */
const CONTENT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "Short label for this piece of content." },
    path: { type: "string", description: "Path the content lives at, when it has one." },
    text: { type: "string", description: "The content itself, or a digest of it when it is large." },
  },
});

/**
 * Build one registry-ready tool definition.
 * @param {{name: string, description: string, parameters: Record<string, unknown>, outputSchema: Record<string, unknown>, render: (value: any) => string, title: string, kind: string, execute: (args: any, exec: any) => Promise<any>}} tool - the tool.
 * @returns {Record<string, unknown>} a `ToolDefinition`.
 */
function defineTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: {
      schema: tool.outputSchema,
      render: (_args, value) => [{ type: "text", text: tool.render(value) }],
    },
    // Must exceed the request timeout this tool inherits below, or the harness
    // cancels a publish that is still legitimately waiting on its introduction.
    timeoutMs: DEFAULT_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      try {
        return await tool.execute(args, exec);
      } catch (error) {
        return failure(error);
      }
    },
    presentCall: (args) => ({
      card: "generic",
      kind: tool.kind,
      title: tool.title,
      rawInput: args,
    }),
    presentResult: (_args, result) => ({
      card: "generic",
      title: result?.isError === true ? `${tool.title} failed` : tool.title,
    }),
  };
}

/** The success envelope shared by every publication output schema. */
const PUBLISH_OUTPUT = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
    code: { type: "string" },
    kind: { type: "string" },
    title: { type: "string", description: "The introduction that was published: the gist description or the commit message." },
    url: { type: "string" },
    htmlUrl: { type: "string" },
    secret: { type: "boolean" },
    commitMessage: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          path: { type: "string" },
          status: { type: "string" },
          url: { type: "string" },
        },
      },
    },
    rawFiles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          path: { type: "string" },
          rawUrl: { type: "string" },
          language: { type: "string" },
        },
      },
    },
  },
});

/**
 * Register the GitHub publisher tools.
 * @param {any} ctx - the plugin context.
 * @param {unknown} config - the loader-supplied config.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);

  registerRoutes(ctx, resolved);

  ctx.tools.register(defineTool({
    name: "github_account",
    kind: "other",
    title: "GitHub account",
    description:
      "Check the GitHub connection used for publishing. Resolves the configured token, verifies it against GitHub, " +
      "and reports the signed-in login, account name, and token scopes. The token itself is never printed, " +
      "only its provenance and a masked preview.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        token: { type: "string", description: "Optional token to verify instead of the configured one; it is used once and not stored." },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        error: { type: "string" },
        code: { type: "string" },
        login: { type: "string" },
        name: { type: "string" },
        scopes: { type: "string" },
        source: { type: "string" },
        tokenPreview: { type: "string" },
        repo: { type: "string" },
      },
    },
    render: (value) => value.ok === true
      ? [
        `GitHub connection is live.`,
        `signed in as: ${value.login}${value.name.length > 0 ? ` (${value.name})` : ""}`,
        `token: ${value.tokenPreview} — source: ${value.source}`,
        `scopes: ${value.scopes.length > 0 ? value.scopes : "(none reported)"}`,
        `default repository: ${value.repo.length > 0 ? value.repo : "(not configured)"}`,
      ].join("\n")
      : `GitHub connection failed [${value.code}]: ${value.error}`,
    async execute(args) {
      const credential = await resolveToken(ctx, resolved, text(args.token));
      if (credential === undefined) {
        throw new GitHubPublisherError(
          "no GitHub token is configured. Add `token` to the github-publisher plugin config in the profile's cordis.patch.yml, " +
            "or put GITHUB_TOKEN=... in the profile .env file, or set the GITHUB_TOKEN environment variable. " +
            "Create a fine-grained token with the `gist` scope (plus `contents: write` for repository publishing).",
          "NO_TOKEN",
        );
      }
      const { data, headers } = await github(resolved, credential.token, "/user");
      const login = text(data?.login) ?? "";
      return {
        ok: true,
        login,
        name: text(data?.name) ?? "",
        scopes: text(headers.get("x-oauth-scopes") ?? undefined) ?? "",
        source: credential.source,
        tokenPreview: maskToken(credential.token),
        repo: resolved.owner !== undefined && resolved.repo !== undefined ? `${resolved.owner}/${resolved.repo}` : "",
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "github_publish",
    kind: "other",
    title: "Publish to GitHub",
    description:
      "Publish AI-written content to GitHub. `mode: gist` creates a secret (or public) gist; `mode: repo` commits the files " +
      "into a repository through the contents API, creating or updating each path. An empty `intro` makes the plugin write the " +
      "introduction with this session's model, which then becomes the gist description or the commit message. Returns the " +
      "public URL, the raw URLs, and the introduction that was published.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["files"],
      properties: {
        files: { type: "array", items: FILE_SCHEMA, description: "Files to publish, each with its path and exact text content." },
        mode: { type: "string", enum: ["gist", "repo"], description: "`gist` (default) publishes a gist; `repo` commits into a repository." },
        intro: { type: "string", description: "The introduction to publish. Leave it out to have the model write one." },
        public: { type: "boolean", description: "For `mode: gist`: publish publicly instead of as a secret gist. Defaults to false." },
        owner: { type: "string", description: "For `mode: repo`: repository owner; defaults to the configured owner." },
        repo: { type: "string", description: "For `mode: repo`: repository name; defaults to the configured repo." },
        branch: { type: "string", description: "For `mode: repo`: target branch; defaults to the configured branch or main." },
        path: { type: "string", description: "For `mode: repo`: destination folder inside the repository." },
        language: { type: "string", description: "Language the generated introduction must use." },
        hint: { type: "string", description: "Extra direction for the generated introduction." },
      },
    },
    outputSchema: PUBLISH_OUTPUT,
    render: (value) => value.ok === true
      ? [
        `Published to GitHub as ${value.kind}: ${value.htmlUrl}`,
        value.title === undefined ? "" : `intro: ${value.title}`,
        ...value.files.map((file) => `- ${file.path} (${file.status})`),
      ].filter((line) => line.length > 0).join("\n")
      : `GitHub publish failed [${value.code}]: ${value.error}`,
    async execute(args, exec) {
      const mode = text(args.mode) ?? "gist";
      if (mode !== "gist" && mode !== "repo") throw new GitHubPublisherError(`unknown mode "${mode}"`, "BAD_MODE");
      if (!Array.isArray(args.files) || args.files.length === 0) throw new GitHubPublisherError("at least one file is required", "NO_FILES");
      const credential = await resolveToken(ctx, resolved, undefined);
      if (credential === undefined) throw new GitHubPublisherError("no GitHub token is configured", "NO_TOKEN");

      const signal = exec?.signal;
      const intro = text(args.intro) ?? (await writeIntro(ctx, resolved, {
        content: (args.files ?? []).map((file) => ({ title: file.path, text: file.content })),
        kind: mode === "gist" ? "a secret gist" : "a repository",
        language: text(args.language),
        hint: text(args.hint),
      }, signal)).text;

      const value = mode === "gist"
        ? await publishGist(resolved, credential.token, args, intro, signal)
        : await publishRepo(resolved, credential.token, args, intro, signal);
      return { ...value, title: intro };
    },
  }));

  ctx.tools.register(defineTool({
    name: "github_intro",
    kind: "other",
    title: "Write GitHub intro",
    description:
      "Write, or rewrite, the introduction for content that is about to be published on GitHub. Uses this session's own model " +
      "route, so the wording matches the conversation that produced the content. Returns the introduction text and the model " +
      "route that wrote it; nothing is published.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string", description: "What the publication is, in the user's own words." },
        content: { type: "array", items: CONTENT_SCHEMA, description: "The content to introduce." },
        kind: { type: "string", description: "Publication target, such as a repository, a gist, or a release." },
        language: { type: "string", description: "Language the introduction must use." },
        hint: { type: "string", description: "Extra direction, tone, or length the user asked for." },
        system: { type: "string", description: "Replacement system prompt for this one call." },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        error: { type: "string" },
        code: { type: "string" },
        intro: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
      },
    },
    render: (value) => value.ok === true
      ? `Introduction (${value.provider}/${value.model}):\n${value.intro}`
      : `Writing the introduction failed [${value.code}]: ${value.error}`,
    async execute(args, exec) {
      const written = await writeIntro(ctx, resolved, args, exec?.signal);
      return { ok: true, intro: written.text, provider: written.route.provider, model: written.route.model };
    },
  }));

  if (typeof ctx.logger?.info === "function") {
    ctx.logger.info("github-publisher: registered github_account, github_publish, github_intro");
  }
}

/**
 * Mask one token for display, keeping only its first and last characters.
 * @param {string} token - the secret.
 * @returns {string} a safe preview.
 */
function maskToken(token) {
  if (token.length <= 8) return `${token.slice(0, 1)}***${token.slice(-1)}`;
  return `${token.slice(0, 4)}***${token.slice(-4)}`;
}
