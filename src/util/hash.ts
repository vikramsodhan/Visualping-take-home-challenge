import { createHash } from 'node:crypto';

/**
 * Content hash of a response body. Used to tell "this URL returned the same bytes as last run"
 * from "this URL changed", which is what makes the second-run completeness proof meaningful.
 */
export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Short, stable, filesystem-safe digest of a string. Used to disambiguate archive filenames for
 * URLs that slugify to the same readable stem (e.g. two different query strings on one path).
 */
export function shortHash(value: string, length = 8): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, length);
}
