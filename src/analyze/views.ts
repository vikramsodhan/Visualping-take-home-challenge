import type { ArtifactMeta } from '../archive/store.ts';

/**
 * One searchable rendering of an archived response, plus the trail of transformations that
 * produced it. The chain is what lets a finding say *how* a password was hidden — it reads like
 * `response body -> gzip -> base64` once the decoders land.
 */
export interface View {
  text: string;
  chain: string[];
}

/**
 * Turns one archived response into every text form worth searching.
 *
 * Today that is the body and the headers. Later steps make this recursive: each view will be fed
 * back through a registry of decoders (decompress, base64, HTML comments, PDF text, font tables),
 * appending a link to `chain` each time, with a depth limit and a content-hash cycle guard.
 */
export function expandViews(meta: ArtifactMeta, body: Buffer): View[] {
  return [bodyView(body), headerView(meta)];
}

/**
 * Decodes the body as latin1 rather than utf8 so every byte maps to exactly one character. ASCII
 * survives untouched, string offsets stay equal to byte offsets, and binary files can be swept for
 * embedded text without utf8's replacement characters destroying the very run being searched for.
 */
function bodyView(body: Buffer): View {
  return { text: body.toString('latin1'), chain: ['response body'] };
}

/**
 * Renders the response headers back into wire form. Headers are a genuine hiding place, and the
 * raw pairs preserve duplicates and casing that a lookup map would have merged away.
 */
function headerView(meta: ArtifactMeta): View {
  const text = meta.rawHeaders.map(([name, value]) => `${name}: ${value}`).join('\n');
  return { text, chain: ['response headers'] };
}
