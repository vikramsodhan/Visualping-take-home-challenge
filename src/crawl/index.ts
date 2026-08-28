import { mkdir } from 'node:fs/promises';
import type { Config } from '../config.ts';
import {
  loadManifest,
  saveManifest,
  upsertArtifact,
  type Manifest,
  type ManifestEntry,
} from '../archive/manifest.ts';
import { saveArtifact, type Provenance } from '../archive/store.ts';
import { fetchExactBytes } from './fetchRaw.ts';

/** Shared state threaded through a crawl: resolved config plus the index being built. */
export interface CrawlContext {
  config: Config;
  manifest: Manifest;
}

/** What a crawl run did, enough to print a summary and to spot auth plumbing failures. */
export interface CrawlSummary {
  urlsRequested: number;
  /** Higher than `urlsRequested` when redirects are involved: every hop is archived. */
  responsesArchived: number;
  bytesArchived: number;
  /** 401/403 responses. Non-zero means credentials are not reaching every request. */
  authFailures: number;
  entries: ManifestEntry[];
}

/**
 * Fetches one URL and archives every response in its redirect chain, recording each in the
 * manifest and returning the rows created.
 *
 * This is the unit the browser-driven frontier will call once per discovered URL, kept separate
 * from `runCrawl` so the fetch-and-store path stays identical however a URL was found.
 */
export async function fetchAndArchive(
  context: CrawlContext,
  url: string,
  provenance: Provenance,
): Promise<ManifestEntry[]> {
  const { config, manifest } = context;
  const { hops } = await fetchExactBytes(url, { config });
  const entries: ManifestEntry[] = [];

  for (const [index, hop] of hops.entries()) {
    // Only the first hop was reached the way the caller described; the rest we followed ourselves.
    const hopProvenance: Provenance =
      index === 0
        ? provenance
        : { discoveryMethod: 'http-redirect', discoveredFromUrl: hops[index - 1]!.url };

    const stored = await saveArtifact(config.archiveDir, hop, 'raw-fetch', hopProvenance);
    entries.push(upsertArtifact(manifest, stored, config.outDir));
  }

  return entries;
}

/**
 * Runs a crawl and returns what it archived. For now it fetches only `BASE_URL` and its redirect
 * chain; the browser-driven frontier that widens this to the whole site arrives in a later step.
 */
export async function runCrawl(config: Config): Promise<CrawlSummary> {
  await mkdir(config.archiveDir, { recursive: true });

  const context: CrawlContext = { config, manifest: await loadManifest(config.manifestPath) };
  const entries = await fetchAndArchive(context, config.baseUrl.toString(), {
    discoveryMethod: 'seed',
    discoveredFromUrl: null,
  });

  await saveManifest(config.manifestPath, context.manifest);

  return {
    urlsRequested: 1,
    responsesArchived: entries.length,
    bytesArchived: entries.reduce((total, entry) => total + entry.byteLength, 0),
    authFailures: entries.filter((entry) => entry.status === 401 || entry.status === 403).length,
    entries,
  };
}
