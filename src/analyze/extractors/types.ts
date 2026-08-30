/**
 * One decoded rendering of a response, plus the trail of transforms that produced it.
 *
 * The chain is what lets a finding explain *how* a password was hidden — it reads like
 * `response body → base64 → gzip`. Bytes rather than a string, so a decoder can operate on binary
 * output and hand it to the next decoder without a lossy round-trip through text.
 */
export interface View {
  bytes: Buffer;
  chain: string[];
}

/**
 * A pure decoder: given one view, produce zero or more decoded child views. Returning `[]` means
 * "this transform does not apply to these bytes". Extractors never mutate their input.
 */
export type Extractor = (view: View) => View[];

/**
 * Reads a view's bytes as text for pattern matching. latin1 maps every byte to exactly one
 * character, so ASCII survives untouched, string offsets equal byte offsets, and binary can be
 * swept for embedded text without utf8's replacement characters destroying the run being searched.
 */
export function viewText(view: View): string {
  return view.bytes.toString('latin1');
}

/** Builds a child view, appending `label` to the parent's provenance chain. */
export function childView(parent: View, label: string, bytes: Buffer): View {
  return { bytes, chain: [...parent.chain, label] };
}
