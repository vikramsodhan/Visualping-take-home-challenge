import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { GEO_GATED, loadGeoGatedFinding, unresolvedGeoGated } from '../src/analyze/geoGated.ts';

const ENV = {
  BASE_URL: 'http://site.test/',
  BASIC_AUTH_USER: 'u',
  BASIC_AUTH_PASS: 'p',
};

test('the documented default carries the roadblock but no value', () => {
  const finding = unresolvedGeoGated();
  assert.equal(finding.resolved, false);
  assert.equal(finding.password, null);
  assert.match(finding.obstacle, /403/);
  assert.match(finding.resolution, /German egress/i);
});

test('reads the password from the saved page when it is present', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'geo-'));
  await writeFile(
    join(outDir, GEO_GATED.savedPageFile),
    '<p>password:</p><code>VISUALPING{00abcdef11223344}</code>',
  );

  const config = loadConfig({ ...ENV, OUT_DIR: outDir });
  const finding = await loadGeoGatedFinding(config);

  assert.equal(finding.resolved, true);
  assert.equal(finding.password, 'VISUALPING{00abcdef11223344}');
  assert.equal(finding.url, 'http://site.test/status/eu-region/');
  assert.ok(finding.context?.includes('VISUALPING{00abcdef11223344}'));
});

test('stays unresolved, but still documented, when the saved page is absent', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'geo-'));
  const config = loadConfig({ ...ENV, OUT_DIR: outDir });
  const finding = await loadGeoGatedFinding(config);

  assert.equal(finding.resolved, false);
  assert.equal(finding.password, null);
  assert.match(finding.obstacle, /403/);
});
