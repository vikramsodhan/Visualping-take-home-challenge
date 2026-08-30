import { resolve } from 'node:path';
import type { Config } from '../config.ts';
import { loadManifest } from '../archive/manifest.ts';
import {
  readArtifact,
  type ArtifactMeta,
  type CaptureMethod,
  type DiscoveryMethod,
} from '../archive/store.ts';
import { findClaim, type SiteClaim } from './claims.ts';
import { loadGeoGatedFinding, unresolvedGeoGated, type OutOfBandFinding } from './geoGated.ts';
import { normalizeOcrHex, ocrImages } from './ocr.ts';
import { findNearMisses, findPasswords, type NearMiss, type NearMissKind } from './scan.ts';
import { expandViews, viewText } from './views.ts';
import type { View } from './extractors/types.ts';

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
  /**
   * The geo-gated password the automated crawl cannot reach, recovered out of band. Always present
   * so its roadblock is documented; `resolved` says whether the value was actually recovered.
   */
  outOfBand: OutOfBandFinding;
  nearMisses: NearMissReport[];
  artifactsScanned: number;
  viewsScanned: number;
  bytesScanned: number;
  /** How many archived responses of each content type were searched. */
  byContentType: Record<string, number>;
}

/** One archived response ready to scan: its metadata, its bytes, and any text OCR read from it. */
export interface ArtifactInput {
  meta: ArtifactMeta;
  body: Buffer;
  /** Text recognised from an image's pixels, when this artifact is an image. */
  ocrText?: string;
}

/**
 * Searches archived responses for passwords, entirely offline.
 *
 * The manifest drives the walk rather than a directory glob, so the analysis covers exactly what
 * the crawl claims to have fetched — if those ever disagree, that is a bug worth surfacing rather
 * than papering over. The scanning itself is delegated to {@link scanArtifacts}, which touches no
 * filesystem and so can be tested directly on in-memory inputs.
 */
export async function runAnalysis(config: Config): Promise<AnalysisResult> {
  const manifest = await loadManifest(config.manifestPath);
  const entries = Object.values(manifest.entries);
  if (entries.length === 0) {
    throw new Error('Nothing archived yet. Run `npm run crawl` first.');
  }

  const inputs: ArtifactInput[] = [];
  for (const entry of entries) {
    inputs.push(await readArtifact(resolve(config.outDir, entry.metaRelativePath)));
  }

  const ocrByHash = await ocrImages(
    inputs.map((input) => ({ contentType: input.meta.contentType, body: input.body })),
    resolve(config.outDir, 'ocr-cache.json'),
  );
  for (const input of inputs) {
    const ocr = ocrByHash.get(input.meta.sha256);
    if (ocr?.text.trim()) input.ocrText = ocr.text;
  }

  return scanArtifacts(inputs, await loadGeoGatedFinding(config));
}

/**
 * The pure core of the analysis: expand each response into its decoded views, scan every view, then
 * dedupe so one occurrence is reported once via its most direct decode route. Separated from
 * {@link runAnalysis} so the logic that actually finds passwords needs no archive on disk.
 */
export function scanArtifacts(
  inputs: ArtifactInput[],
  outOfBand: OutOfBandFinding = unresolvedGeoGated(),
): AnalysisResult {
  const findings: Finding[] = [];
  const nearMisses: NearMissReport[] = [];
  const byContentType: Record<string, number> = {};
  let viewsScanned = 0;
  let bytesScanned = 0;

  for (const { meta, body, ocrText } of inputs) {
    bytesScanned += body.byteLength;

    const type = meta.contentType?.split(';')[0]?.trim() ?? 'unknown';
    byContentType[type] = (byContentType[type] ?? 0) + 1;

    for (const view of expandViews(meta, body, ocrSeeds(ocrText))) {
      viewsScanned += 1;
      const text = viewText(view);

      for (const match of findPasswords(text)) {
        findings.push(toFinding(meta, view.chain, match.password, match.offset, match.context));
      }
      for (const miss of findNearMisses(text)) {
        nearMisses.push(toNearMiss(meta, view.chain, miss));
      }
    }
  }

  const deduped = dedupeFindings(findings);
  const passwords = [...new Set(deduped.map((finding) => finding.password))];

  return {
    findings: deduped,
    passwords,
    confirmedPasswords: passwords.filter((password) => !findClaim(password)),
    disputedPasswords: passwords.filter((password) => findClaim(password) !== null),
    outOfBand,
    nearMisses: dedupeNearMisses(nearMisses),
    artifactsScanned: inputs.length,
    viewsScanned,
    bytesScanned,
    byContentType,
  };
}

