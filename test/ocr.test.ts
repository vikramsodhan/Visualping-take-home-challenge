import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeOcrHex } from '../src/analyze/ocr.ts';

test('corrects the digit-shaped letters OCR reads inside a password frame', () => {
  // tesseract reads 0 as o and 1 as l in a monospace hex string.
  assert.equal(
    normalizeOcrHex('VISUALPING{ooabcdefll223344}'),
    'VISUALPING{00abcdef11223344}',
  );
});

test('maps the common hex lookalikes (l/o/s → 1/0/5)', () => {
  assert.equal(normalizeOcrHex('VISUALPING{oossllllllllllll}'), 'VISUALPING{0055111111111111}');
});

test('leaves an already-valid password untouched', () => {
  const valid = 'VISUALPING{0123456789abcdef}';
  assert.equal(normalizeOcrHex(valid), valid);
});

test('does not rewrite a frame that cannot become hex', () => {
  // 'x' is neither hex nor a known lookalike, so the frame is left exactly as found.
  const unfixable = 'VISUALPING{xxxxxxxxxxxxxxxx}';
  assert.equal(normalizeOcrHex(unfixable), unfixable);
});

test('does not touch ordinary prose that merely mentions the brand', () => {
  const prose = 'Welcome to the Visualping challenge {enjoy}.';
  assert.equal(normalizeOcrHex(prose), prose);
});

test('requires exactly sixteen characters inside the frame', () => {
  const tooShort = 'VISUALPING{abcdef}';
  assert.equal(normalizeOcrHex(tooShort), tooShort);
});
