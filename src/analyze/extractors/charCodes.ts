import { childView, viewText, type Extractor, type View } from './types.ts';

/** A bracketed list of at least four integers, e.g. `[86, 73, 83, 85]`. */
const NUMERIC_ARRAY = /\[\s*\d{1,6}(?:\s*,\s*\d{1,6}){3,}\s*\]/g;

/** Cap on arrays decoded per view, so a data file full of numeric tuples cannot blow up. */
const MAX_ARRAYS = 2000;

/**
 * Decodes arrays of character codes into text, the `String.fromCharCode([...])` trick.
 *
 * This is how one of this site's passwords is stored — `theme-switcher.js` holds
 * `_beacon = [86, 73, 83, ...]`, which spells out a `VISUALPING{...}` string the source never
 * shows literally. Each qualifying array becomes its own view so the scanner can read the result.
 */
export const charCodeArrays: Extractor = (view) => {
  const text = viewText(view);
  const results: View[] = [];

  for (const match of text.matchAll(NUMERIC_ARRAY)) {
    if (results.length >= MAX_ARRAYS) break;

    const codes = match[0]
      .slice(1, -1)
      .split(',')
      .map((part) => Number.parseInt(part, 10));
    if (codes.some((code) => !Number.isInteger(code) || code < 0 || code > 0x10ffff)) continue;

    let decoded = '';
    for (const code of codes) decoded += String.fromCodePoint(code);
    results.push(childView(view, 'char-code array', Buffer.from(decoded, 'latin1')));
  }

  return results;
};
