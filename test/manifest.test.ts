import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffManifests, emptyManifest, type Manifest } from '../src/archive/manifest.ts';

function manifestOf(rows: Array<[string, string]>): Manifest {
  const manifest = emptyManifest();
  for (const [url, sha256] of rows) {
    manifest.entries[`raw-fetch ${url}`] = {
      url,
      captureMethod: 'raw-fetch',
      status: 200,
      contentType: 'text/html',
      byteLength: 1,
      sha256,
      discoveryMethod: 'seed',
      discoveredFromUrl: null,
      redirectedTo: null,
      fetchedAt: '',
      bodyRelativePath: 'x',
      metaRelativePath: 'x',
    };
  }
  return manifest;
}

test('an identical re-crawl reports no differences', () => {
  const rows: Array<[string, string]> = [
    ['http://s/', 'aaa'],
    ['http://s/a', 'bbb'],
  ];
  const diff = diffManifests(manifestOf(rows), manifestOf(rows));
  assert.deepEqual(diff.newKeys, []);
  assert.deepEqual(diff.missing, []);
  assert.deepEqual(diff.changed, []);
  assert.equal(diff.unchanged, 2);
});

test('a URL the re-crawl reached but the baseline did not is flagged new', () => {
  const baseline = manifestOf([['http://s/', 'aaa']]);
  const fresh = manifestOf([
    ['http://s/', 'aaa'],
    ['http://s/found-later', 'ccc'],
  ]);
  const diff = diffManifests(baseline, fresh);
  assert.deepEqual(diff.newKeys, ['raw-fetch http://s/found-later']);
  assert.equal(diff.unchanged, 1);
});

test('a URL the re-crawl failed to reach is flagged missing', () => {
  const baseline = manifestOf([
    ['http://s/', 'aaa'],
    ['http://s/flaky', 'bbb'],
  ]);
  const fresh = manifestOf([['http://s/', 'aaa']]);
  const diff = diffManifests(baseline, fresh);
  assert.deepEqual(diff.missing, ['raw-fetch http://s/flaky']);
});

test('the same URL with different bytes is flagged as changed, not new', () => {
  const diff = diffManifests(manifestOf([['http://s/', 'aaa']]), manifestOf([['http://s/', 'zzz']]));
  assert.equal(diff.newKeys.length, 0);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0]?.baselineSha256, 'aaa');
  assert.equal(diff.changed[0]?.freshSha256, 'zzz');
});
