import { childView, type Extractor, type View } from './types.ts';

/** A run of printable ASCII long enough that the decode found real text, not noise. */
const PRINTABLE_RUN = /[\x20-\x7E]{8,}/;

interface Utf16Variant {
  label: string;
  littleEndian: boolean;
  startOffset: number;
}

/**
 * Both byte orders, and both alignments within each, since a UTF-16 region embedded in a larger
 * file can begin on an odd byte offset that shifts the 2-byte framing.
 */
const VARIANTS: Utf16Variant[] = [
  { label: 'utf-16le', littleEndian: true, startOffset: 0 },
  { label: 'utf-16le (odd offset)', littleEndian: true, startOffset: 1 },
  { label: 'utf-16be', littleEndian: false, startOffset: 0 },
  { label: 'utf-16be (odd offset)', littleEndian: false, startOffset: 1 },
];

/**
 * Decodes UTF-16 text embedded in a view's bytes.
 *
 * This is how one of this site's passwords hides: `field-visit.jpg` stores it in an EXIF comment
 * as UTF-16, so the default latin1 reading sees `V\0I\0S\0…` and the pattern never matches across
 * the interleaved null bytes. Decoding as UTF-16 collapses those pairs back into readable text.
 *
 * Applied to the whole view rather than a parsed EXIF field, so it also catches UTF-16 text
 * anywhere else it might be tucked. Decoding arbitrary binary as UTF-16 yields non-ASCII noise,
 * so a child is emitted only when a genuine printable run appears — which keeps plain ASCII views
 * (that decode to CJK gibberish) from producing anything.
 */
export const utf16Text: Extractor = (view) => {
  const results: View[] = [];

  for (const variant of VARIANTS) {
    const text = decodeUtf16(view.bytes, variant);
    if (!PRINTABLE_RUN.test(text)) continue;
    results.push(childView(view, variant.label, Buffer.from(text, 'latin1')));
  }

  return results;
};

function decodeUtf16(bytes: Buffer, variant: Utf16Variant): string {
  let slice = bytes.subarray(variant.startOffset);
  if (slice.length % 2 !== 0) slice = slice.subarray(0, slice.length - 1);
  if (slice.length === 0) return '';

  // Node decodes UTF-16LE natively; for big-endian, swap each pair into little-endian first.
  const source = variant.littleEndian ? slice : Buffer.from(slice).swap16();
  return source.toString('utf16le');
}
