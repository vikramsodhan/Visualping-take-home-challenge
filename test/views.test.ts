import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanArtifacts } from '../src/analyze/index.ts';
import { expandViews, viewText } from '../src/analyze/views.ts';
import type { ArtifactMeta } from '../src/archive/store.ts';

const PASSWORD = 'VISUALPING{0123456789abcdef}';

function meta(overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    url: 'http://site.test/x',
    status: 200,
    statusText: 'OK',
    httpVersion: '1.1',
    rawHeaders: [],
    headers: {},
    contentType: 'text/plain',
    byteLength: 0,
    sha256: '',
    captureMethod: 'raw-fetch',
    fetchedAt: '',
    elapsedMs: 0,
    redirectedTo: null,
    bodyFileName: 'x',
    discoveryMethod: 'seed',
    discoveredFromUrl: null,
    ...overrides,
  };
}

function findView(views: ReturnType<typeof expandViews>, needle: string) {
  return views.find((view) => viewText(view).includes(needle));
}

test('a body seed and a header seed are always produced', () => {
  const views = expandViews(meta({ rawHeaders: [['X-Note', 'hello']] }), Buffer.from('body text'));
  assert.ok(findView(views, 'body text'), 'body seed present');
  assert.ok(findView(views, 'X-Note: hello'), 'header seed present');
});

test('finds a password hidden in a response header', () => {
  const views = expandViews(meta({ rawHeaders: [['X-Provisioning-Note', PASSWORD]] }), Buffer.alloc(0));
  assert.ok(findView(views, PASSWORD), 'password surfaced from headers');
});

test('peels back two encoding layers, recording each in the chain', () => {
  // base64( hex( password ) ) — the driver must unwrap both.
  const hexed = Buffer.from(PASSWORD, 'latin1').toString('hex');
  const wrapped = Buffer.from(hexed, 'latin1').toString('base64');

  const views = expandViews(meta(), Buffer.from(`blob=${wrapped}`));
  const hit = findView(views, PASSWORD);
  assert.ok(hit, 'password recovered through both layers');
  assert.deepEqual(hit.chain, ['response body', 'base64', 'hex']);
});

test('identical decoded bytes are not re-expanded (cycle guard)', () => {
  // Two char-code arrays spelling the same thing must collapse to one deduped view.
  const codes = [...PASSWORD].map((character) => character.charCodeAt(0)).join(', ');
  const body = Buffer.from(`a=[${codes}]; b=[${codes}];`);
  const hits = expandViews(meta(), body).filter((view) => viewText(view) === PASSWORD);
  assert.equal(hits.length, 1);
});

test('a password in plain text is not also reported via an incidental decode', () => {
  // A page with the password in plain text plus an unrelated HTML entity elsewhere: the entity
  // decoder produces a near-identical child, but the finding must be reported once, via the body.
  const { findings } = scanArtifacts([
    { meta: meta({ contentType: 'text/html' }), body: Buffer.from(`<p>${PASSWORD}</p> &amp; more`) },
  ]);
  const occurrences = findings.filter((finding) => finding.password === PASSWORD);
  assert.equal(occurrences.length, 1);
  assert.deepEqual(occurrences[0]?.decodeChain, ['response body']);
});
