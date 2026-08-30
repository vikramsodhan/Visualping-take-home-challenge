import { gunzipSync, inflateSync } from 'node:zlib';
import { childView, type Extractor, type View } from './types.ts';

/**
 * Decompresses gzip and zlib bodies.
 *
 * The archive stores exactly what the server sent, compression included, so a password inside a
 * compressed response is invisible until it is inflated here at analysis time. Detection is by
 * magic bytes rather than the response's `Content-Encoding`, so it also catches a compressed blob
 * embedded inside another resource, not just a whole compressed response.
 *
 * Brotli is intentionally not attempted: it has no magic-byte signature, so a blind attempt on
 * every view would be pure noise. Add it keyed off `Content-Encoding: br` if a body ever needs it.
 */
export const compression: Extractor = (view) => {
  const bytes = view.bytes;
  const results: View[] = [];

  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    tryInflate(() => gunzipSync(bytes), view, 'gzip', results);
  }
  // zlib streams start 0x78 with a valid header checksum in the second byte.
  if (bytes.length >= 2 && bytes[0] === 0x78 && (bytes[1] === 0x01 || bytes[1] === 0x9c || bytes[1] === 0xda)) {
    tryInflate(() => inflateSync(bytes), view, 'zlib', results);
  }

  return results;
};

function tryInflate(decode: () => Buffer, view: View, label: string, results: View[]): void {
  try {
    const decoded = decode();
    if (decoded.length > 0) results.push(childView(view, label, decoded));
  } catch {
    // Magic bytes matched but the stream was not valid; nothing to add.
  }
}
