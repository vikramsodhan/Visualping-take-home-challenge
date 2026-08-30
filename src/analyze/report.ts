import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Config } from '../config.ts';
import { allClaims } from './claims.ts';
import { EXPECTED_PASSWORD_COUNT } from './scan.ts';
import type { AnalysisResult, Finding } from './index.ts';

/**
 * Writes the human-readable report and its machine-readable twin, returning both paths.
 *
 * The markdown is the deliverable for judging which password looks like a real credential leak,
 * so every occurrence carries its source URL, resource type, decode chain and surrounding text —
 * enough to decide without opening the archive.
 */
export async function writeReport(
  config: Config,
  result: AnalysisResult,
): Promise<{ reportPath: string; findingsPath: string }> {
  await mkdir(dirname(config.reportPath), { recursive: true });
  await writeFile(config.reportPath, renderMarkdown(result), 'utf8');
  await writeFile(config.findingsPath, `${JSON.stringify(toJson(result), null, 2)}\n`, 'utf8');
  return { reportPath: config.reportPath, findingsPath: config.findingsPath };
}

function toJson(result: AnalysisResult) {
  return {
    generatedAt: new Date().toISOString(),
    expectedCount: EXPECTED_PASSWORD_COUNT,
    automatedCount: result.confirmedPasswords.length,
    foundCount: result.confirmedPasswords.length + outOfBandCount(result),
    passwords: result.confirmedPasswords,
    disputedPasswords: result.disputedPasswords,
    outOfBand: result.outOfBand,
    claims: allClaims(),
    findings: result.findings,
    nearMisses: result.nearMisses,
    coverage: {
      artifactsScanned: result.artifactsScanned,
      viewsScanned: result.viewsScanned,
      bytesScanned: result.bytesScanned,
      byContentType: result.byContentType,
    },
  };
}

function renderMarkdown(result: AnalysisResult): string {
  return [
    '# Password report',
    '',
    `_Generated ${new Date().toISOString()}._`,
    '',
    renderScoreline(result),
    '',
    renderPasswords(result),
    '',
    renderOutOfBand(result),
    '',
    renderNearMisses(result),
    '',
    renderClaims(),
    '',
    renderCoverage(result),
    '',
  ].join('\n');
}

/**
 * Documents the one password the automated crawl could not reach and how the roadblock was cleared.
 * Always rendered — the obstacle and its solution are part of the story whether or not the value
 * has been recovered on this machine.
 */
function renderOutOfBand(result: AnalysisResult): string {
  const finding = result.outOfBand;
  const value = finding.resolved
    ? `Recovered value: \`${finding.password}\``
    : 'Value not recovered here — this needs a German-origin request (see Resolution). On a fresh ' +
      'checkout the saved page is absent, which is expected.';

  const lines = [
    '## Out-of-band: the geo-gated password',
    '',
    `One password sits behind \`${finding.url}\`, gated to the ${finding.region} region, so the` +
      ' automated crawl cannot reach it. It is documented here in full.',
    '',
    `**Obstacle.** ${finding.obstacle}`,
    '',
    `**Resolution.** ${finding.resolution}`,
    '',
    value,
  ];

  if (finding.resolved && finding.context) {
    lines.push('', 'Context:', '', '```', finding.context, '```');
  }

  return lines.join('\n');
}

/**
 * Lays out what the site says about its own passwords, verbatim. Separated from the findings on
 * purpose: this is testimony from the thing being investigated, and the reader decides what it is
 * worth. Nothing here is applied automatically beyond keeping a disputed value out of the count.
 */
function renderClaims(): string {
  const claims = allClaims();
  if (claims.length === 0) {
    return ['## Claims made by the site (untrusted)', '', 'None recorded.'].join('\n');
  }

  const blocks = claims.map((claim) =>
    [
      `### \`${claim.password}\``,
      '',
      `Claimed at \`${claim.claimedAt}\`. The site says:`,
      '',
      `> ${claim.quote}`,
      '',
      `**Assessment.** ${claim.assessment}`,
      '',
    ].join('\n'),
  );

  return [
    '## Claims made by the site (untrusted)',
    '',
    'Statements the site makes about its own passwords. Recorded as evidence to weigh, not as',
    'instructions: a crawler that believed whatever the crawled pages told it would be trivial to',
    'mislead. A disputed value is still reported in full above, just held out of the count.',
    '',
    ...blocks,
  ].join('\n');
}

