import { relative, resolve } from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { runCrawl } from './crawl/index.ts';
import { runAnalysis } from './analyze/index.ts';
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

  process.stdout.write(
    `Searched ${result.artifactsScanned} archived response(s), ${result.viewsScanned} view(s).\n\n`,
  );
  process.stdout.write(
    `Found ${result.confirmedPasswords.length} of ${EXPECTED_PASSWORD_COUNT} passwords.\n\n`,
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

async function crawlCommand(config: Config): Promise<number> {
  const summary = await runCrawl(config);
  const displayPath = (path: string) => relative(process.cwd(), resolve(config.outDir, path));

  process.stdout.write(
    `Crawled ${summary.urlsRequested} URL(s), archived ${summary.responsesArchived} response(s), ` +
      `${summary.bytesArchived} bytes.\n\n`,
  );
  for (const entry of summary.entries) {
    const type = entry.contentType?.split(';')[0] ?? 'unknown';
    process.stdout.write(`  ${entry.status} ${entry.url}\n`);
    process.stdout.write(
      `      ${type}, ${entry.byteLength} bytes -> ${displayPath(entry.bodyRelativePath)}\n`,
    );
  }

  process.stdout.write(`\nManifest: ${relative(process.cwd(), config.manifestPath)}\n`);
  if (summary.authFailures > 0) {
    process.stdout.write(
      `\nWarning: ${summary.authFailures} response(s) came back 401/403. ` +
        'Credentials are not reaching every request.\n',
    );
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // Config and network problems are expected failure modes; a stack trace helps nobody here.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
