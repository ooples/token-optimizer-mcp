import { describe, it, expect } from '@jest/globals';
import { v1Frontier } from '../../../src/compress/strategy.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

/**
 * A stamp the caller picked has to reach every marker, including the two kinds
 * of back-reference that are written outside the router.
 *
 * `withStamp` says every engine entry point honours `ctx.stamp` and that `null`
 * means `do not stamp`. That was false on two paths: the text dedup pass and
 * the image dedup pass each minted a key over the content unconditionally,
 * because they are reached from the strategies rather than through the router.
 * Nothing noticed, because the key is a MAC over a secret minted once per
 * process, so within one process a mint and a pin are equally stable -- the
 * divergence only shows up between two runs, which no test compared.
 *
 * It mattered twice. A caller passing `null` to mean `emit markers nothing will
 * honour` got honourable markers anyway, and the comparator could not reproduce
 * a run: 206 of its measured strings differed every time, invisibly, because
 * the random field is fixed-width and the old currency divided characters by
 * four.
 *
 * So each case below asserts on BOTH marker families, and the mint case is the
 * control: without it, a `stamp` option that was being dropped on the floor
 * would satisfy the `null` case by accident and the pin case would be the only
 * thing left to fail.
 */

/** A real PNG header, so the image pass recognises the format. */
function png(width: number, height: number): string {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0x89504e47, 0);
  header.writeUInt32BE(0x0d0a1a0a, 4);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(4000, 7)]).toString('base64');
}

const imageBlock = (data: string) => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data },
});

/** Long enough that a repeat is worth pointing at rather than keeping. */
const PAYLOAD = Array.from(
  { length: 60 },
  (_, i) => `export const symbol${i} = { id: ${i}, label: 'row ${i}' };`
).join('\n');

/**
 * The same screenshot and the same tool output, sent twice.
 *
 * BYTE-IDENTICAL ON PURPOSE. A back-reference is what this file is about, and
 * the pass only writes one for a block it has already seen -- two blocks that
 * merely share a payload are two different blocks.
 */
function repeated(): ProviderRequest {
  const shot = png(1456, 816);
  const text = () => ({ type: 'text', text: PAYLOAD });
  return {
    messages: [
      { role: 'user', content: [text(), imageBlock(shot)] },
      { role: 'assistant', content: [{ type: 'text', text: 'looking' }] },
      { role: 'user', content: [text(), imageBlock(shot)] },
    ],
  } as ProviderRequest;
}

/** Every marker in the rewritten request, both families. */
function markers(request: ProviderRequest): string[] {
  const found: string[] = [];
  for (const message of request.messages ?? []) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const text = (block as { text?: unknown }).text;
      if (typeof text !== 'string') continue;
      for (const match of text.matchAll(/\[\.\.\. [^\]]*\]/g))
        found.push(match[0]);
    }
  }
  return found;
}

/** Split by family, so a case cannot pass on one and be silent on the other. */
const images = (all: string[]) => all.filter((m) => m.includes('image'));
const texts = (all: string[]) => all.filter((m) => !m.includes('image'));

describe('a stamp the caller pinned', () => {
  it('is minted per block when the caller says nothing', () => {
    // THE CONTROL ARM. Both families must be present and stamped here, or the
    // two cases below are assertions about markers that were never written.
    const all = markers(v1Frontier(repeated(), {}).request);

    expect(texts(all).length).toBeGreaterThan(0);
    expect(images(all).length).toBeGreaterThan(0);
    for (const marker of all) expect(marker).toMatch(/ ~[0-9]{9}\]$/);
    // Minted over the content, so it is not the pin the next case asks for.
    for (const marker of all) expect(marker).not.toContain('~481729503');
  });

  it('reaches both back-reference families', () => {
    const all = markers(v1Frontier(repeated(), { stamp: '481729503' }).request);

    expect(texts(all).length).toBeGreaterThan(0);
    expect(images(all).length).toBeGreaterThan(0);
    for (const marker of all) expect(marker).toContain(' ~481729503]');
  });

  it('is omitted entirely when the caller passes null', () => {
    const all = markers(v1Frontier(repeated(), { stamp: null }).request);

    expect(texts(all).length).toBeGreaterThan(0);
    expect(images(all).length).toBeGreaterThan(0);
    // A caller who means `do not stamp` wants markers a decoder refuses, which
    // is what the comparator publishes as the arm a reader cannot expand.
    for (const marker of all) expect(marker).not.toMatch(/ ~[^\]]+\]$/);
  });
});
