import { childView, type Extractor, type View } from './types.ts';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_END = Buffer.from('IEND');
const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

/**
 * Surfaces bytes appended after an image's declared end.
 *
 * A decoder stops at `IEND` (PNG) or the `FFD9` end-of-image marker (JPEG), so anything after it is
 * ignored by every viewer yet still shipped in the file — a favourite spot to smuggle a payload.
 * The extra bytes become their own view for the rest of the pipeline to decode and scan.
 */
export const trailingBytes: Extractor = (view) => {
  const bytes = view.bytes;

  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const marker = bytes.lastIndexOf(PNG_END);
    if (marker >= 0) return tail(view, bytes, marker + PNG_END.length + 4, 'after PNG IEND');
  }

  if (bytes.subarray(0, 2).equals(JPEG_START)) {
    const marker = bytes.lastIndexOf(JPEG_END);
    if (marker >= 0) return tail(view, bytes, marker + JPEG_END.length, 'after JPEG EOI');
  }

  return [];
};

function tail(view: View, bytes: Buffer, from: number, label: string): View[] {
  if (from >= bytes.length) return [];
  return [childView(view, `trailing bytes (${label})`, bytes.subarray(from))];
}
