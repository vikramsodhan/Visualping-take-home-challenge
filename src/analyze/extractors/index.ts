import { base64 } from './base64.ts';
import { charCodeArrays } from './charCodes.ts';
import { compression } from './compression.ts';
import { hex } from './hex.ts';
import { htmlEntities } from './htmlEntities.ts';
import { percentEncoding } from './percentEncoding.ts';
import type { Extractor } from './types.ts';

/**
 * Every decoder the recursive view expansion applies, in no particular order — each is offered
 * every view and returns children only when it applies. Adding a new hiding place means adding one
 * small module here; nothing else changes.
 *
 * Binary-format decoders (EXIF, image chunks, fonts) arrive in the next step and join this list.
 */
export const EXTRACTORS: readonly Extractor[] = [
  compression,
  base64,
  hex,
  charCodeArrays,
  percentEncoding,
  htmlEntities,
];

export type { Extractor, View } from './types.ts';
export { viewText, childView } from './types.ts';
