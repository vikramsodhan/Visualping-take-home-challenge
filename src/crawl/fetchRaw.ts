import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basicAuthHeader, isInScope, type Config } from '../config.ts';

/** A single HTTP response, kept as the exact bytes and header pairs that came off the wire. */
export interface RawResponse {
  /** The URL of this specific hop, which is not the original request URL after a redirect. */
  url: string;
  status: number;
  statusText: string;
  httpVersion: string;
  /** Header name/value pairs in wire order, preserving case and duplicates. */
  rawHeaders: Array<[string, string]>;
  /** Lowercased header name to all values sent under it. */
  headers: Record<string, string[]>;
  body: Buffer;
  fetchedAt: string;
  elapsedMs: number;
  /** Absolute `Location` target when this response is a redirect, else null. */
  redirectedTo: string | null;
}

/** The full redirect chain, and a direct handle on the response that ended it. */
export interface FetchResult {
  /** Every response received, in order. A request with no redirects yields exactly one. */
  hops: RawResponse[];
  /** The last element of `hops`, the same object. Its `url` is where the chain actually landed. */
  finalResponse: RawResponse;
}

export interface FetchExactOptions {
  config: Config;
  /** `Cookie` header value to send, e.g. cookies lifted from the browser session. */
  cookies?: string;
  extraHeaders?: Record<string, string>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetches a URL and returns every response in its redirect chain with bodies untouched.
 *
 * Uses `node:http`/`node:https` directly rather than `fetch()` because undici transparently
 * decompresses and re-normalises responses, and the archive is supposed to hold what the server
 * actually sent — a gzipped body stays gzipped here and is decoded later at analysis time.
 *
 * Redirects are followed by hand so credentials can be re-attached on each hop; most HTTP clients
 * strip the `Authorization` header across redirects, which on this site would silently turn a
 * reachable page into a 401 dead end. Every hop is returned, not just the last, because a 30x
 * response's headers are as good a hiding place as its destination's body.
 */
export async function fetchExactBytes(
  target: string | URL,
  options: FetchExactOptions,
): Promise<FetchResult> {
  const { config } = options;
  const hops: RawResponse[] = [];
  let url = new URL(target);
  let cookies = options.cookies;

  for (let hop = 0; ; hop += 1) {
    const response = await performRequest(url, buildHeaders(url, config, cookies, options.extraHeaders), config);
    hops.push(response);

    if (!response.redirectedTo) break;
    if (hop >= config.limits.maxRedirects) {
      throw new Error(`Exceeded ${config.limits.maxRedirects} redirects starting from ${target}`);
    }

    cookies = mergeCookies(cookies, response.headers['set-cookie']);
    url = new URL(response.redirectedTo);
  }

  return { hops, finalResponse: hops[hops.length - 1]! };
}

/**
 * Assembles request headers for one hop. Credentials are attached only for in-scope URLs, so a
 * redirect that bounces off-site cannot leak them to a third-party host.
 */
function buildHeaders(
  url: URL,
  config: Config,
  cookies: string | undefined,
  extraHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': config.userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    // Advertise what a browser would so the server picks the same encoding it picked for Chrome;
    // the bytes are stored compressed and decoded by the analyser.
    'Accept-Encoding': 'gzip, deflate, br',
    ...extraHeaders,
  };

  if (cookies) headers.Cookie = cookies;
  if (isInScope(url, config.baseUrl)) {
    headers.Authorization = basicAuthHeader(config.username, config.password);
  }

  return headers;
}

function performRequest(
  url: URL,
  headers: Record<string, string>,
  config: Config,
): Promise<RawResponse> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const startedAt = Date.now();
  const fetchedAt = new Date().toISOString();

  return new Promise<RawResponse>((resolve, reject) => {
    const req = send(
      url,
      { method: 'GET', headers, signal: AbortSignal.timeout(config.limits.requestTimeoutMs) },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const rawHeaders = toHeaderPairs(res.rawHeaders);
          resolve({
            url: url.toString(),
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            httpVersion: res.httpVersion,
            rawHeaders,
            headers: groupHeaders(rawHeaders),
            body: Buffer.concat(chunks),
            fetchedAt,
            elapsedMs: Date.now() - startedAt,
            redirectedTo: resolveRedirect(url, res),
          });
        });
      },
    );

    req.on('error', reject);
    req.end();
  });
}

function resolveRedirect(url: URL, res: IncomingMessage): string | null {
  const status = res.statusCode ?? 0;
  const location = res.headers.location;
  if (!REDIRECT_STATUSES.has(status) || !location) return null;
  try {
    return new URL(location, url).toString();
  } catch {
    return null;
  }
}

/** Node exposes raw headers as a flat [name, value, name, value] array; pair them up. */
function toHeaderPairs(flat: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    pairs.push([flat[i]!, flat[i + 1]!]);
  }
  return pairs;
}

function groupHeaders(pairs: Array<[string, string]>): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const [name, value] of pairs) {
    const key = name.toLowerCase();
    (grouped[key] ??= []).push(value);
  }
  return grouped;
}

/**
 * Folds `Set-Cookie` values from one hop into the `Cookie` header for the next, with later values
 * replacing earlier ones of the same name. Attributes (`Path`, `HttpOnly`, `Max-Age`, …) are
 * dropped, since a `Cookie` request header carries only `name=value` pairs.
 *
 * Deliberately not RFC 6265: domain, path and expiry are ignored, so every cookie is sent to every
 * in-scope URL. That is safe for a same-origin crawl of one small site and avoids a dependency.
 */
function mergeCookies(existing: string | undefined, setCookie: string[] | undefined): string | undefined {
  if (!setCookie?.length) return existing;

  const jar = new Map<string, string>();
  for (const pair of existing?.split('; ') ?? []) {
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  for (const header of setCookie) {
    const [nameValue] = header.split(';');
    const eq = nameValue?.indexOf('=') ?? -1;
    if (nameValue && eq > 0) jar.set(nameValue.slice(0, eq).trim(), nameValue.slice(eq + 1));
  }

  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}
