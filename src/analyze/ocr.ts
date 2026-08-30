import { readFile, writeFile } from 'node:fs/promises';
import { createWorker, type Worker } from 'tesseract.js';
import { sha256Hex } from '../util/hash.ts';

/** Content types worth running through OCR. */
const OCR_IMAGE_TYPES = /^image\/(png|jpe?g|bmp|tiff?|webp)/i;

/**
 * Characters an OCR pass commonly confuses for a hex digit in a rendered monospace string, mapped
 * to the digit they should be. Applied only inside a `VISUALPING{...}` frame, so the correction
 * cannot fabricate a match out of ordinary text.
 */
const HEX_LOOKALIKES: Record<string, string> = {
  l: '1',
  i: '1',
  I: '1',
  '|': '1',
  o: '0',
  O: '0',
  s: '5',
  S: '5',
  B: '8',
  z: '2',
  Z: '2',
  g: '9',
  G: '6',
};

const PASSWORD_FRAME = /VISUALPING\{([^}]{10,40})\}/g;

/**
 * Rewrites password frames whose interior is *almost* hex into valid hex, fixing the digit-shaped
 * letters an OCR pass produces (`VISUALPING{elc2...}` → `VISUALPING{e1c2...}`).
 *
 * Deliberately conservative: it only rewrites a frame when, after stripping whitespace, the
 * interior is exactly sixteen characters and every one is already hex or a known lookalike. Text
 * that is not a near-miss password is returned untouched, so a normalized view only ever adds a
 * genuinely recovered password.
 */
export function normalizeOcrHex(text: string): string {
  return text.replace(PASSWORD_FRAME, (whole, inner: string) => {
    const compact = inner.replace(/\s+/g, '');
    if (compact.length !== 16) return whole;

    let hex = '';
    for (const character of compact) {
      const mapped = /[0-9a-f]/.test(character) ? character : HEX_LOOKALIKES[character];
      if (!mapped) return whole;
      hex += mapped;
    }
    return `VISUALPING{${hex}}`;
  });
}

/** One artifact's OCR result: the raw text tesseract read from the image. */
export interface OcrResult {
  text: string;
}

/**
 * Runs OCR over the image artifacts among `inputs`, returning a map from content hash to the text
 * found. Results are cached to `cachePath` by content hash, so the expensive recognition runs once
 * per distinct image no matter how often the analysis is repeated.
 *
 * OCR failures are swallowed: a missing model or an unreadable image leaves that artifact without
 * OCR text rather than aborting the whole analysis. The caller treats absence as "no text found".
 */
export async function ocrImages(
  inputs: Array<{ contentType: string | null; body: Buffer }>,
  cachePath: string,
): Promise<Map<string, OcrResult>> {
  const images = inputs
    .filter((input) => OCR_IMAGE_TYPES.test(input.contentType ?? ''))
    .map((input) => ({ hash: sha256Hex(input.body), body: input.body }));

  const cache = await loadCache(cachePath);
  const pending = dedupeByHash(images).filter((image) => !cache.has(image.hash));

  if (pending.length > 0) {
    const worker = await createWorker('eng');
    try {
      for (const image of pending) {
        cache.set(image.hash, { text: await recognize(worker, image.body) });
      }
    } finally {
      await worker.terminate();
    }
    await saveCache(cachePath, cache);
  }

  return cache;
}

async function recognize(worker: Worker, body: Buffer): Promise<string> {
  try {
    const { data } = await worker.recognize(body);
    return data.text;
  } catch {
    return '';
  }
}

function dedupeByHash(images: Array<{ hash: string; body: Buffer }>): Array<{ hash: string; body: Buffer }> {
  const seen = new Map<string, { hash: string; body: Buffer }>();
  for (const image of images) if (!seen.has(image.hash)) seen.set(image.hash, image);
  return [...seen.values()];
}

async function loadCache(cachePath: string): Promise<Map<string, OcrResult>> {
  try {
    const raw = JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, OcrResult>;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

async function saveCache(cachePath: string, cache: Map<string, OcrResult>): Promise<void> {
  const asObject = Object.fromEntries(cache);
  await writeFile(cachePath, `${JSON.stringify(asObject, null, 2)}\n`, 'utf8');
}
