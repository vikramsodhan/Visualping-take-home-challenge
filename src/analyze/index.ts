import { resolve } from 'node:path';
import type { Config } from '../config.ts';
import { loadManifest, type ManifestEntry } from '../archive/manifest.ts';
import { readArtifact, type CaptureMethod, type DiscoveryMethod } from '../archive/store.ts';
import { findClaim, type SiteClaim } from './claims.ts';
import { findNearMisses, findPasswords, type NearMiss, type NearMissKind } from './scan.ts';
import { expandViews } from './views.ts';

/**
 * One password, found in one place, with everything needed to judge it: where it came from, what
 * kind of resource it was in, how it had to be decoded, and the text around it.
 */
export interface Finding {
  password: string;
  url: string;
  status: number;
  contentType: string | null;
  captureMethod: CaptureMethod;
  discoveryMethod: DiscoveryMethod;
  discoveredFromUrl: string | null;
  /** Transformations applied to the response before the password was visible. */
  decodeChain: string[];
  offset: number;
  context: string;
  archivePath: string;
  /** The site's claim that this is not one of the eight, if it made one. Never applied silently. */
  disputedBy: SiteClaim | null;
}

/** A response mentioning the brand without yielding a well-formed password. */
export interface NearMissReport {
  kind: NearMissKind;
  matched: string;
  url: string;
  contentType: string | null;
  decodeChain: string[];
  offset: number;
  context: string;
  archivePath: string;
}

/** Everything one analysis pass learned from the archive. */
export interface AnalysisResult {
  findings: Finding[];
  /** Distinct password values, in the order first seen, disputed ones included. */
  passwords: string[];
  /** Distinct passwords the site has not disowned. This is what counts against the target of 8. */
  confirmedPasswords: string[];
  /** Distinct passwords the site claims are not part of the eight, kept visible for review. */
  disputedPasswords: string[];
  nearMisses: NearMissReport[];
  artifactsScanned: number;
  viewsScanned: number;
  bytesScanned: number;
  /** How many archived responses of each content type were searched. */
  byContentType: Record<string, number>;
}

/**
 * Searches every archived response for passwords, entirely offline.
 *
 * The manifest drives the walk rather than a directory glob, so the analysis covers exactly what
 * the crawl claims to have fetched — if those ever disagree, that is a bug worth surfacing rather
 * than papering over.
 */
export async function runAnalysis(config: Config): Promise<AnalysisResult> {
  const manifest = await loadManifest(config.manifestPath);
  const entries = Object.values(manifest.entries);
  if (entries.length === 0) {
    throw new Error('Nothing archived yet. Run `npm run crawl` first.');
  }

  const findings: Finding[] = [];
  const nearMisses: NearMissReport[] = [];
  const byContentType: Record<string, number> = {};
  let viewsScanned = 0;
  let bytesScanned = 0;

  for (const entry of entries) {
    const { meta, body } = await readArtifact(resolve(config.outDir, entry.metaRelativePath));
    bytesScanned += body.byteLength;

    const type = entry.contentType?.split(';')[0]?.trim() ?? 'unknown';
    byContentType[type] = (byContentType[type] ?? 0) + 1;

    for (const view of expandViews(meta, body)) {
      viewsScanned += 1;

      for (const match of findPasswords(view.text)) {
        findings.push(toFinding(entry, view.chain, match.password, match.offset, match.context));
      }
      for (const miss of findNearMisses(view.text)) {
        nearMisses.push(toNearMiss(entry, view.chain, miss));
      }
    }
  }

  const passwords = [...new Set(findings.map((finding) => finding.password))];

  return {
    findings,
    passwords,
    confirmedPasswords: passwords.filter((password) => !findClaim(password)),
    disputedPasswords: passwords.filter((password) => findClaim(password) !== null),
    nearMisses,
    artifactsScanned: entries.length,
    viewsScanned,
    bytesScanned,
    byContentType,
  };
}

function toFinding(
  entry: ManifestEntry,
  decodeChain: string[],
  password: string,
  offset: number,
  context: string,
): Finding {
  return {
    password,
    url: entry.url,
    status: entry.status,
    contentType: entry.contentType,
    captureMethod: entry.captureMethod,
    discoveryMethod: entry.discoveryMethod,
    discoveredFromUrl: entry.discoveredFromUrl,
    decodeChain,
    offset,
    context,
    archivePath: entry.bodyRelativePath,
    disputedBy: findClaim(password),
  };
}

function toNearMiss(
  entry: ManifestEntry,
  decodeChain: string[],
  miss: NearMiss,
): NearMissReport {
  return {
    kind: miss.kind,
    matched: miss.matched,
    url: entry.url,
    contentType: entry.contentType,
    decodeChain,
    offset: miss.offset,
    context: miss.context,
    archivePath: entry.bodyRelativePath,
  };
}
