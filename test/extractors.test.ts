import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { base64 } from '../src/analyze/extractors/base64.ts';
import { charCodeArrays } from '../src/analyze/extractors/charCodes.ts';
import { compression } from '../src/analyze/extractors/compression.ts';
import { hex } from '../src/analyze/extractors/hex.ts';
import { htmlEntities } from '../src/analyze/extractors/htmlEntities.ts';
import { percentEncoding } from '../src/analyze/extractors/percentEncoding.ts';
import { viewText, type View } from '../src/analyze/extractors/types.ts';

const PASSWORD = 'VISUALPING{0123456789abcdef}';

function seed(text: string | Buffer): View {
  return { bytes: Buffer.isBuffer(text) ? text : Buffer.from(text, 'latin1'), chain: ['seed'] };
}

/** Asserts exactly one child decoded to the password, with the expected chain label appended. */
function assertDecodesTo(children: View[], label: string): void {
  const hit = children.find((child) => viewText(child).includes(PASSWORD));
  assert.ok(hit, `expected a child containing the password, got ${children.length} children`);
  assert.deepEqual(hit.chain, ['seed', label]);
}

test('char-code arrays decode to text (the theme-switcher.js trick)', () => {
  const codes = [...PASSWORD].map((character) => character.charCodeAt(0));
  assertDecodesTo(charCodeArrays(seed(`var b = [${codes.join(', ')}];`)), 'char-code array');
});

test('char-code extractor ignores short numeric tuples', () => {
  assert.deepEqual(charCodeArrays(seed('coords = [1, 2, 3]')), []);
});

test('base64 decodes a standalone token', () => {
  const token = Buffer.from(PASSWORD, 'latin1').toString('base64');
  assertDecodesTo(base64(seed(`data-blob="${token}"`)), 'base64');
});

test('base64 ignores runs that are not valid base64', () => {
  // A minified identifier: right charset, wrong length, does not round-trip.
  assert.deepEqual(base64(seed('const abcdefghijklmnopq = 1;')), []);
});

test('hex decodes a long hex run', () => {
  const encoded = Buffer.from(PASSWORD, 'latin1').toString('hex');
  assertDecodesTo(hex(seed(`sig=${encoded}`)), 'hex');
});

test('hex leaves the sixteen digits inside a password alone', () => {
  // The 16 hex of a password is below the 32-char threshold, so it is not itself decoded.
  assert.deepEqual(hex(seed(PASSWORD)), []);
});

test('percent-encoding reassembles a password split across escapes', () => {
  const encoded = `VISUALPING%7B0123456789abcdef%7D`;
  assertDecodesTo(percentEncoding(seed(encoded)), 'percent-encoding');
});

test('html entities decode numeric and hex references', () => {
  const encoded = `VISUALPING&#123;0123456789abcdef&#x7d;`;
  assertDecodesTo(htmlEntities(seed(encoded)), 'html-entities');
});

test('compression inflates a gzip payload', () => {
  assertDecodesTo(compression(seed(gzipSync(Buffer.from(PASSWORD)))), 'gzip');
});

test('extractors that do not apply return nothing', () => {
  const plain = seed('nothing to see here');
  assert.deepEqual(percentEncoding(plain), []);
  assert.deepEqual(htmlEntities(plain), []);
  assert.deepEqual(compression(plain), []);
});
