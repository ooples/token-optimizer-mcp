import { describe, expect, it } from '@jest/globals';
import {
  expandLongRepeats,
  foldLongRepeats,
  hasFoldedRuns,
} from '../../../src/compress/runs.js';
import { compressBlock } from '../../../src/compress/router.js';
import { rehydrate } from '../../../src/compress/rehydrate.js';

/**
 * A body with no repeat in it.
 *
 * DELIBERATELY NOT PERIODIC. A fixture built by repeating one string would be
 * folded by this pass for a reason that has nothing to do with what the test
 * is asking, and the test would pass whatever the code did.
 *
 * LEHMER, NOT THE TEXTBOOK POWER-OF-TWO LCG. The first version of this used a
 * modulus of 2^31 and took the remainder by 90, and the low bits of that
 * generator cycle every few hundred steps: 30,000 characters of supposed noise
 * held a repeat long enough to fold, so the test that asks for a decline
 * failed against correct code. A prime modulus has no such short cycle.
 */
const FENCE_CHAR = '`';

function noise(bytes: number, seed: number): string {
  const out: string[] = [];
  let state = (seed % 2_147_483_646) + 1;
  while (out.length < bytes) {
    state = (state * 48_271) % 2_147_483_647;
    // EVERY PRINTABLE CHARACTER BUT THE BACKTICK, so a fixture carries the
    // quotes and backslashes a serialised document is full of -- those are the
    // interesting ones -- while the one character that makes the pass decline
    // is left to the test that asks for that decline by name.
    const code = 33 + (state % 89);
    out.push(String.fromCharCode(code >= FENCE_CHAR.charCodeAt(0) ? code + 1 : code));
  }
  return out.join('');
}

describe('long repeat folding', () => {
  it('folds a run that is an exact repeat of one above it', () => {
    const blob = noise(6_000, 7);
    const input = `head ${blob} middle ${blob} tail`;

    const folded = foldLongRepeats(input);
    expect(folded).not.toBeNull();
    if (folded === null) return;

    // THE FLOOR IS ONE COPY, NOT HALF THE INPUT. The surviving copy is what
    // the marker points at, so it cannot go; the most this pass can remove is
    // the second copy and its two delimiters. `input.length / 2` is 6,009
    // here and the floor is 6,016 before the marker is even written, so that
    // bar was unreachable by any correct implementation. Pinning the output
    // to within 200 characters of the floor asks the stronger question: that
    // the second copy went entirely, not merely that most of it did.
    expect(folded.text.length).toBeLessThan(blob.length + 200);
    expect(folded.lossless).toBe(true);
    expect(expandLongRepeats(folded.text)).toBe(input);
  });

  it('leaves a block with no long repeat exactly as it found it', () => {
    expect(foldLongRepeats(noise(30_000, 11))).toBeNull();
  });

  it('declines a repeat too short to pay for its marker', () => {
    const blob = noise(600, 3);
    expect(foldLongRepeats(`${noise(9_000, 5)}${blob}|${blob}`)).toBeNull();
  });

  it('resolves a repeat whose opening matches several copies above', () => {
    // THE CASE THAT USED TO BE REFUSED. Three copies share an opening, so no
    // prefix of the run names one of them -- and none needs to, because all
    // three are the same bytes. Requiring uniqueness here silently gave up the
    // fold on exactly the payload this pass was written for.
    const blob = noise(5_000, 13);
    const input = `a ${blob} b ${blob} c ${blob} d`;

    const folded = foldLongRepeats(input);
    expect(folded).not.toBeNull();
    if (folded === null) return;

    expect(expandLongRepeats(folded.text)).toBe(input);
    expect(folded.text.length).toBeLessThan(input.length / 2);
  });

  it('refuses a marker naming a run that is not above it', () => {
    const marker =
      '[... 4,000 bytes, an exact repeat of the run opening `nothing up here matches this` above]';
    expect(() => expandLongRepeats(marker)).toThrow(/names no run above/);
  });

  it('refuses a length that runs off the end of what it rebuilt', () => {
    const quote = 'a stated opening that is long enough';
    const marker = `${quote}\n[... 900,000 bytes, an exact repeat of the run opening \`${quote}\` above]`;
    expect(() => expandLongRepeats(marker)).toThrow(/past its source/);
  });

  it('leaves a document that parsed still parsing', () => {
    // THE CHECK THE BYTE-FOR-BYTE ONE CANNOT MAKE. A serialised request is a
    // document whose quoting has already happened, so a marker carrying a raw
    // `"` ends the string it lands in and the document stops parsing -- while
    // reading exactly the same bytes back. Three comparator payloads did that
    // before the delimiter moved to a backtick.
    const blob = noise(9_000, 23);
    const payload = JSON.stringify({
      messages: [{ text: blob }, { text: blob }],
    });
    const folded = foldLongRepeats(payload);
    expect(folded).not.toBeNull();
    if (folded === null) return;

    // THE MARKER, NOT THE DOCUMENT. The document is JSON and is made of
    // quotes; what must carry none is the text this pass writes into it.
    const marker = /\[\.\.\. [\s\S]*? above]/.exec(folded.text)?.[0] ?? '';
    expect(marker).not.toBe('');
    expect(marker).not.toContain('"');
    expect(() => JSON.parse(folded.text) as unknown).not.toThrow();
    expect(expandLongRepeats(folded.text)).toBe(payload);
  });

  it('declines an opening it cannot delimit', () => {
    // A BACKTICK IN THE OPENING IS A REFUSAL, NOT AN ESCAPE. Escaping it would
    // need a backslash, which is the other character that cannot be written
    // raw into a document that is already escaped, so the pass gives the fold
    // up instead of inventing a second grammar to get it back.
    const blob = `${FENCE_CHAR}${noise(9_000, 29)}`;
    const folded = foldLongRepeats(`head ${blob} middle ${blob} tail`);
    expect(folded).toBeNull();
  });

  it('reads back through the router and the shared decoder', () => {
    // END TO END, because the fold is the last thing the encoder does and the
    // first thing `rehydrate` undoes. Getting that order wrong hands the other
    // grammars a block with a hole in it, and the failure is silent.
    const record = (n: number) =>
      `{"id":${n},"payload":"${noise(400, n + 1)}"}`;
    const half = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(record).join('\n');
    const input = `${half}\n${half}`;

    const out = compressBlock(input, {});
    expect(hasFoldedRuns(out.text)).toBe(true);
    expect(out.lossless).toBe(true);
    expect(rehydrate(out.text)).toBe(input);
  });

  it('never folds inside a nested string, where the fold could not be read back', () => {
    const blob = noise(6_000, 23);
    const inner = `${blob} and again ${blob}`;
    const nested = compressBlock(inner, { stringDepth: 1 });
    expect(hasFoldedRuns(nested.text)).toBe(false);
  });
});
