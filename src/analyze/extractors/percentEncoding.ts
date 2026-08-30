import { childView, viewText, type Extractor } from './types.ts';

const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;
const PERCENT_ESCAPE_ALL = /%[0-9a-fA-F]{2}/g;

/**
 * Decodes percent-encoded escapes (`%7B` → `{`), the encoding used in URLs and form data.
 *
 * Applied to the whole view at once rather than per-run, so a password split across escapes and
 * literal characters (`VISUALPING%7B...%7D`) reassembles. Returns nothing when there is nothing to
 * decode, so it does not clone every view needlessly.
 */
export const percentEncoding: Extractor = (view) => {
  const text = viewText(view);
  if (!PERCENT_ESCAPE.test(text)) return [];

  const decoded = text.replace(PERCENT_ESCAPE_ALL, (escape) =>
    String.fromCharCode(Number.parseInt(escape.slice(1), 16)),
  );
  if (decoded === text) return [];

  return [childView(view, 'percent-encoding', Buffer.from(decoded, 'latin1'))];
};
