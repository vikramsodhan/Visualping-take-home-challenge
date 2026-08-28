import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findNearMisses, findPasswords } from '../src/analyze/scan.ts';

const VALID = 'VISUALPING{0123456789abcdef}';

test('finds a well-formed password with its offset', () => {
  const matches = findPasswords(`prefix ${VALID} suffix`);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.password, VALID);
  assert.equal(matches[0]?.offset, 7);
});

test('rejects passwords that are close but not exact', () => {
  assert.deepEqual(findPasswords('VISUALPING{0123456789ABCDEF}'), []); // uppercase hex
  assert.deepEqual(findPasswords('VISUALPING{0123456789abcde}'), []); // fifteen digits
  assert.deepEqual(findPasswords('VISUALPING{0123456789abcdefg}'), []); // non-hex digit
});

test('a global regex does not carry state between calls', () => {
  const text = `${VALID} and ${VALID}`;
  assert.equal(findPasswords(text).length, 2);
  assert.equal(findPasswords(text).length, 2, 'second call must find the same matches');
});

test('classifies password-shaped text the pattern rejected as a near-miss worth chasing', () => {
  const misses = findNearMisses('VISUALPING{0123456789ABCDEF}');
  assert.equal(misses.length, 1);
  assert.equal(misses[0]?.kind, 'malformed-password');
  assert.equal(misses[0]?.matched, 'VISUALPING{0123456789ABCDEF}');
});

test('treats the bare brand name as prose, not as a lead', () => {
  const misses = findNearMisses('<title>Visualping Crawler Challenge</title>');
  assert.equal(misses.length, 1);
  assert.equal(misses[0]?.kind, 'brand-mention');
});

test('does not report a well-formed password as a near-miss', () => {
  assert.deepEqual(findNearMisses(`text ${VALID} text`), []);
});

test('separates a real password from a malformed one in the same document', () => {
  const misses = findNearMisses(`${VALID} then VISUALPING{nope}`);
  assert.equal(misses.length, 1);
  assert.equal(misses[0]?.kind, 'malformed-password');
  assert.equal(misses[0]?.matched, 'VISUALPING{nope}');
});
