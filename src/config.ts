import { resolve } from 'node:path';

/** Tunables that shape network behaviour, all overridable from `.env`. */
export interface CrawlLimits {
  requestTimeoutMs: number;
  maxRedirects: number;
}

/** Everything the tool needs to run, resolved once at startup from the environment. */
export interface Config {
  baseUrl: URL;
  username: string;
  password: string;
  outDir: string;
  archiveDir: string;
  manifestPath: string;
  reportPath: string;
  findingsPath: string;
  userAgent: string;
  limits: CrawlLimits;
}

const REQUIRED_KEYS = ['BASE_URL', 'BASIC_AUTH_USER', 'BASIC_AUTH_PASS'] as const;

/**
 * Chrome's UA, so the plain HTTP fetch is served the same bytes the browser was served.
 * A server that content-negotiates on User-Agent would otherwise hand the archive something
 * different from what the crawler actually saw.
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

/**
 * Reads and validates configuration from the environment, returning a fully resolved `Config`
 * with absolute output paths. Exists so no other module has to touch `process.env` or guess
 * where the archive lives. Throws a message naming the missing keys — never their values, so a
 * failure is safe to paste into a bug report.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED_KEYS.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required config: ${missing.join(', ')}.\n` +
        'Copy .env.example to .env and fill it in (.env is gitignored).',
    );
  }

  const baseUrl = parseBaseUrl(env.BASE_URL!.trim());
  const outDir = resolve(process.cwd(), env.OUT_DIR?.trim() || 'out');

  return {
    baseUrl,
    username: env.BASIC_AUTH_USER!.trim(),
    password: env.BASIC_AUTH_PASS!,
    outDir,
    archiveDir: resolve(outDir, 'archive'),
    manifestPath: resolve(outDir, 'manifest.json'),
    reportPath: resolve(outDir, 'report.md'),
    findingsPath: resolve(outDir, 'findings.json'),
    userAgent: env.USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    limits: {
      requestTimeoutMs: readPositiveInt(env.REQUEST_TIMEOUT_MS, 30_000),
      maxRedirects: readPositiveInt(env.MAX_REDIRECTS, 10),
    },
  };
}

/**
 * Builds the `Authorization` header value for HTTP Basic Auth. Returned rather than stored on
 * the config so there is exactly one place that encodes the password, making it easy to audit
 * that it never reaches disk or the console.
 */
export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/**
 * Whether a URL is on the site we are crawling. Gates both crawl scope and — more importantly —
 * whether credentials are attached, so they can never be sent to a third-party host.
 */
export function isInScope(url: URL, baseUrl: URL): boolean {
  return url.protocol === baseUrl.protocol && url.host === baseUrl.host;
}

function parseBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`BASE_URL is not a valid URL. Include the scheme, e.g. https://example.com/`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`BASE_URL must be http or https, got "${url.protocol}"`);
  }
  return url;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got "${raw}"`);
  }
  return parsed;
}
