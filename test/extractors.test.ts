import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { base64 } from '../src/analyze/extractors/base64.ts';
import { charCodeArrays } from '../src/analyze/extractors/charCodes.ts';
import { compression } from '../src/analyze/extractors/compression.ts';
import { hex } from '../src/analyze/extractors/hex.ts';
import { htmlEntities } from '../src/analyze/extractors/htmlEntities.ts';
import { percentEncoding } from '../src/analyze/extractors/percentEncoding.ts';
import { pngTextChunks } from '../src/analyze/extractors/pngChunks.ts';
import { trailingBytes } from '../src/analyze/extractors/trailingBytes.ts';
import { utf16Text } from '../src/analyze/extractors/utf16.ts';
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

test('utf-16le decodes text that latin1 reads as null-separated (the EXIF trick)', () => {
  const utf16 = Buffer.from(PASSWORD, 'utf16le'); // V\0I\0S\0...
  assertDecodesTo(utf16Text(seed(utf16)), 'utf-16le');
});

test('utf-16 extractor stays quiet on plain ascii (no printable run after decode)', () => {
  assert.deepEqual(utf16Text(seed('this is ordinary ascii text with no utf-16 in it')), []);
});

test('png tEXt chunk text is extracted', () => {
  const png = pngWithTextChunk('tEXt', Buffer.concat([Buffer.from('Comment\0'), Buffer.from(PASSWORD)]));
  assertDecodesTo(pngTextChunks(seed(png)), 'png tEXt');
});

test('trailing bytes after JPEG EOI are surfaced', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from(PASSWORD)]);
  assertDecodesTo(trailingBytes(seed(jpeg)), 'trailing bytes (after JPEG EOI)');
});

test('trailing-bytes extractor stays quiet on a clean image', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0x00, 0x11, 0xff, 0xd9]);
  assert.deepEqual(trailingBytes(seed(jpeg)), []);
});

/** Builds a minimal valid-enough PNG carrying one metadata chunk, for the chunk-walker to parse. */
function pngWithTextChunk(type: string, data: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); // the walker does not verify CRCs
  return Buffer.concat([signature, length, Buffer.from(type), data, crc]);
}
