import { isInScope } from '../config.ts';
import type { Provenance } from '../archive/store.ts';

/** A URL waiting to be fetched, carrying the trail that led to it. */
export interface QueuedUrl {
  url: string;
  provenance: Provenance;
}

/** Why a candidate URL was not queued, so the crawl can account for everything it saw. */
export type RejectionReason =
  | 'already-seen'
  | 'normalized-duplicate'
  | 'off-site'
  | 'unsupported-scheme'
  | 'unparsable'
  | 'pagination-capped';

const CRAWLABLE_PROTOCOLS = new Set(['http:', 'https:']);

/** Default number of pages to sample from any one numeric-parameter pagination sequence. */
export const DEFAULT_PAGINATION_SAMPLE = 25;

/**
 * Query parameters that change a URL without changing the response.
 *
 * Not assumed — measured. A first crawl that treated every query string as a distinct resource
 * archived 46 paths under multiple parameter sets, and 45 of them returned byte-identical content
 * across every variant, differing only in these names. The exception was `?page=`, real pagination
 * on `/report/`, which is why this is a narrow list of known-noise names rather than a rule that
 * drops query strings wholesale.
 */
const NOISE_PARAMETERS = new Set([
  'ref',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'hl',
  'v',
]);

/** A URL reduced to its canonical identity, plus what was removed to get there. */
export interface NormalizedUrl {
  url: string;
  droppedParameters: string[];
}

/** Construction options for the {@link UrlFrontier}. */
export interface FrontierOptions {
  /** URLs from a previous run, so a re-crawl can skip what it already has. */
  alreadySeen?: Iterable<string>;
  /**
   * How many pages to sample from any one numeric-parameter pagination sequence before treating
   * the rest as a trap. Guards against endpoints like `/report/?page=N` that generate pages
   * without end. Set to `Infinity` to disable.
   */
  paginationSample?: number;
}

/**
 * The URL frontier: the crawl's boundary between URLs it has discovered and URLs it has visited.
 *
 * "Frontier" is the standard term for this structure in web crawling — the set of known-but-not-
 * yet-fetched URLs, named for the moving edge of the explored region in a graph search. Concretely
 * it is a FIFO queue of URLs still to fetch, plus a set of everything already seen.
 *
 * Breadth-first, and it is the "already seen" set that makes the crawl finish — two pages linking
 * to each other would otherwise loop forever. When the queue empties, every URL reachable from the
 * seed has been fetched, which is the completeness claim the report rests on.
 *
 * The one exception is numeric pagination: an endpoint whose `?page=N` links to `N+1` without end
 * would never let the queue empty. Such sequences are sampled up to `paginationSample` pages and
 * the rest are recorded as `pagination-capped`, so the trap is bounded and accounted for rather
 * than silently walked forever.
 */
export class UrlFrontier {
  readonly #baseUrl: URL;
  readonly #seen = new Set<string>();
  readonly #queue: QueuedUrl[] = [];
  readonly #rejections = new Map<RejectionReason, number>();
  readonly #paginationSample: number;
  /** Count of distinct values already queued for each `path?param` pagination sequence. */
  readonly #paginationCounts = new Map<string, number>();

  constructor(baseUrl: URL, options: FrontierOptions = {}) {
    this.#baseUrl = baseUrl;
    this.#paginationSample = options.paginationSample ?? DEFAULT_PAGINATION_SAMPLE;
    for (const url of options.alreadySeen ?? []) this.#seen.add(url);
  }

  /**
   * Offers a URL to the crawl, returning whether it was newly queued. Candidates that are
   * off-site, unparsable, non-HTTP, or already seen are counted and dropped.
   */
  add(rawUrl: string, provenance: Provenance): boolean {
    const normalized = normalizeUrl(rawUrl, this.#baseUrl);
    if (!normalized) {
      this.#reject(rawUrl.includes(':') ? 'unsupported-scheme' : 'unparsable');
      return false;
    }
    if (!isInScope(new URL(normalized.url), this.#baseUrl)) {
      this.#reject('off-site');
      return false;
    }
    if (this.#seen.has(normalized.url)) {
      this.#reject(
        normalized.droppedParameters.length > 0 ? 'normalized-duplicate' : 'already-seen',
      );
      return false;
    }
    if (this.#overPaginationCap(normalized.url)) {
      this.#reject('pagination-capped');
      return false;
    }

    this.#seen.add(normalized.url);
    this.#queue.push({ url: normalized.url, provenance });
    return true;
  }

  /**
   * Whether queueing this URL would exceed the pagination sample for its sequence. A URL with no
   * numeric query parameter is never a pagination page and always passes.
   */
  #overPaginationCap(url: string): boolean {
    const key = paginationKey(url);
    if (!key) return false;

    const count = this.#paginationCounts.get(key) ?? 0;
    if (count >= this.#paginationSample) return true;

    this.#paginationCounts.set(key, count + 1);
    return false;
  }

  /** Takes the next URL to fetch, or null when the crawl is done. */
  next(): QueuedUrl | null {
    return this.#queue.shift() ?? null;
  }

  /**
   * Marks a URL as seen without queueing it. Used for redirect destinations, which have already
   * been fetched as part of a chain and must not be fetched again on their own.
   */
  markSeen(rawUrl: string): void {
    const normalized = normalizeUrl(rawUrl, this.#baseUrl);
    if (normalized) this.#seen.add(normalized.url);
  }

  get pendingCount(): number {
    return this.#queue.length;
  }

  get seenCount(): number {
    return this.#seen.size;
  }

  /** Tally of candidates turned away, by reason. Reported so nothing is silently discarded. */
  get rejections(): Record<string, number> {
    return Object.fromEntries(this.#rejections);
  }

  #reject(reason: RejectionReason): void {
    this.#rejections.set(reason, (this.#rejections.get(reason) ?? 0) + 1);
  }
}

/**
 * Reduces a URL to the canonical form used as its identity, or null if it is not worth crawling.
 *
 * Discards the fragment, which never reaches the server, and the tracking parameters listed in
 * `NOISE_PARAMETERS`, which this site was measured to ignore. Every other query parameter is kept,
 * so genuinely distinct resources like `/report/?page=2` stay distinct. Getting this wrong in
 * either direction is costly: too strict and the crawl skips real pages, too loose and it walks a
 * combinatorial explosion of the same page under different tracking tags.
 */
export function normalizeUrl(rawUrl: string, baseUrl: URL): NormalizedUrl | null {
  let url: URL;
  try {
    url = new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }

  if (!CRAWLABLE_PROTOCOLS.has(url.protocol)) return null;

  url.hash = '';
  if (url.pathname === '') url.pathname = '/';

  const droppedParameters: string[] = [];
  for (const name of [...url.searchParams.keys()]) {
    if (!NOISE_PARAMETERS.has(name.toLowerCase())) continue;
    droppedParameters.push(name);
    url.searchParams.delete(name);
  }

  return { url: url.toString(), droppedParameters };
}

/**
 * Identity of the pagination sequence a URL belongs to — its path plus the name of its numeric
 * query parameter, ignoring the value — or null if it carries no numeric parameter. Two URLs
 * sharing a key differ only in a page number and so count against the same sample budget.
 */
function paginationKey(rawUrl: string): string | null {
  const url = new URL(rawUrl);
  for (const [name, value] of url.searchParams) {
    if (/^\d+$/.test(value)) return `${url.pathname}?${name}`;
  }
  return null;
}
