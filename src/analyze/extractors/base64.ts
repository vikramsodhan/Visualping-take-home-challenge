import { childView, viewText, type Extractor, type View } from './types.ts';

/** A run of base64 characters long enough to be worth decoding (≥16 chars → ≥12 bytes). */
const BASE64_RUN = /[A-Za-z0-9+/]{16,}={0,2}/g;

/** Cap on tokens decoded per view, so a large minified file cannot blow up. */
const MAX_TOKENS = 2000;

/**
 * Decodes standalone base64 runs found in a view.
 *
 * base64 is the most common way a payload gets tucked into text — a data URI, a config blob, an
 * inline asset — so a password hidden this way is a live possibility. Only well-formed runs are
 * decoded (valid length, minimal padding); the recursive driver then re-scans the result, so
 * base64-of-something-else is unwrapped one layer at a time.
 */
export const base64: Extractor = (view) => {
  const text = viewText(view);
  const results: View[] = [];

  for (const match of text.matchAll(BASE64_RUN)) {
    if (results.length >= MAX_TOKENS) break;

    const token = match[0];
    if (!isPlausibleBase64(token)) continue;

    const decoded = Buffer.from(token, 'base64');
    // Node's decoder is lenient; a genuine base64 string round-trips back to itself.
    if (decoded.length < 8 || decoded.toString('base64').replace(/=+$/, '') !== token.replace(/=+$/, '')) {
      continue;
    }
    results.push(childView(view, 'base64', decoded));
  }

  return results;
};

function isPlausibleBase64(token: string): boolean {
  const withoutPadding = token.replace(/=+$/, '');
  return withoutPadding.length >= 16 && token.length % 4 === 0;
}
