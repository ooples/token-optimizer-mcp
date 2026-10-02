import {
  MARKER_SHAPED,
  pathRefusals,
  recoverable,
  refusals,
} from '../../bench/compression/recovery.mjs';
import { compressBody } from '../../bench/compression/ours-engine.mjs';
import { compressSearchResults } from '../../dist/compress/search.js';

/**
 * THE GATE ON THE INSTRUMENT BEHIND EVERY CONSERVATION COLUMN.
 *
 * `recoverable` is what the head-to-head means by "the reader can still get
 * this back": every conservation and retention figure is the difference between
 * what is in the output and what this function rebuilds from it. It had no test
 * of its own -- the file was split out of the sweep so that it could have one --
 * and it was silently measuring a crippled decoder.
 *
 * WHY IT WAS CRIPPLED. Every marker grammar is authenticated: the encoder
 * derives a key per block and writes it into each marker it emits, and the
 * decoder honours only markers that verify, so a line of CONTENT shaped like a
 * marker is content. The oracle called the decoder with no key at all. A key
 * is not optional there, it is the difference between a decoder and a passthrough,
 * and an oracle that rebuilds nothing reports losses the product does not have.
 *
 * So the control arm here is the keyless one, and it has to come out WORSE. A
 * test that only asserted "the keyed arm rebuilds the input" passed before the
 * keys were threaded through, because the first copy of a deduplicated block is
 * still in the output verbatim.
 */

/** Two blocks over every floor, with a first line of their own. */
function block(tag) {
  const rows = [];
  for (let i = 0; i < 200; i++)
    rows.push(
      `${tag} row ${i} :: value ${i * 7} :: ${'payload-'.repeat(6)}${i}`
    );
  return rows.join('\n');
}

/**
 * A request whose third block repeats its first, which is what earns a
 * back-reference -- the grammar whose forgery vector the keys exist to close.
 */
function compressed() {
  const alpha = block('alpha');
  const beta = block('beta');
  const request = {
    model: 'claude-opus-5',
    messages: [
      { role: 'user', content: [{ type: 'text', text: alpha }] },
      { role: 'assistant', content: [{ type: 'text', text: beta }] },
      { role: 'user', content: [{ type: 'text', text: alpha }] },
    ],
  };
  const result = compressBody(Buffer.from(JSON.stringify(request), 'utf8'), {});
  return {
    alpha,
    keys: result.stamps ?? [],
    text: result.body.toString('utf8'),
    compressed: result.summary.compressed,
  };
}

describe('the recovery oracle', () => {
  beforeEach(() => {
    refusals.clear();
    pathRefusals.clear();
  });

  it('rebuilds more with the keys than without them', () => {
    const { keys, text, compressed: didCompress } = compressed();
    // THE FIXTURE HAS TO HAVE BEEN COMPRESSED AND HAVE A MARKER IN IT, or both
    // arms below measure an uncompressed payload and agree for the wrong reason.
    expect(didCompress).toBe(true);
    expect(MARKER_SHAPED.test(text)).toBe(true);
    expect(keys.filter((k) => typeof k === 'string').length).toBeGreaterThan(0);

    const keyed = recoverable(text, 'keyed', keys).length;
    const keyless = recoverable(text, 'keyless', []).length;
    expect(keyed).toBeGreaterThan(keyless);
  });

  it('gives the eliminated block back when it holds the keys', () => {
    const { alpha, keys, text } = compressed();
    // The repeat was really eliminated, so finding it again is the decoder's
    // work and not the output's leftovers.
    expect(text.split(alpha.slice(0, 40)).length - 1).toBeLessThan(3);
    expect(recoverable(text, 'keyed', keys)).toContain(alpha);
  });

  it('names no refusal on output it produced itself', () => {
    const { keys, text } = compressed();
    recoverable(text, 'keyed', keys);
    // A refusal here is the oracle reporting that OUR OWN decoder would not
    // read our own output, which is either a real defect or a mis-addressed
    // harness -- and both of those have reached the gap list before.
    expect([...refusals.entries()]).toEqual([]);
  });

  it('finds the key in a search header, which closes on no bracket', () => {
    /*
     * THE OTHER WAY THE ORACLE CAN LOSE ITS KEY. Every other grammar's marker
     * ends `~key]`, so the scan was anchored on that bracket. A search header
     * is not an envelope: `src/a.ts:11-18 ~h5nq2x` ends AT the key. Anchored
     * on a bracket the scan found nothing on the grep fixture and scored a
     * fully recoverable block as a total loss.
     */
    const hits = [];
    for (let i = 1; i <= 8; i++)
      hits.push(`src/a.ts:${10 + i}:  const value${i} = compute(${i});`);
    const input = hits.join('\n');
    const out = compressSearchResults(input);
    expect(out.text).not.toBe(input);
    const found = recoverable(out.text, 'search', out.stamp);
    expect(found).toContain('const value8 = compute(8);');
    // And the keyless control, which must come out worse: without the key the
    // header is a line of text and the body lines keep no path or number.
    const blind = recoverable(out.text, 'search-blind', []);
    expect(blind.length).toBeLessThan(found.length);
  });

  it('accepts a single key as well as a list', () => {
    const { keys, text } = compressed();
    // The document arms hand over `out.stamp`, one key for the whole text; the
    // body arm hands over an array. Both callers are in `head-to-head.mjs`, so
    // the shape is not an abstraction looking for a user.
    const first = keys.find((k) => typeof k === 'string');
    expect(recoverable(text, 'one', first).length).toBeGreaterThan(0);
  });

  it("ignores a key that is not one of the producer's keys", () => {
    const { keys, text } = compressed();
    const foreign = 'zzzzzz';
    expect(keys).not.toContain(foreign);
    // A marker ends on the key its own encoder wrote, so a key from somewhere
    // else resolves nothing. This is the property that makes picking each
    // fragment's key out of the fragment safe rather than a widening: the
    // oracle cannot talk itself into reading a marker it did not write.
    expect(recoverable(text, 'foreign', foreign).length).toBe(
      recoverable(text, 'none', []).length
    );
  });
});
