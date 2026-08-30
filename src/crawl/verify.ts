import { resolve } from 'node:path';
import type { Config } from '../config.ts';
import {
  diffManifests,
  loadManifest,
  type ManifestDiff,
} from '../archive/manifest.ts';
import { runCrawl, type CrawlSummary } from './index.ts';

/** The completeness proof: a fresh independent crawl, and how it compared to the baseline. */
export interface VerifyReport {
  crawl: CrawlSummary;
  diff: ManifestDiff;
  /** True when the re-crawl reached no new URL and dropped none — the crawl reproduces exactly. */
  complete: boolean;
}

/**
 * Points a copy of the config at a separate `out/verify/` tree, so a verification crawl can run
 * without overwriting the archive it is being checked against.
 */
function toVerifyConfig(config: Config): Config {
  const verifyDir = resolve(config.outDir, 'verify');
  return {
    ...config,
    outDir: verifyDir,
    archiveDir: resolve(verifyDir, 'archive'),
    manifestPath: resolve(verifyDir, 'manifest.json'),
  };
}

/**
 * Proves the crawl is complete by running a second, fully independent crawl and diffing it against
 * the baseline manifest.
 *
 * The claim that survives is the strong one: an independent traversal from the same seed reaches
 * the same set of URLs. `newKeys` and `missing` must both be empty for that to hold — those are the
 * pass/fail signal. Changed content hashes are reported but do not fail the check, since a few pages
 * on the site are generated on demand and may legitimately differ between two fetches.
 */
export async function runVerify(config: Config): Promise<VerifyReport> {
  const baseline = await loadManifest(config.manifestPath);
  if (Object.keys(baseline.entries).length === 0) {
    throw new Error('No baseline to verify against. Run `npm run crawl` first.');
  }

  const verifyConfig = toVerifyConfig(config);
  const crawl = await runCrawl(verifyConfig);
  const fresh = await loadManifest(verifyConfig.manifestPath);

  const diff = diffManifests(baseline, fresh);
  const complete = diff.newKeys.length === 0 && diff.missing.length === 0;

  return { crawl, diff, complete };
}
