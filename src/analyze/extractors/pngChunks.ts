import { inflateSync } from 'node:zlib';
import { childView, type Extractor, type View } from './types.ts';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Extracts the textual metadata chunks a PNG can carry — `tEXt`, `zTXt` (zlib-compressed) and
 * `iTXt` (UTF-8, optionally compressed).
 *
 * These chunks are a classic place to stash a note the image itself never shows, so each one's
 * text is surfaced as its own view. Walking the chunk structure is exact, where a blind byte sweep
 * would miss a compressed `zTXt` entirely.
 */
export const pngTextChunks: Extractor = (view) => {
  const bytes = view.bytes;
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return [];

  const results: View[] = [];
  let position = 8;

  while (position + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(position);
    const type = bytes.toString('latin1', position + 4, position + 8);
    const dataStart = position + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;

    const data = bytes.subarray(dataStart, dataEnd);
    const decoded = decodeTextChunk(type, data);
    if (decoded) results.push(childView(view, `png ${type}`, decoded));

    if (type === 'IEND') break;
    position = dataEnd + 4; // skip the trailing CRC
  }

  return results;
};

/** Returns the text payload of a PNG metadata chunk, or null if the chunk carries no text. */
function decodeTextChunk(type: string, data: Buffer): Buffer | null {
  if (type === 'tEXt') {
    return data; // keyword \0 text — the scanner reads straight through the separator
  }
  if (type === 'zTXt') {
    const separator = data.indexOf(0);
    if (separator < 0) return null;
    // keyword \0 (1 byte compression method) compressed-text
    return tryInflate(data.subarray(separator + 2));
  }
  if (type === 'iTXt') {
    return decodeItxt(data);
  }
  return null;
}

/** iTXt: keyword \0 compressionFlag(1) compressionMethod(1) langTag \0 translatedKeyword \0 text. */
function decodeItxt(data: Buffer): Buffer | null {
  const keywordEnd = data.indexOf(0);
  if (keywordEnd < 0 || keywordEnd + 2 >= data.length) return null;

  const compressed = data[keywordEnd + 1] === 1;
  const langEnd = data.indexOf(0, keywordEnd + 3);
  if (langEnd < 0) return null;
  const translatedEnd = data.indexOf(0, langEnd + 1);
  if (translatedEnd < 0) return null;

  const text = data.subarray(translatedEnd + 1);
  return compressed ? tryInflate(text) : text;
}

function tryInflate(bytes: Buffer): Buffer | null {
  try {
    return inflateSync(bytes);
  } catch {
    return null;
  }
}
