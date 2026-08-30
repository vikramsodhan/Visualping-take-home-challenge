import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Config } from '../config.ts';
import { findPasswords, sliceContext } from './scan.ts';

/**
 * The one resource the automated crawl cannot reach, and the story of getting past it.
 *
 * `/status/eu-region/` answers 403 to anyone outside Germany. The block is on the real TCP source
 * address (an nginx GeoIP lookup on `remote_addr`), not on any request header — so `X-Forwarded-For`,
 * `X-Real-IP`, `CF-Connecting-IP`, `CF-IPCountry`, a `region` cookie and `?region=` were all tried
 * and all still resolved to Canada. The page is linked from the homepage, so it is meant to be
 * reachable; a browser simply has to reach it from the right place.
 *
 * Only the path and the narrative live here. The site's address and the password itself are secrets
 * that never belong in a public repo, so the value is read at analysis time from the saved page in
 * the gitignored output directory — the same place every other password only ever appears.
 */
export const GEO_GATED = {
  path: '/status/eu-region/',
  region: 'Germany (DE)',
  obstacle:
    'Returns HTTP 403 to non-German clients. The server geolocates the real TCP source address, ' +
    'so no request header changes the outcome — X-Forwarded-For (incl. German IPs), X-Real-IP, ' +
    'CF-Connecting-IP, CF-IPCountry, Accept-Language and a region cookie were all tried and all ' +
    'still read as Canada.',
  resolution:
    'Fetched with one authenticated GET routed through a German egress — a Tor circuit pinned to a ' +
    'German exit (ExitNodes {de}). From a German IP the server returns 200 with the password. The ' +
    'response HTML is saved to the output directory so the analyser can report it like any other.',
  /** File in the output directory holding the page fetched via German egress. */
  savedPageFile: 'eu-region-DE.html',
} as const;

/** A finding the automated crawl could not reach, recovered out of band and documented in full. */
export interface OutOfBandFinding {
  password: string | null;
  url: string;
  region: string;
  obstacle: string;
  resolution: string;
  context: string | null;
  savedPageFile: string;
  /** True once the saved page is present and yields the password; false on a fresh checkout. */
  resolved: boolean;
}

/**
 * The geo-gated finding before any German-egress page has been read: the roadblock documented, the
 * value not yet recovered. Used as the default when scanning an archive on its own.
 */
export function unresolvedGeoGated(): OutOfBandFinding {
  return {
    password: null,
    url: GEO_GATED.path,
    region: GEO_GATED.region,
    obstacle: GEO_GATED.obstacle,
    resolution: GEO_GATED.resolution,
    context: null,
    savedPageFile: GEO_GATED.savedPageFile,
    resolved: false,
  };
}

/**
 * Builds the geo-gated finding, reading the saved German-egress page for the password when it is
 * present. On a fresh checkout the page is absent (it is gitignored), so the finding is returned
 * unresolved — the roadblock and how to get past it are still fully documented, just without the
 * value, which is exactly how it should behave without German egress.
 */
export async function loadGeoGatedFinding(config: Config): Promise<OutOfBandFinding> {
  const base: OutOfBandFinding = {
    password: null,
    url: new URL(GEO_GATED.path, config.baseUrl).toString(),
    region: GEO_GATED.region,
    obstacle: GEO_GATED.obstacle,
    resolution: GEO_GATED.resolution,
    context: null,
    savedPageFile: GEO_GATED.savedPageFile,
    resolved: false,
  };

  try {
    const html = await readFile(resolve(config.outDir, GEO_GATED.savedPageFile), 'utf8');
    const match = findPasswords(html)[0];
    if (!match) return base;
    return {
      ...base,
      password: match.password,
      context: sliceContext(html, match.offset, match.offset + match.password.length),
      resolved: true,
    };
  } catch {
    return base;
  }
}
