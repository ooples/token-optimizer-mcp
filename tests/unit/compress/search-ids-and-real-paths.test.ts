import { compressSearchResults } from '../../../src/compress/search.js';
import { rehydrate } from '../../../src/compress/rehydrate.js';

/**
 * A minted path id, and a real path that looks like one.
 *
 * The encoder mints ids like the prefix plus a number for a path table, and
 * the decoder resolves anything shaped like one back through that table. Two
 * places got that boundary wrong, and both are reachable from ordinary ripgrep
 * output rather than a contrived input.
 */
describe('search path ids do not collide with real paths', () => {
  it('round-trips a scoped package path, which begins like an id', () => {
    // THE DEFECT. resolve() asked only whether the header path started with
    // the prefix, so every npm scoped path -- and ripgrep inside node_modules
    // reports nothing else -- was read as a table id and thrown on. A single
    // path mints no table, so the header carries the real path unchanged and
    // reaches that check.
    const input = Array.from(
      { length: 40 },
      (_, i) =>
        '@babel/parser/lib/index.js:' +
        (i + 1) +
        ':export const NODE_' +
        i +
        ' = ' +
        i * 7 +
        ';'
    ).join('\n');

    const result = compressSearchResults(input);
    expect(rehydrate(result.text, result.stamp)).toBe(input);
  });

  it('round-trips a line that is not a hit but reads as an id', () => {
    // THE SECOND DEFECT. The fold was refused when a HIT path looked like a
    // minted id, but the decoder resolves the table over every output line --
    // so an ordinary pass-through line beginning with an id and a colon came
    // back as whatever path that id names, and the result still reported
    // itself lossless.
    const input = ['@0:this line was never a hit', ...hits()].join('\n');

    const result = compressSearchResults(input);
    const back = rehydrate(result.text, result.stamp);

    expect(back).toBe(input);
    expect(back).toContain('@0:this line was never a hit');
  });

  it('control: the same hits without that line do fold into a table', () => {
    // Without this there is nothing to see: it proves the fixture really does
    // drive the fold, so the test above is not passing merely because the
    // encoder declined to fold for some unrelated reason.
    const folded = compressSearchResults(hits().join('\n'));
    expect(folded.text).toContain('[paths @0=');
  });
});

function hits(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 30; i++) {
    out.push('src/alpha.ts:' + (i + 1) + ':const alpha' + i + ' = ' + i + ';');
    out.push('src/beta.ts:' + (i + 1) + ':const beta' + i + ' = ' + i + ';');
  }
  return out;
}
