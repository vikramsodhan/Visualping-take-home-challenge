import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import type { CaptureMethod, DiscoveryMethod, StoredArtifact } from './store.ts';

/** One row of the crawl index: what was fetched, what came back, and how we found it. */
export interface ManifestEntry {
  url: string;
  captureMethod: CaptureMethod;
  status: number;
  contentType: string | null;
  byteLength: number;
  sha256: string;
  discoveryMethod: DiscoveryMethod;
  discoveredFromUrl: string | null;
  redirectedTo: string | null;
  fetchedAt: string;
  /** Relative to the manifest's own directory, so the whole `out/` tree can be moved or shared. */
  bodyRelativePath: string;
  metaRelativePath: string;
}

/**
 * The crawl index. Keyed by capture method and URL so a re-crawl updates rows in place, which is
 * what lets `verify` diff two runs and report exactly what changed.
 */
export interface Manifest {
  version: number;
  createdAt: string;
  updatedAt: string;
  entries: Record<string, ManifestEntry>;
}

const MANIFEST_VERSION = 1;

/** One URL that a second crawl saw differently from the baseline. */
export interface ChangedEntry {
  key: string;
  url: string;
  baselineSha256: string;
  freshSha256: string;
}

/**
 * How a second, independent crawl compared to the baseline. `newKeys` is the one that matters for
 * completeness: a URL the re-crawl reached that the first crawl never did means the first crawl was
 * not complete. `missing` catches transient fetch failures, and `changed` flags content that moved
 * under us (expected only on genuinely dynamic pages).
 */
export interface ManifestDiff {
  newKeys: string[];
  missing: string[];
  changed: ChangedEntry[];
  unchanged: number;
}

/**
 * Compares a fresh crawl against the baseline it should reproduce. Returns exactly what differs, so
 * `verify` can turn it into a pass/fail completeness verdict rather than an assertion.
 */
export function diffManifests(baseline: Manifest, fresh: Manifest): ManifestDiff {
  const diff: ManifestDiff = { newKeys: [], missing: [], changed: [], unchanged: 0 };

  for (const [key, entry] of Object.entries(fresh.entries)) {
    const before = baseline.entries[key];
    if (!before) {
      diff.newKeys.push(key);
    } else if (before.sha256 !== entry.sha256) {
      diff.changed.push({
        key,
        url: entry.url,
        baselineSha256: before.sha256,
        freshSha256: entry.sha256,
      });
    } else {
      diff.unchanged += 1;
    }
  }

  for (const key of Object.keys(baseline.entries)) {
    if (!fresh.entries[key]) diff.missing.push(key);
  }

  return diff;
}

/**
 * Identity of a manifest row. Capture method is part of the key because one URL can legitimately
 * appear twice — once raw-fetched, once as the body the browser saw.
 */
export function manifestKey(url: string, captureMethod: CaptureMethod): string {
  return `${captureMethod} ${url}`;
}

/** Returns an empty manifest, used as the starting point for a first crawl. */
export function emptyManifest(): Manifest {
  const now = new Date().toISOString();
  return { version: MANIFEST_VERSION, createdAt: now, updatedAt: now, entries: {} };
}

/**
 * Loads the crawl index, or an empty one if this is the first run or the format has moved on.
 * Lets a crawl resume, and gives `verify` the previous run's state to diff against.
 */
export async function loadManifest(manifestPath: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
    return parsed.version === MANIFEST_VERSION ? parsed : emptyManifest();
  } catch {
    return emptyManifest();
  }
}

/** Persists the crawl index, stamping `updatedAt`. */
export async function saveManifest(manifestPath: string, manifest: Manifest): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Records a stored artifact in the manifest, replacing any previous row with the same key, and
 * returns the row so callers can report on it without re-reading the manifest. Absolute paths are
 * rewritten relative to `manifestDir` on the way in.
 */
export function upsertArtifact(
  manifest: Manifest,
  artifact: StoredArtifact,
  manifestDir: string,
): ManifestEntry {
  const { meta } = artifact;
  const entry: ManifestEntry = {
    url: meta.url,
    captureMethod: meta.captureMethod,
    status: meta.status,
    contentType: meta.contentType,
    byteLength: meta.byteLength,
    sha256: meta.sha256,
    discoveryMethod: meta.discoveryMethod,
    discoveredFromUrl: meta.discoveredFromUrl,
    redirectedTo: meta.redirectedTo,
    fetchedAt: meta.fetchedAt,
    bodyRelativePath: relative(manifestDir, artifact.bodyAbsolutePath),
    metaRelativePath: relative(manifestDir, artifact.metaAbsolutePath),
  };

  manifest.entries[manifestKey(meta.url, meta.captureMethod)] = entry;
  return entry;
}
