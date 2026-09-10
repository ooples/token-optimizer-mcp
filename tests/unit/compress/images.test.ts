import { describe, it, expect } from '@jest/globals';
import {
  describeImage,
  dedupImages,
  imageSize,
  isImageBlock,
} from '../../../src/compress/images.js';
import { v1Frontier } from '../../../src/compress/strategy.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

/**
 * Images, which every walker in this package used to step straight over.
 *
 * The cost is not marginal: an Anthropic image is roughly `width * height /
 * 750` tokens, so a 1456x816 screenshot is about 1,585 -- and it is re-sent as
 * conversation history on every later turn. A browser-driving agent sends the
 * same screenshot repeatedly, which is exactly the shape text dedup already
 * handles for tool output.
 */

/**
 * A real PNG header, built byte by byte.
 *
 * The signature and IHDR are constructed rather than pasted from a fixture, so
 * the test proves the parser reads the format instead of proving it recognises
 * one particular blob.
 */
function png(width: number, height: number, padding = 4000): string {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0x89504e47, 0); // PNG signature, first half
  header.writeUInt32BE(0x0d0a1a0a, 4); // and second
  header.writeUInt32BE(13, 8); // IHDR length
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  // Padding stands in for the compressed image data, so the block is big
  // enough to be worth a back-reference.
  return Buffer.concat([header, Buffer.alloc(padding, 7)]).toString('base64');
}

/** A minimal JPEG: SOI, then an SOF0 carrying the dimensions. */
function jpeg(width: number, height: number, padding = 4000): string {
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffd8, 0); // SOI
  sof.writeUInt16BE(0xffc0, 2); // SOF0
  sof.writeUInt16BE(8, 4); // segment length
  sof.writeUInt8(8, 6); // precision
  sof.writeUInt16BE(height, 7);
  sof.writeUInt16BE(width, 9);
  return Buffer.concat([sof, Buffer.alloc(padding, 7)]).toString('base64');
}

const imageBlock = (data: string, mediaType = 'image/png') => ({
  type: 'image',
  source: { type: 'base64', media_type: mediaType, data },
});

describe('recognising an image', () => {
  it('accepts a base64 image block and rejects everything else', () => {
    expect(isImageBlock(imageBlock(png(10, 10)))).toBe(true);
    expect(isImageBlock({ type: 'text', text: 'hello' })).toBe(false);
    expect(isImageBlock({ type: 'image' })).toBe(false);
    expect(isImageBlock({ type: 'image', source: { type: 'url' } })).toBe(false);
    expect(isImageBlock(null)).toBe(false);
  });
});

