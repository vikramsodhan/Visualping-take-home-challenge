/** How many passwords the brief says are hidden on the site. The target we measure against. */
export const EXPECTED_PASSWORD_COUNT = 8;

/** The exact shape of a password: the literal prefix, sixteen lowercase hex digits, a brace. */
const PASSWORD_PATTERN = String.raw`VISUALPING\{[0-9a-f]{16}\}`;

/**
 * Something shaped like a password container that the strict pattern rejected: uppercase hex, the
 * wrong digit count, a missing brace. Case-insensitive, since an encoding may have changed the
 * case on the way through.
 */
const MALFORMED_PATTERN = String.raw`visualping\s*\{[^}]{0,64}\}?`;

/**
 * The brand on its own. On this site that is mostly prose — it is in the page title, the logo and
 * the headings — so a hit here is weak evidence, reported separately from the shaped ones.
 */
const BRAND_PATTERN = String.raw`visualping`;

/** One password occurrence, located and quoted. */
export interface PasswordMatch {
  password: string;
  offset: number;
  context: string;
}

/**
 * How strongly a near-miss suggests an undecoded password.
 *
 * `malformed-password` is the signal worth chasing: something with the brand and a brace that the
 * strict pattern rejected. `brand-mention` is the brand in running text, which on a site called
 * Visualping is usually just prose.
 */
export type NearMissKind = 'malformed-password' | 'brand-mention';

/** A place the brand appears without a well-formed password around it. */
export interface NearMiss {
  kind: NearMissKind;
  /** The literal text that matched, so the report can show what was rejected. */
  matched: string;
  offset: number;
  context: string;
}

/**
 * Finds every well-formed password in a decoded view, with its offset and surrounding text.
 *
 * A fresh regex is built per call because a shared global regex carries `lastIndex` between
 * calls, which would silently skip matches on the next view scanned.
 */
export function findPasswords(text: string): PasswordMatch[] {
  const matches: PasswordMatch[] = [];
  const regex = new RegExp(PASSWORD_PATTERN, 'g');

  for (const match of text.matchAll(regex)) {
    matches.push({
      password: match[0],
      offset: match.index,
      context: sliceContext(text, match.index, match.index + match[0].length),
    });
  }

  return matches;
}

/**
 * Finds mentions of the brand that are *not* part of a well-formed password.
 *
 * This is the tool's own gap detector: a `malformed-password` hit means the site is holding
 * something password-shaped in a form the decoders have not learned yet, and it names exactly
 * which response to look at next.
 *
 * The two kinds are separated because the brand is also the site's name, so an undifferentiated
 * search drowns the real signal in page titles and headings. Anything already claimed by a
 * well-formed password, or by a malformed container, is not reported again.
 */
export function findNearMisses(text: string): NearMiss[] {
  const passwordRanges = toRanges(findPasswords(text).map((match) => [match.offset, match.password]));
  const nearMisses: NearMiss[] = [];
  const malformedRanges: Array<readonly [number, number]> = [];

  for (const match of text.matchAll(new RegExp(MALFORMED_PATTERN, 'gi'))) {
    if (covers(passwordRanges, match.index)) continue;
    malformedRanges.push([match.index, match.index + match[0].length]);
    nearMisses.push(toNearMiss('malformed-password', text, match.index, match[0]));
  }

  for (const match of text.matchAll(new RegExp(BRAND_PATTERN, 'gi'))) {
    if (covers(passwordRanges, match.index) || covers(malformedRanges, match.index)) continue;
    nearMisses.push(toNearMiss('brand-mention', text, match.index, match[0]));
  }

  return nearMisses;
}

function toNearMiss(kind: NearMissKind, text: string, offset: number, matched: string): NearMiss {
  return { kind, matched, offset, context: sliceContext(text, offset, offset + matched.length) };
}

function toRanges(matches: Array<[number, string]>): Array<readonly [number, number]> {
  return matches.map(([offset, matched]) => [offset, offset + matched.length] as const);
}

function covers(ranges: Array<readonly [number, number]>, offset: number): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

/**
 * Quotes the text around a match so a finding can be judged without opening the archived file.
 * Control characters are replaced and runs of whitespace collapsed, so a hit inside a binary or a
 * minified bundle still prints as one readable line.
 */
export function sliceContext(text: string, start: number, end: number, radius = 120): string {
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  const lead = from > 0 ? '…' : '';
  const trail = to < text.length ? '…' : '';
  return `${lead}${toPrintable(text.slice(from, to))}${trail}`;
}

/** Tab and newline are excluded so the whitespace collapse below turns them into spaces. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

function toPrintable(raw: string): string {
  return raw.replace(CONTROL_CHARACTERS, '.').replace(/\s+/g, ' ').trim();
}
