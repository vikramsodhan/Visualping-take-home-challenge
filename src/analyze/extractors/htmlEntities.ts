import { childView, viewText, type Extractor } from './types.ts';

const ANY_ENTITY = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/;
const NUMERIC_ENTITY = /&#(\d+);/g;
const HEX_ENTITY = /&#x([0-9a-fA-F]+);/gi;
const NAMED_ENTITY = /&(amp|lt|gt|quot|apos);/gi;

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decodes HTML character references — numeric (`&#123;`), hex (`&#x7b;`) and the common named ones.
 *
 * A password written `VISUALPING&#123;...&#125;` renders as normal text in a browser but never
 * appears literally in the markup, so the plain scanner would miss it. Returns nothing when the
 * view holds no entities.
 */
export const htmlEntities: Extractor = (view) => {
  const text = viewText(view);
  if (!ANY_ENTITY.test(text)) return [];

  const decoded = text
    .replace(NUMERIC_ENTITY, (_, digits) => codePoint(Number.parseInt(digits, 10)))
    .replace(HEX_ENTITY, (_, digits) => codePoint(Number.parseInt(digits, 16)))
    .replace(NAMED_ENTITY, (whole, name: string) => NAMED[name.toLowerCase()] ?? whole);
  if (decoded === text) return [];

  return [childView(view, 'html-entities', Buffer.from(decoded, 'latin1'))];
};

function codePoint(value: number): string {
  return value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
}
