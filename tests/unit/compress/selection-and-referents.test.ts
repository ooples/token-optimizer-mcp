import { describe, it, expect } from '@jest/globals';
import { compressBlock } from '../../../src/compress/router.js';
import { dedupBlocks } from '../../../src/compress/dedup.js';
import type { DedupBlock } from '../../../src/compress/dedup.js';
import { DEFAULT_TUNING } from '../../../src/compress/options.js';

/**
 * THE ENCODER IS TESTED; THE CHOICE OF ENCODER IS NOT.
 *
 * `json-fragments.test.ts` reconstructs `compressJsonArray` output byte for
 * byte, and it is a good test. It calls that engine directly, so it says
 * nothing about whether the router still REACHES it. Measured: prefixing
 * `false &&` to the guard at `json.ts:341` -- the line that prefers the exact
 * record-template encoding -- left all 53 compress suites green while the
 * output silently fell back to minification, dropped from 72.9% to 30.4%, and
 * began canonicalising numbers.
 *
 * That is the shape of the gap this file closes. A regression in SELECTION
 * looks nothing like a regression in encoding: every engine still passes its
 * own tests, and the only visible symptom is a worse number in a benchmark
 * nobody reruns on a unit-test change.
 *
 * The second half covers `dedupBlocks`, whose referent is INSIDE the request.
 * That is what makes its elisions lossless with no path to recover from, and
 * it is exactly the claim worth holding to its word: a back-reference that
 * points at bytes which are not in the payload is not lossless, it is a dangling
 * pointer with a reassuring name.
 */

/** Hand-written, because JSON.stringify would normalise the lexemes away. */
function prettyRecords(n: number): string {
  const rows = [];
  for (let i = 0; i < n; i += 1)
    rows.push(
      [
        '  {',
        `    "id": "sensor-${i}",`,
        `    "raw": ${['1.0', '2.50', '0.1', '3.000'][i % 4]},`,
        `    "note": "channel ${i} calibrated",`,
        '    "spare": null',
        '  }',
      ].join('\n')
    );
  return `[\n${rows.join(',\n')}\n]`;
}

describe('the router still reaches the encoding it is supposed to', () => {
  it('a homogeneous pretty array takes the exact record-template path', () => {
    const input = prettyRecords(80);
    const result = compressBlock(input, { tuning: DEFAULT_TUNING });

    expect(result.lossless).toBe(true);

    // THE MARKER IS THE TELL, not the ratio. Asserting only on a reduction
    // threshold would pass on minification too, which is the very fallback
    // this test exists to notice.
    expect(result.text).toContain('records preserved');
    expect(result.text).toContain('verbatim text fragments');

    // The exact path is chosen because it is much smaller. If selection
    // regresses to minification the output roughly doubles, so this bound
    // fails as well -- two independent ways to notice one defect.
    expect(result.text.length).toBeLessThan(input.length * 0.45);

    // And the property the exact path exists to preserve: values ride as
    // verbatim text, so a lexeme the parser would rewrite survives.
    for (const lexeme of ['1.0', '2.50', '3.000'])
      expect(result.text).toContain(lexeme);
  });

  it('the fallback is still correct when the exact path does not apply', () => {
    // A positive control. Without it, "the exact marker is present" could be
    // satisfied by an engine that emitted it unconditionally, and a shape that
    // legitimately minifies would have no cover at all.
    const config = [
      '{',
      '  "service": "checkout",',
      '  "timeoutSeconds": 30.0,',
      '  "errorBudget": 0.0500,',
      '  "limits": { "cpu": "500m", "memory": "512Mi" },',
      '  "owner": null',
      '}',
    ].join('\n');

    const result = compressBlock(config, { tuning: DEFAULT_TUNING });
    expect(result.text.length).toBeLessThan(config.length);
    expect(result.text).not.toContain('records preserved');
    // Still valid JSON carrying the same values -- the fallback is a real
    // saving, not a broken document. Whether it preserves number SOURCE
    // TEXT is #418's question and is gated there, not here.
    expect(JSON.stringify(JSON.parse(result.text))).toBe(
      JSON.stringify(JSON.parse(config))
    );
  });
});

describe('a dedup back-reference points at bytes that are present', () => {
  const body = (seed: string) =>
    Array.from(
      { length: 40 },
      (_, i) => `${seed} line ${i}: the scheduler renewed its lease`
    ).join('\n');

  const block = (text: string, touchable = true): DedupBlock => ({
    text,
    original: text,
    touchable,
  });

  it('every elided block is recoverable from one that survived', () => {
    const shared = body('alpha');
    const blocks = [
      block(shared),
      block(body('beta')),
      block(shared),
      block(body('gamma')),
      block(shared),
    ];

    const result = dedupBlocks(blocks);

    // An inert dedup satisfies any containment assertion by changing nothing.
    const rewritten = result.texts.filter((text, i) => text !== blocks[i].text);
    expect(rewritten.length).toBeGreaterThan(0);

    // THE REFERENT MUST BE IN THE PAYLOAD. A lossless elision here carries no
    // recoverAt, so the only thing that can make it recoverable is another
    // block in the same request still holding the bytes.
    const sharedAt = blocks
      .map((b, i) => (b.text === shared ? i : -1))
      .filter((i) => i >= 0);
    expect(sharedAt).toHaveLength(3);

    const kept = sharedAt.filter((i) => result.texts[i] === shared);
    const pointed = sharedAt.filter((i) => result.texts[i] !== shared);
    // Exactly one copy survives to be pointed at; the other two point at it.
    expect(kept).toHaveLength(1);
    expect(pointed).toHaveLength(2);

    // AND EACH ONE MUST NAME THE SHARED BLOCK, NOT MERELY SOMETHING.
    // Asserting only that one raw copy survived is satisfied by an
    // implementation that keeps blocks[0] and points a shared duplicate at
    // beta instead, which is a different block of the same size.
    expect(result.texts[pointed[0]]).toContain(
      `shown above: "${shared.slice(0, 40)}..." (#1)`
    );
    expect(result.texts[pointed[1]]).toContain('as #1 above');

    // Both halves, of every elision. The conditional form this replaces --
    // lossless ? expect null : expect not-null -- is satisfied by a regression
    // that sets lossless: false AND a non-null recoverAt, which is precisely
    // the state a local duplicate reference must never be in.
    expect(result.elisions.length).toBeGreaterThan(0);
    for (const elision of result.elisions) {
      expect(elision.lossless).toBe(true);
      expect(elision.recoverAt).toBeNull();
    }
  });

  it('an untouchable block is never rewritten', () => {
    // Content behind the cache frontier, or a signed message, must stay
    // byte-identical -- rewriting it costs more than it saves and can break a
    // signature outright.
    const shared = body('delta');
    const blocks = [block(shared), block(shared, false), block(shared)];

    const result = dedupBlocks(blocks);
    expect(result.texts[1]).toBe(shared);
  });
});
