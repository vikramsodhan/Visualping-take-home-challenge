import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, Page } from 'puppeteer';
import type { Config } from '../config.ts';
import {
  loadManifest,
  saveManifest,
  upsertArtifact,
  type Manifest,
  type ManifestEntry,
} from '../archive/manifest.ts';
import { saveArtifact, type DiscoveryMethod, type Provenance } from '../archive/store.ts';
import { launchBrowser, openAuthenticatedPage } from './browser.ts';
import { discoverUrls, startNetworkRecorder, type DiscoveredUrl } from './discover.ts';
import { fetchExactBytes } from './fetchRaw.ts';
import { UrlFrontier } from './frontier.ts';

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
  /** Pages opened in the browser. Only HTML is worth rendering. */
  pagesRendered: number;
  /**
   * 401 responses. Non-zero means credentials are not reaching every request, which is a bug in
   * the crawler rather than a property of the site.
   */
  unauthorized: ManifestEntry[];
  /**
   * 403 responses. Kept apart from 401 because a refusal is not necessarily an auth problem — this
   * site returns one for a geo-restricted page — so these need reading rather than fixing.
   */
  forbidden: ManifestEntry[];
  /** How many URLs each discovery mechanism was the first to reveal. */
  byDiscoveryMethod: Record<string, number>;
  /** Candidate URLs turned away, by reason. */
  rejections: Record<string, number>;
  /** Pages the browser could not load. Each one is a page whose links went undiscovered. */
  renderFailures: Array<{ url: string; error: string }>;
  /**
   * True when the run stopped on `maxPages` rather than because the frontier emptied. The crawl is
   * only complete when this is false — a capped run says nothing about what was left unvisited.
   */
  stoppedAtLimit: boolean;
  /** URLs still queued when the run ended. Should be zero for a complete crawl. */
  leftUnvisited: number;
  entries: ManifestEntry[];
}

/**
 * Fetches one URL and archives every response in its redirect chain, recording each in the
 * manifest and returning the rows created.
 *
 * Kept separate from the crawl loop so the fetch-and-store path stays identical however a URL was
 * found, and so the bytes on disk are always the plain HTTP download rather than the browser's
 * rendered interpretation.
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
 * Crawls the whole site breadth-first and archives every response, returning what it did.
 *
 * Each URL is downloaded over plain HTTP for the archive; only those the server labels as HTML are
 * then opened in the browser, whose job is purely to reveal more URLs. The run ends when the
 * frontier empties, which by construction means no reachable URL was left unfetched.
 */
export async function runCrawl(config: Config): Promise<CrawlSummary> {
  await mkdir(config.archiveDir, { recursive: true });

  const context: CrawlContext = { config, manifest: await loadManifest(config.manifestPath) };
  const frontier = new UrlFrontier(config.baseUrl, {
    paginationSample: config.limits.paginationSample,
  });
  const byDiscoveryMethod: Record<string, number> = {};
  const entries: ManifestEntry[] = [];
  const renderFailures: Array<{ url: string; error: string }> = [];

  frontier.add(config.baseUrl.toString(), { discoveryMethod: 'seed', discoveredFromUrl: null });
  countMethod(byDiscoveryMethod, 'seed');

  const browser = await launchBrowser();
  let pagesRendered = 0;

  let stoppedAtLimit = false;

  try {
    let queued: ReturnType<UrlFrontier['next']>;
    while ((queued = frontier.next()) !== null) {
      if (entries.length >= config.limits.maxPages) {
        stoppedAtLimit = true;
        break;
      }

      const archived = await fetchAndArchive(context, queued.url, queued.provenance);
      entries.push(...archived);

      const final = archived[archived.length - 1];
      if (!final) continue;
      // A redirect destination has now been fetched as part of this chain, so it must not be
      // queued again in its own right.
      if (final.url !== queued.url) frontier.markSeen(final.url);

      if (isHtml(final.contentType) && final.status < 400) {
        pagesRendered += 1;
        const rendered = await renderAndDiscover(browser, config, final.url);
        if (rendered.error) renderFailures.push({ url: final.url, error: rendered.error });

        for (const candidate of rendered.urls) {
          const accepted = frontier.add(candidate.url, {
            discoveryMethod: candidate.discoveryMethod,
            discoveredFromUrl: final.url,
          });
          if (accepted) countMethod(byDiscoveryMethod, candidate.discoveryMethod);
        }
      }

      if (config.limits.requestDelayMs > 0) await delay(config.limits.requestDelayMs);
    }
  } finally {
    await browser.close();
  }

  await saveManifest(config.manifestPath, context.manifest);

  return {
    urlsRequested: frontier.seenCount - frontier.pendingCount,
    responsesArchived: entries.length,
    bytesArchived: entries.reduce((total, entry) => total + entry.byteLength, 0),
    pagesRendered,
    unauthorized: entries.filter((entry) => entry.status === 401),
    forbidden: entries.filter((entry) => entry.status === 403),
    byDiscoveryMethod,
    rejections: frontier.rejections,
    renderFailures,
    stoppedAtLimit,
    leftUnvisited: frontier.pendingCount,
    entries,
  };
}

/** The outcome of rendering one page: what it revealed, or why it could not be rendered. */
interface RenderResult {
  urls: DiscoveredUrl[];
  error: string | null;
}

/**
 * Loads one page in the browser and returns every URL it reveals.
 *
 * A render failure does not stop the crawl — the page is archived either way — but it is returned
 * rather than swallowed, because a browser that cannot load anything looks exactly like a site with
 * nothing to find. Reporting the reason is what tells those two apart.
 */
async function renderAndDiscover(
  browser: Browser,
  config: Config,
  url: string,
): Promise<RenderResult> {
  let page: Page | null = null;
  try {
    page = await openAuthenticatedPage(browser, config);
    const recorder = startNetworkRecorder(page);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: config.limits.requestTimeoutMs });
    return { urls: await discoverUrls(page, recorder), error: null };
  } catch (error) {
    return { urls: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    await page?.close().catch(() => {});
  }
}

function isHtml(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes('html') ?? false;
}

function countMethod(tally: Record<string, number>, method: DiscoveryMethod): void {
  tally[method] = (tally[method] ?? 0) + 1;
}
