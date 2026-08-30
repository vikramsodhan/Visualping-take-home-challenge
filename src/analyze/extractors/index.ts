import { base64 } from './base64.ts';
import { charCodeArrays } from './charCodes.ts';
import { compression } from './compression.ts';
import { hex } from './hex.ts';
import { htmlEntities } from './htmlEntities.ts';
import { percentEncoding } from './percentEncoding.ts';
import { pngTextChunks } from './pngChunks.ts';
import { trailingBytes } from './trailingBytes.ts';
import { utf16Text } from './utf16.ts';
import type { Extractor } from './types.ts';

/**
 * Every decoder the recursive view expansion applies, in no particular order — each is offered
 * every view and returns children only when it applies. Adding a new hiding place means adding one
 * small module here; nothing else changes.
 *
 * Not present: PDF, font (name tables) and zip decoders. The crawl archived none of those formats,
 * so the parsers — and their dependencies — would be dead weight. Add them here if a later crawl
 * turns up such a resource. Image-pixel text (OCR) is the other deferred slot; see the README.
 */
export const EXTRACTORS: readonly Extractor[] = [
  compression,
  base64,
  hex,
  charCodeArrays,
  percentEncoding,
  htmlEntities,
  utf16Text,
  pngTextChunks,
  trailingBytes,
];

export type { Extractor, View } from './types.ts';
export { viewText, childView } from './types.ts';