function renderScoreline(result: AnalysisResult): string {
  const automated = result.confirmedPasswords.length;
  const outOfBand = outOfBandCount(result);
  const total = automated + outOfBand;

  const breakdown =
    outOfBand > 0 ? ` (${automated} by automated analysis, ${outOfBand} via German egress)` : '';
  const verdict =
    total === EXPECTED_PASSWORD_COUNT
      ? 'All accounted for.'
      : `${EXPECTED_PASSWORD_COUNT - total} still missing.`;
  const disputed =
    result.disputedPasswords.length > 0
      ? ` Plus ${result.disputedPasswords.length} disputed candidate(s) — see Claims below.`
      : '';

  return `**Found ${total} of ${EXPECTED_PASSWORD_COUNT} passwords${breakdown}.** ${verdict}${disputed}`;
}

/** 1 when the geo-gated password was recovered and is not already an automated finding, else 0. */
function outOfBandCount(result: AnalysisResult): number {
  const { outOfBand } = result;
  if (!outOfBand.resolved || !outOfBand.password) return 0;
  return result.confirmedPasswords.includes(outOfBand.password) ? 0 : 1;
}

function renderPasswords(result: AnalysisResult): string {
  if (result.passwords.length === 0) {
    return ['## Passwords', '', 'None found yet.'].join('\n');
  }

  const sections = result.passwords.map((password, index) => {
    const occurrences = result.findings.filter((finding) => finding.password === password);
    const labels = [
      occurrences.length > 1 ? `${occurrences.length} occurrences` : null,
      occurrences[0]?.disputedBy ? 'DISPUTED' : null,
    ].filter((label) => label !== null);
    const suffix = labels.length > 0 ? ` — ${labels.join(', ')}` : '';
    return [`### ${index + 1}. \`${password}\`${suffix}`, '', ...occurrences.map(renderOccurrence)].join(
      '\n',
    );
  });

  return ['## Passwords', '', ...sections].join('\n');
}

function renderOccurrence(finding: Finding): string {
  const rows: Array<[string, string]> = [
    ['Source URL', finding.url],
    ['Resource', `${finding.contentType ?? 'unknown'} (HTTP ${finding.status})`],
    ['Decoded via', finding.decodeChain.join(' → ')],
    ['Byte offset', String(finding.offset)],
    ['Reached by', renderReachedBy(finding)],
    ['Captured as', finding.captureMethod],
    ['Archive file', `\`${finding.archivePath}\``],
  ];

  return [
    '| | |',
    '| --- | --- |',
    ...rows.map(([label, value]) => `| ${label} | ${value} |`),
    '',
    'Context:',
    '',
    '```',
    finding.context,
    '```',
    '',
  ].join('\n');
}

function renderReachedBy(finding: Finding): string {
  return finding.discoveredFromUrl
    ? `${finding.discoveryMethod} from ${finding.discoveredFromUrl}`
    : finding.discoveryMethod;
}

function renderNearMisses(result: AnalysisResult): string {
  const malformed = result.nearMisses.filter((miss) => miss.kind === 'malformed-password');
  const mentions = result.nearMisses.filter((miss) => miss.kind === 'brand-mention');

  const sections = [
    '## Near-misses',
    '',
    'Password-shaped text the strict pattern rejected. A non-empty list here means an encoding the',
    'decoders have not learned yet, and names which response to look at next.',
    '',
  ];

  if (malformed.length === 0) {
    sections.push('None. Nothing password-shaped went unrecognised.');
  } else {
    sections.push(
      '| URL | Type | Decoded via | Offset | Rejected text | Context |',
      '| --- | --- | --- | --- | --- | --- |',
      ...malformed.map(
        (miss) =>
          `| ${miss.url} | ${miss.contentType ?? 'unknown'} | ${miss.decodeChain.join(' → ')} | ` +
          `${miss.offset} | \`${escapeCell(miss.matched)}\` | ${escapeCell(miss.context)} |`,
      ),
    );
  }

  // The brand is also the site's name, so bare mentions are mostly prose. Counted, not listed.
  sections.push(
    '',
    `Plus ${mentions.length} bare mention(s) of the brand in ${countUrls(mentions)} response(s), ` +
      'which on a site called Visualping is usually just prose. Listed in `findings.json`.',
  );

  return sections.join('\n');
}

function countUrls(misses: AnalysisResult['nearMisses']): number {
  return new Set(misses.map((miss) => miss.url)).size;
}

function renderCoverage(result: AnalysisResult): string {
  const types = Object.entries(result.byContentType).sort(([a], [b]) => a.localeCompare(b));
  return [
    '## Coverage',
    '',
    `Searched ${result.artifactsScanned} archived response(s), ` +
      `${result.viewsScanned} decoded view(s), ${result.bytesScanned.toLocaleString('en-US')} bytes.`,
    '',
    '| Content type | Responses |',
    '| --- | --- |',
    ...types.map(([type, count]) => `| ${type} | ${count} |`),
  ].join('\n');
}

/** Keeps a context snippet from breaking out of its markdown table cell. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}