/**
 * Collapses a password found several times in one response to a single entry via its most direct
 * decode route.
 *
 * The recursive expansion re-finds a password whenever a decoder that did not touch its bytes still
 * produces a child view — the same leak surfaces via `response body` and again via
 * `response body → html-entities`, say. Keying on url + password (rather than offset or context,
 * which shift when a length-changing decode edits bytes near the match) makes the collapse robust,
 * and the shortest chain wins because it is the truest account of how the password was stored. A
 * password in two different responses keeps both, since their URLs differ.
 */
function dedupeFindings(findings: Finding[]): Finding[] {
  return keepShortestChain(findings, (finding) => `${finding.url}\n${finding.password}`);
}

/** As {@link dedupeFindings}, for near-misses, keyed on the response, kind, and matched text. */
function dedupeNearMisses(nearMisses: NearMissReport[]): NearMissReport[] {
  return keepShortestChain(nearMisses, (miss) => `${miss.url}\n${miss.kind}\n${miss.matched}`);
}

/** Keeps, per key, the item whose `decodeChain` is shortest — the most direct explanation. */
function keepShortestChain<T extends { decodeChain: string[] }>(
  items: T[],
  keyOf: (item: T) => string,
): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    const existing = best.get(key);
    if (!existing || item.decodeChain.length < existing.decodeChain.length) {
      best.set(key, item);
    }
  }
  return [...best.values()];
}

/**
 * Turns an image's OCR text into seed views: the raw recognition, and — when the OCR misread a
 * password's hex as digit-shaped letters — a hex-normalized copy that recovers the exact value.
 * The raw view is kept so a genuine misread still surfaces as a near-miss rather than vanishing.
 */
function ocrSeeds(ocrText: string | undefined): View[] {
  if (!ocrText?.trim()) return [];

  const seeds: View[] = [{ bytes: Buffer.from(ocrText, 'utf8'), chain: ['image pixels (OCR)'] }];
  const normalized = normalizeOcrHex(ocrText);
  if (normalized !== ocrText) {
    seeds.push({
      bytes: Buffer.from(normalized, 'utf8'),
      chain: ['image pixels (OCR)', 'ocr hex-normalized'],
    });
  }
  return seeds;
}

/** Reconstructs an artifact's path within the archive from its recorded filename. */
function archivePathOf(meta: ArtifactMeta): string {
  return `archive/${meta.bodyFileName}`;
}

function toFinding(
  meta: ArtifactMeta,
  decodeChain: string[],
  password: string,
  offset: number,
  context: string,
): Finding {
  return {
    password,
    url: meta.url,
    status: meta.status,
    contentType: meta.contentType,
    captureMethod: meta.captureMethod,
    discoveryMethod: meta.discoveryMethod,
    discoveredFromUrl: meta.discoveredFromUrl,
    decodeChain,
    offset,
    context,
    archivePath: archivePathOf(meta),
    disputedBy: findClaim(password),
  };
}

function toNearMiss(meta: ArtifactMeta, decodeChain: string[], miss: NearMiss): NearMissReport {
  return {
    kind: miss.kind,
    matched: miss.matched,
    url: meta.url,
    contentType: meta.contentType,
    decodeChain,
    offset: miss.offset,
    context: miss.context,
    archivePath: archivePathOf(meta),
  };
}
