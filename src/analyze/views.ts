import { createHash } from 'node:crypto';
import type { ArtifactMeta } from '../archive/store.ts';
import { EXTRACTORS } from './extractors/index.ts';
import type { View } from './extractors/types.ts';

export type { View } from './extractors/types.ts';
export { viewText } from './extractors/types.ts';

/**
 * How many decode layers deep to go. A password is realistically wrapped once or twice
 * (base64 of a gzip, say); this bound stops a pathological chain of self-similar encodings from
 * looping, backstopped by the content-hash guard below.
 */
const MAX_DEPTH = 5;

/** Safety cap on views produced from one response, so a hostile input cannot exhaust memory. */
const MAX_VIEWS = 20_000;

/**
 * Turns one archived response into every searchable form it can be decoded into.
 *
 * Starts from the raw body, the rendered headers, and any caller-supplied extra seeds (image OCR
 * text, for one), then repeatedly applies every extractor, breadth-first, so a password behind
 * several layers (base64 of a char-code array, say) is peeled open one layer at a time. Each view's
 * provenance chain records the exact route taken.
 *
 * Two guards keep it finite: a depth limit, and a content-hash set that drops any view whose bytes
 * have already been produced. The hash guard is what makes a cyclic or self-referential encoding
 * safe — the moment a decode reproduces bytes seen before, that branch stops.
 */
export function expandViews(meta: ArtifactMeta, body: Buffer, extraSeeds: View[] = []): View[] {
  const seeds: View[] = [
    { bytes: body, chain: ['response body'] },
    { bytes: Buffer.from(renderHeaders(meta), 'utf8'), chain: ['response headers'] },
    ...extraSeeds,
  ];

  const produced: View[] = [];
  const seen = new Set<string>();
  const queue: Array<{ view: View; depth: number }> = seeds.map((view) => ({ view, depth: 0 }));

  while (queue.length > 0) {
    const { view, depth } = queue.shift()!;

    const fingerprint = createHash('sha256').update(view.bytes).digest('hex');
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    produced.push(view);

    if (produced.length >= MAX_VIEWS || depth >= MAX_DEPTH) continue;

    for (const extract of EXTRACTORS) {
      for (const child of extract(view)) {
        queue.push({ view: child, depth: depth + 1 });
      }
    }
  }

  return produced;
}

/**
 * Renders response headers back into wire form. Headers are a genuine hiding place — one of this
 * site's passwords lives in an `X-Provisioning-Note` — and the raw pairs preserve the duplicates
 * and casing a lookup map would have merged away.
 */
function renderHeaders(meta: ArtifactMeta): string {
  return meta.rawHeaders.map(([name, value]) => `${name}: ${value}`).join('\n');
}
