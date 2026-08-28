import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256Hex, shortHash } from '../util/hash.ts';
import type { RawResponse } from '../crawl/fetchRaw.ts';

/**
 * How an artifact's bytes were obtained. `raw-fetch` is the plain HTTP download that preserves the
 * wire bytes; `browser-observed` is a body the browser received that we could not re-request
 * faithfully, such as the response to a POST.
 */
export type CaptureMethod = 'raw-fetch' | 'browser-observed';

/**
 * How the crawler learned a URL existed. The report groups findings by this to show which
 * discovery mechanism was load-bearing — in particular, how much was reachable only because a
 * real browser was driving. Later steps fill in the values beyond the first two.
 */
export type DiscoveryMethod =
  | 'seed'
  | 'http-redirect'
  | 'anchor-href'
  | 'dom-attribute'
  | 'network-request'
  | 'css-reference'
  | 'computed-style'
  | 'interaction-click'
  | 'script-string';

/** The trail that led the crawler to a URL: by what mechanism, and from which page. */
export interface Provenance {
  discoveryMethod: DiscoveryMethod;
  /** The URL whose content revealed this one. Null for the seed. */
  discoveredFromUrl: string | null;
}

/** The sidecar record written next to a body: the response as the server sent it, plus its trail. */
export interface ArtifactMeta extends Provenance {
  url: string;
  status: number;
  statusText: string;
  httpVersion: string;
  rawHeaders: Array<[string, string]>;
  headers: Record<string, string[]>;
  contentType: string | null;
  byteLength: number;
  sha256: string;
  captureMethod: CaptureMethod;
  fetchedAt: string;
  elapsedMs: number;
  redirectedTo: string | null;
  /** Bare filename of the body, with no directory part. Resolved against the archive directory. */
  bodyFileName: string;
}

/**
 * An artifact as it now exists on disk. Both paths are absolute — the manifest is what stores
 * relative ones.
 */
export interface StoredArtifact {
  meta: ArtifactMeta;
  bodyAbsolutePath: string;
  metaAbsolutePath: string;
}

/**
 * Writes one response to the archive as two files: the body byte-for-byte, and a sidecar JSON of
 * status, headers and provenance. Returns both absolute paths and the metadata that was written.
 *
 * Only response data is persisted. Request headers are deliberately never written, because that is
 * where the `Authorization` header lives and the archive must stay safe to inspect and share.
 */
export async function saveArtifact(
  archiveDir: string,
  response: RawResponse,
  captureMethod: CaptureMethod,
  provenance: Provenance,
): Promise<StoredArtifact> {
  const contentType = response.headers['content-type']?.[0] ?? null;
  const bodyFileName = archiveFileNameFor(response.url, captureMethod, contentType);
  const bodyAbsolutePath = join(archiveDir, bodyFileName);
  const metaAbsolutePath = `${bodyAbsolutePath}.meta.json`;

  const meta: ArtifactMeta = {
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    httpVersion: response.httpVersion,
    rawHeaders: response.rawHeaders,
    headers: response.headers,
    contentType,
    byteLength: response.body.byteLength,
    sha256: sha256Hex(response.body),
    captureMethod,
    fetchedAt: response.fetchedAt,
    elapsedMs: response.elapsedMs,
    redirectedTo: response.redirectedTo,
    bodyFileName,
    ...provenance,
  };

  await mkdir(archiveDir, { recursive: true });
  await writeFile(bodyAbsolutePath, response.body);
  await writeFile(metaAbsolutePath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  return { meta, bodyAbsolutePath, metaAbsolutePath };
}

/**
 * Reads a stored artifact's metadata and bytes back for offline analysis, so the analyser never
 * needs to know the archive's naming scheme. The body is located via the filename recorded in the
 * metadata rather than by transforming the sidecar's path.
 */
export async function readArtifact(
  metaAbsolutePath: string,
): Promise<{ meta: ArtifactMeta; body: Buffer }> {
  const meta = JSON.parse(await readFile(metaAbsolutePath, 'utf8')) as ArtifactMeta;
  const body = await readFile(join(dirname(metaAbsolutePath), meta.bodyFileName));
  return { meta, body };
}

/**
 * Builds a filename that is readable enough to browse by eye and unique per URL. The stem comes
 * from the URL path so the archive can be skimmed; a short hash of the full URL keeps two
 * resources that slugify alike — `/docs/` and `/docs/?ref=related`, say — from colliding.
 */
export function archiveFileNameFor(
  url: string,
  captureMethod: CaptureMethod,
  contentType: string | null,
): string {
  const parsed = new URL(url);
  const stem = slugifyPath(parsed.pathname);
  const digest = shortHash(`${captureMethod}\n${url}`);
  const prefix = captureMethod === 'browser-observed' ? 'browser__' : '';
  return `${prefix}${stem}__${digest}${extensionFor(parsed.pathname, contentType)}`;
}

/** Flattens a URL path into one filesystem-safe segment, dropping any extension. */
function slugifyPath(pathname: string): string {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return 'index';
  return (
    trimmed
      .replace(/\.[^./]*$/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'index'
  );
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'text/html': '.html',
  'text/css': '.css',
  'text/plain': '.txt',
  'text/javascript': '.js',
  'application/javascript': '.js',
  'application/json': '.json',
  'application/ld+json': '.json',
  'application/manifest+json': '.json',
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'application/pdf': '.pdf',
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/wasm': '.wasm',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
};

/** Prefers the served Content-Type over the URL's extension, since the server is authoritative. */
function extensionFor(pathname: string, contentType: string | null): string {
  const mime = contentType?.split(';')[0]?.trim().toLowerCase();
  if (mime && EXTENSION_BY_MIME[mime]) return EXTENSION_BY_MIME[mime];

  const fromPath = /\.([A-Za-z0-9]{1,8})$/.exec(pathname)?.[1];
  return fromPath ? `.${fromPath.toLowerCase()}` : '.bin';
}
