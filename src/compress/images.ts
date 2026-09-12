/**
 * Images, which until now were invisible to every part of this.
 *
 * THE HOLE. `mapBlocks` visits a block only when `typeof block.text ===
 * 'string'`, so an image block was never classified, never compressed, never
 * deduplicated and never even counted. That is not a small omission: an
 * Anthropic image costs roughly `width * height / 750` tokens, so one
 * 1456x816 screenshot is about 1,585 tokens -- more than the entire knowledge
 * block -- and it is re-sent as conversation history on every subsequent turn
 * for the rest of the session.
 *
 * A BROWSER-DRIVING AGENT SENDS THE SAME SCREENSHOT REPEATEDLY, and that is
 * the case worth catching. Take a screenshot, act, take another, compare;
 * navigate back, screenshot again. Identical bytes, paid for each time. Text
 * dedup already handles the analogous case for tool output, and the argument
 * transfers exactly: the referent is inside the same request, so a
 * back-reference cannot miss the way a hash into an external cache can.
 *
 * WHAT IS NOT DONE HERE, and why. Re-encoding or downscaling an image needs a
 * codec, and every usable one is a heavy native dependency -- which is
 * precisely the "incompatible with restricted sandboxes" problem this project
 * exists to avoid having. So resizing is an OPTIONAL hook a caller may supply,
 * and the default is to leave the pixels alone. Dedup and accounting need no
 * dependency at all, and they are where the repeated-screenshot money is.
 *
 * DIMENSIONS ARE READ FROM THE HEADER, not by decoding. PNG puts width and
 * height in the IHDR chunk at a fixed offset; JPEG carries them in the first
 * SOFn marker. Both are a few dozen bytes in, so the cost is parsing a header
 * rather than rasterising an image, and an unrecognised format simply declines
 * to estimate rather than guessing.
 */

/** An image found in a request, with where it was and what it costs. */
export interface ImageBlock {
  /** The base64 payload, which is also its identity. */
  readonly data: string;
  readonly mediaType: string;
  /** Estimated tokens, or null when the header was not recognised. */
  readonly tokens: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

/**
 * Anthropic's documented cost for an image.
 *
 * `width * height / 750`, from their vision guidance. An estimate, and used
 * only for reporting and for deciding whether a saving is worth announcing --
 * never for a correctness decision, so being a little off is affordable.
 */
const PIXELS_PER_TOKEN = 750;

/** Below this an image is not worth a back-reference. */
export const MIN_DEDUP_IMAGE_CHARS = 1000;

/** Is this content block an image, in either shape a provider accepts? */
export function isImageBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const b = block as Record<string, unknown>;
  if (b.type !== 'image') return false;
  const source = b.source as Record<string, unknown> | undefined;
  return Boolean(source && typeof source.data === 'string');
}

/** PNG: width and height are big-endian 32-bit at offsets 16 and 20. */
function pngSize(bytes: Buffer): [number, number] | null {
  if (bytes.length < 24) return null;
  if (bytes.readUInt32BE(0) !== 0x89504e47) return null;
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

/**
 * JPEG: walk the markers to the first SOFn, which carries the dimensions.
 *
 * Bounded by the buffer length and by a segment count, because a truncated or
 * hostile file must not spin here -- this runs on the request path.
 */
function jpegSize(bytes: Buffer): [number, number] | null {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return null;
  let at = 2;
  for (
    let segments = 0;
    segments < 128 && at + 9 < bytes.length;
    segments += 1
  ) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    // SOF0..SOF15, excluding the non-frame markers at C4, C8 and CC.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return [bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5)];
    }
    const length = bytes.readUInt16BE(at + 2);
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

/** GIF: little-endian 16-bit width and height at offset 6. */
function gifSize(bytes: Buffer): [number, number] | null {
  if (bytes.length < 10) return null;
  if (bytes.toString('ascii', 0, 3) !== 'GIF') return null;
  return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
}

/**
 * Reads an image's dimensions from its header.
 *
 * Only the first kilobyte is decoded, which is far more than any of these
 * headers needs and avoids materialising a multi-megabyte buffer to read six
 * bytes out of it.
 */
export function imageSize(
  data: string
): { width: number; height: number } | null {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(data.slice(0, 1400), 'base64');
  } catch {
    return null;
  }
  const size = pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes);
  if (!size) return null;
  const [width, height] = size;
  if (!width || !height || width > 100_000 || height > 100_000) return null;
  return { width, height };
}

/** What one image block costs, as far as we can tell. */
export function describeImage(block: unknown): ImageBlock | null {
  if (!isImageBlock(block)) return null;
  const source = (block as Record<string, unknown>).source as Record<
    string,
    unknown
  >;
  const data = source.data as string;
  const mediaType =
    typeof source.media_type === 'string' ? source.media_type : 'unknown';
  const size = imageSize(data);
  return {
    data,
    mediaType,
    width: size?.width ?? null,
    height: size?.height ?? null,
    tokens: size
      ? Math.ceil((size.width * size.height) / PIXELS_PER_TOKEN)
      : null,
  };
}

/** The back-reference that replaces a repeated image. */
export function imageBackReference(image: ImageBlock, ordinal: number): string {
  const size =
    image.width && image.height ? `${image.width}x${image.height} ` : '';
  const cost = image.tokens
    ? `, about ${image.tokens.toLocaleString('en-US')} tokens`
    : '';
  return `[... the same ${size}${image.mediaType} image already shown above (#${ordinal})${cost} -- not repeated here]`;
}

export interface ImageDedupResult {
  /** One entry per input block: the replacement, or null to keep as-is. */
  readonly replacements: readonly (string | null)[];
  /** Estimated tokens removed, for reporting. */
  readonly tokensSaved: number;
  /** How many repeats were collapsed. */
  readonly collapsed: number;
}

/**
 * Replaces repeated images with a reference to the copy already in the request.
 *
 * Same rules as text dedup, for the same reasons. The FIRST occurrence is
 * always kept whole because it is what every later reference points at, and an
 * untouchable block -- signed, or behind the cache frontier -- is never
 * rewritten but is still the strongest referent there is.
 *
 * Lossless: the image is still in the request, above, and the reference names
 * which one. There is nothing to look up and nothing to miss.
 */
export function dedupImages(
  blocks: readonly { readonly block: unknown; readonly touchable: boolean }[]
): ImageDedupResult {
  const seen = new Map<string, number>();
  const replacements: (string | null)[] = [];
  let tokensSaved = 0;
  let collapsed = 0;

  for (const { block, touchable } of blocks) {
    const image = describeImage(block);
    if (!image || image.data.length < MIN_DEDUP_IMAGE_CHARS) {
      replacements.push(null);
      continue;
    }

    const earlier = seen.get(image.data);
    if (earlier === undefined) {
      seen.set(image.data, seen.size + 1);
      replacements.push(null);
      continue;
    }
    if (!touchable) {
      replacements.push(null);
      continue;
    }

    replacements.push(imageBackReference(image, earlier));
    tokensSaved += image.tokens ?? 0;
    collapsed += 1;
  }

  return { replacements, tokensSaved, collapsed };
}
