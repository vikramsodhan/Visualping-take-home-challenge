import { childView, viewText, type Extractor, type View } from './types.ts';

/** A run of hex digits long enough to encode something (≥32 chars → ≥16 bytes). */
const HEX_RUN = /[0-9a-fA-F]{32,}/g;

/** Cap on runs decoded per view. */
const MAX_RUNS = 2000;

/**
 * Decodes long hex runs into bytes.
 *
 * A whole `VISUALPING{...}` string rendered as hex is far longer than the sixteen hex digits
 * inside one password, so the threshold sits above that to avoid decoding the passwords' own
 * innards. Odd-length runs are trimmed to the last even boundary rather than dropped, since the
 * encoded region may butt up against other text.
 */
export const hex: Extractor = (view) => {
  const text = viewText(view);
  const results: View[] = [];

  for (const match of text.matchAll(HEX_RUN)) {
    if (results.length >= MAX_RUNS) break;

    const run = match[0];
    const even = run.length % 2 === 0 ? run : run.slice(0, -1);
    results.push(childView(view, 'hex', Buffer.from(even, 'hex')));
  }

  return results;
};
