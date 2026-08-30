import { relative, resolve } from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { runCrawl } from './crawl/index.ts';
import { runAnalysis, type AnalysisResult } from './analyze/index.ts';
import { writeReport } from './analyze/report.ts';
import { EXPECTED_PASSWORD_COUNT } from './analyze/scan.ts';

const COMMANDS = ['crawl', 'analyze', 'verify'] as const;
type CommandName = (typeof COMMANDS)[number];

const USAGE = `Usage: npm run <command>

  crawl     Fetch the site and archive every response byte-for-byte
  analyze   Search the archived responses for passwords (offline, no requests)
  verify    Re-crawl and prove nothing new was found
`;

function parseCommand(argv: string[]): CommandName | null {
  const candidate = argv[2];
  return COMMANDS.find((name) => name === candidate) ?? null;
}

async function main(): Promise<number> {
  const command = parseCommand(process.argv);
  if (!command) {
    process.stderr.write(`${process.argv[2] ? `Unknown command: ${process.argv[2]}\n\n` : ''}${USAGE}`);
    return 1;
  }

  const config = loadConfig();

  switch (command) {
    case 'crawl':
      return await crawlCommand(config);
    case 'analyze':
      return await analyzeCommand(config);
    case 'verify':
      process.stdout.write(`"${command}" is not wired up yet — it arrives in a later step.\n`);
      return 0;
  }
}

async function analyzeCommand(config: Config): Promise<number> {
  const result = await runAnalysis(config);
  const { reportPath } = await writeReport(config, result);

  const automated = result.confirmedPasswords.length;
  const outOfBandFound = result.outOfBand.resolved && result.outOfBand.password ? 1 : 0;

  process.stdout.write(
    `Searched ${result.artifactsScanned} archived response(s), ${result.viewsScanned} view(s).\n\n`,
  );
  process.stdout.write(
    `Found ${automated + outOfBandFound} of ${EXPECTED_PASSWORD_COUNT} passwords ` +
      `(${automated} by automated analysis` +
      `${outOfBandFound ? ', 1 via German egress' : ''}).\n\n`,
  );

  for (const password of result.passwords) {
    const disputed = result.disputedPasswords.includes(password) ? '  [DISPUTED by the site]' : '';
    process.stdout.write(`  ${password}${disputed}\n`);
    for (const finding of result.findings.filter((item) => item.password === password)) {
      process.stdout.write(
        `      ${finding.url}\n` +
          `      ${finding.contentType ?? 'unknown'} · ${finding.decodeChain.join(' -> ')} · offset ${finding.offset}\n`,
      );
    }
  }

  writeOutOfBand(result);

  const malformed = result.nearMisses.filter((miss) => miss.kind === 'malformed-password');
  const mentions = result.nearMisses.length - malformed.length;

  if (malformed.length > 0) {
    process.stdout.write(
      `\n${malformed.length} near-miss(es): password-shaped text the pattern rejected.\n` +
        'Something is still encoded — see the report for where.\n',
    );
  }
  process.stdout.write(`\n${mentions} bare brand mention(s) ignored as prose.\n`);

  process.stdout.write(`\nReport: ${relative(process.cwd(), reportPath)}\n`);
  return 0;
}

/**
 * Prints the geo-gated password and the roadblock behind it. Shown whether or not the value has
 * been recovered locally, because the obstacle and its solution are part of the result.
 */
function writeOutOfBand(result: AnalysisResult): void {
  const finding = result.outOfBand;
  process.stdout.write(`\n${finding.resolved && finding.password ? finding.password : '(not recovered here)'}`);
  process.stdout.write(`  [geo-gated to ${finding.region}, reached via German egress]\n`);
  process.stdout.write(`      ${finding.url}\n`);
  process.stdout.write(`      403 to non-German clients; fetched through a German exit — see the report.\n`);
}

async function crawlCommand(config: Config): Promise<number> {
  const summary = await runCrawl(config);

  process.stdout.write(
    `Crawled ${summary.urlsRequested} URL(s), archived ${summary.responsesArchived} response(s), ` +
      `${summary.bytesArchived.toLocaleString('en-US')} bytes.\n` +
      `Rendered ${summary.pagesRendered} HTML page(s) in the browser.\n\n`,
  );

  process.stdout.write('Discovered by:\n');
  for (const [method, count] of sortedEntries(summary.byDiscoveryMethod)) {
    process.stdout.write(`  ${count.toString().padStart(4)}  ${method}\n`);
  }

  process.stdout.write('\nCandidates not queued:\n');
  for (const [reason, count] of sortedEntries(summary.rejections)) {
    process.stdout.write(`  ${count.toString().padStart(4)}  ${reason}\n`);
  }

  if (summary.stoppedAtLimit) {
    process.stdout.write(
      `\nINCOMPLETE: stopped at the ${config.limits.maxPages}-response cap with ` +
        `${summary.leftUnvisited} URL(s) still queued. Raise MAX_PAGES and re-run — this crawl ` +
        'proves nothing about what was left unvisited.\n',
    );
  } else {
    process.stdout.write('\nFrontier emptied: every reachable URL was fetched.\n');
  }

  if (summary.renderFailures.length > 0) {
    process.stdout.write(
      `\nWarning: ${summary.renderFailures.length} page(s) failed to render, so their links were never seen:\n`,
    );
    for (const failure of summary.renderFailures) {
      process.stdout.write(`  ${failure.url}\n      ${failure.error}\n`);
    }
  }

  const problems = summary.entries.filter((entry) => entry.status >= 400);
  if (problems.length > 0) {
    process.stdout.write(`\n${problems.length} response(s) with an error status:\n`);
    for (const entry of problems) {
      process.stdout.write(`  ${entry.status} ${entry.url}\n`);
    }
  }

  if (summary.unauthorized.length > 0) {
    process.stdout.write(
      `\nBUG: ${summary.unauthorized.length} response(s) came back 401. ` +
        'Credentials are not reaching every request:\n',
    );
    for (const entry of summary.unauthorized) process.stdout.write(`  ${entry.url}\n`);
  }

  if (summary.forbidden.length > 0) {
    process.stdout.write(
      `\n${summary.forbidden.length} response(s) came back 403. Not necessarily an auth problem — ` +
        'read the archived body to see why access was refused:\n',
    );
    for (const entry of summary.forbidden) process.stdout.write(`  ${entry.url}\n`);
  }

  process.stdout.write(`\nManifest: ${relative(process.cwd(), config.manifestPath)}\n`);
  return 0;
}

function sortedEntries(tally: Record<string, number>): Array<[string, number]> {
  return Object.entries(tally).sort(([, a], [, b]) => b - a);
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // Config and network problems are expected failure modes; a stack trace helps nobody here.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