describe('reading dimensions from the header', () => {
  it('reads a PNG', () => {
    expect(imageSize(png(1456, 816))).toEqual({ width: 1456, height: 816 });
  });

  it('reads a JPEG', () => {
    expect(imageSize(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('reads a GIF', () => {
    const gif = Buffer.alloc(10);
    gif.write('GIF89a', 0, 'ascii');
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(200, 8);
    expect(imageSize(gif.toString('base64'))).toEqual({
      width: 320,
      height: 200,
    });
  });

  it('declines rather than guessing on a format it does not know', () => {
    // A wrong estimate is worse than none: it would be reported as a saving.
    expect(imageSize(Buffer.from('not an image at all').toString('base64'))).toBeNull();
    expect(imageSize('')).toBeNull();
  });

  it('does not spin on a truncated JPEG', () => {
    // This runs on the request path, so a malformed file must terminate.
    const broken = Buffer.alloc(64);
    broken.writeUInt16BE(0xffd8, 0);
    broken.writeUInt16BE(0xffe0, 2);
    broken.writeUInt16BE(0, 4); // a zero-length segment would loop forever
    expect(imageSize(broken.toString('base64'))).toBeNull();
  });
});

describe('costing an image', () => {
  it('estimates tokens from the pixel count', () => {
    // 1456x816 / 750 -- the figure a screenshot actually costs.
    const described = describeImage(imageBlock(png(1456, 816)));
    expect(described?.tokens).toBe(Math.ceil((1456 * 816) / 750));
  });

  it('says it does not know rather than inventing a number', () => {
    const described = describeImage(
      imageBlock(Buffer.from('mystery bytes').toString('base64'))
    );
    expect(described?.tokens).toBeNull();
    expect(described?.width).toBeNull();
  });
});

describe('dedupImages', () => {
  it('keeps the first copy and references it from the second', () => {
    const data = png(1456, 816);
    const out = dedupImages([
      { block: imageBlock(data), touchable: true },
      { block: imageBlock(data), touchable: true },
    ]);
    expect(out.replacements[0]).toBeNull();
    expect(out.replacements[1]).toContain('already shown above');
    expect(out.collapsed).toBe(1);
    expect(out.tokensSaved).toBe(Math.ceil((1456 * 816) / 750));
  });

  it('leaves two different images alone', () => {
    const out = dedupImages([
      { block: imageBlock(png(800, 600)), touchable: true },
      { block: imageBlock(png(1024, 768)), touchable: true },
    ]);
    expect(out.collapsed).toBe(0);
    expect(out.replacements).toEqual([null, null]);
  });

  it('never rewrites an untouchable repeat', () => {
    // Behind the cache frontier or inside a signed message: rewriting it
    // breaks the cache it is sitting in.
    const data = png(800, 600);
    const out = dedupImages([
      { block: imageBlock(data), touchable: true },
      { block: imageBlock(data), touchable: false },
    ]);
    expect(out.replacements[1]).toBeNull();
    expect(out.collapsed).toBe(0);
  });

  it('references a cached copy from a fresh one, which is the best case', () => {
    // The first copy is untouchable, so it arrives byte-identical and is the
    // strongest referent there is.
    const data = png(1456, 816);
    const out = dedupImages([
      { block: imageBlock(data), touchable: false },
      { block: imageBlock(data), touchable: true },
    ]);
    expect(out.replacements[0]).toBeNull();
    expect(out.replacements[1]).toContain('already shown above');
  });

  it('ignores an image too small to be worth a reference', () => {
    const tiny = png(4, 4, 10);
    const out = dedupImages([
      { block: imageBlock(tiny), touchable: true },
      { block: imageBlock(tiny), touchable: true },
    ]);
    expect(out.collapsed).toBe(0);
  });
});

describe('through v1, where an image block used to be invisible', () => {
  const screenshot = png(1456, 816);

  const session = (): ProviderRequest => ({
    system: 'You are a browser agent.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'take a look', cache_control: { type: 'ephemeral' } },
        ],
      },
      {
        role: 'user',
        content: [
          imageBlock(screenshot),
          { type: 'text', text: 'and again after the click' },
          imageBlock(screenshot),
        ],
      },
    ],
  });

  it('collapses the repeated screenshot and leaves the first whole', () => {
    const out = v1Frontier(session(), {});
    const content = out.request.messages?.[1].content;
    const blocks = Array.isArray(content) ? content : [];

    expect(blocks[0].type).toBe('image');
    expect(blocks[2].type).toBe('text');
    expect(String(blocks[2].text)).toContain('1456x816');
  });

  it('reports it as a lossless elision, because the image is still above', () => {
    const out = v1Frontier(session(), {});
    const elision = out.elisions.find((e) => e.removed.includes('repeated image'));
    expect(elision).toBeDefined();
    expect(elision?.lossless).toBe(true);
    expect(elision?.recoverAt).toBeNull();
  });

  it('makes the request materially smaller', () => {
    const before = JSON.stringify(session()).length;
    const after = JSON.stringify(v1Frontier(session(), {}).request).length;
    // A whole screenshot removed, not a rounding.
    expect(before - after).toBeGreaterThan(3000);
  });

  it('leaves a lone screenshot untouched', () => {
    // Nothing to reference, so nothing is done -- and the image must survive.
    const single: ProviderRequest = {
      messages: [{ role: 'user', content: [imageBlock(screenshot)] }],
    };
    const content = v1Frontier(single, {}).request.messages?.[0].content;
    expect(Array.isArray(content) ? content[0].type : '').toBe('image');
  });
});
