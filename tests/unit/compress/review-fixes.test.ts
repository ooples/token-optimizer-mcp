import { describe, it, expect } from '@jest/globals';
import { compressLog } from '../../../src/compress/log.js';
import { compressProse } from '../../../src/compress/prose.js';
import { compressSearchResults } from '../../../src/compress/search.js';
import { compressCode } from '../../../src/compress/code.js';
import { parse } from '@babel/parser';
import { runBatch } from '../../../src/compress/onnx.js';
import type {
  OnnxRuntime,
  OnnxSession,
  OnnxTensorLike,
} from '../../../src/compress/onnx.js';

/**
 * Defects found in review of the compression PR, each pinned by the case that
 * exposes it.
 *
 * Grouped here rather than scattered because they share a shape worth naming: a
 * transform that was CORRECT ABOUT WHAT IT REMOVED and wrong about what it
 * claimed. Three of the five reported `lossless: true` over content that could
 * not be reconstructed, one restored a context line as a match, and one elided
 * lines it never mentioned. None of them would have shown up in a size
 * benchmark -- every one of them made the number better.
 */

describe('log folding keeps the timestamps it removes', () => {
  const clocked = (n: number, text: string): string =>
    Array.from(
      { length: n },
      (_, i) => `12:00:${String(i).padStart(2, '0')} ${text}`
    ).join('\n');

  it('names every stamp it folded away', () => {
    // `foldKey` strips the clock so a line repeating once a second still folds
    // -- the whole reason this engine beats a naive one on the most repetitive
    // logs there are. The stamps were then simply gone, and the result still
    // said `lossless: true`. On a log, WHEN is often the question.
    const out = compressLog(clocked(9, 'connection pool warmed'));

    expect(out.text).toContain('12:00:01');
    expect(out.text).toContain('12:00:08');
    expect(out.elisions.some((e) => e.lossless)).toBe(true);
  });

  it('still folds, so honesty did not cost the compression', () => {
    const input = clocked(40, 'connection pool warmed and ready to serve');
    const out = compressLog(input);
    expect(out.text.length).toBeLessThan(input.length / 2);
  });

  it('spills instead of folding blind when listing costs more than it saves', () => {
    // A run of very short lines under long ISO stamps: listing them is more
    // expensive than the lines. The fold still happens, but it says it is lossy
    // and names where the original went.
    const terse = Array.from(
      { length: 30 },
      (_, i) => `2026-09-09T12:00:${String(i).padStart(2, '0')}.000Z ok`
    ).join('\n');
    const out = compressLog(terse, { spill: () => '/spill/log.txt' });

    expect(out.text).toContain('/spill/log.txt');
    expect(out.elisions.some((e) => !e.lossless && e.recoverAt)).toBe(true);
  });

  it('leaves the run whole when it can neither list nor spill', () => {
    // The honest last resort: no annotation it can afford, nowhere to put the
    // original, so nothing is removed.
    const terse = Array.from(
      { length: 30 },
      (_, i) => `2026-09-09T12:00:${String(i).padStart(2, '0')}.000Z ok`
    ).join('\n');
    const out = compressLog(terse);

    for (let i = 0; i < 30; i += 1) {
      expect(out.text).toContain(`12:00:${String(i).padStart(2, '0')}`);
    }
  });

  it('does not fold scattered duplicates it cannot place', () => {
    // A scattered fold removes lines from all over the file, so their
    // interleaving is lost too. With no timestamp there is no way to say where
    // a removed copy had been, and a marker that cannot be redeemed is the
    // thing this design exists to avoid.
    const unstamped = [
      'starting worker',
      'INFO cache warm',
      'starting worker',
      'INFO cache warm',
      'starting worker',
      'INFO queue drained',
      'starting worker',
      'INFO cache warm',
      'starting worker',
      'INFO queue drained',
    ].join('\n');
    const out = compressLog(unstamped);
    expect(out.text.split('starting worker').length - 1).toBe(5);
  });
});

describe('search restores a short hunk exactly', () => {
  /** Six hits so the block is claimed, with one isolated context line. */
  const grep = [
    'src/a.ts:1: const a = 1;',
    'src/a.ts:2: const b = 2;',
    'src/a.ts:3: const c = 3;',
    'src/a.ts:4: const d = 4;',
    'src/a.ts:5: const e = 5;',
    'src/a.ts:6: const f = 6;',
    'src/lonely.ts:11-  return 1;',
  ].join('\n');

  it('keeps a context line a context line', () => {
    // `-` means ripgrep matched a NEIGHBOUR, not this line. Restoring it as `:`
    // states that a line matched when it did not, which is the one distinction
    // this engine promises to preserve.
    const out = compressSearchResults(grep);
    expect(out.text).toContain('src/lonely.ts:11-  return 1;');
  });

  it('does not double the leading space', () => {
    // Group 4 of HIT begins immediately after the separator, so the line's own
    // indentation is already there. The restored line is pinned exactly rather
    // than only asserting the doubled form is absent -- a negative alone would
    // pass just as well if the line vanished or the call threw.
    const out = compressSearchResults(grep);
    const restored = out.text
      .split('\n')
      .find((line) => line.startsWith('src/lonely.ts:'));
    expect(restored).toBe('src/lonely.ts:11-  return 1;');
  });
});

describe('prose keeps its paragraphs', () => {
  const paragraphs = [
    'The service loads its configuration from disk at boot. It is worth noting that this is generally considered good practice.',
    'The connection pool is sized from the worker count. As we mentioned, callers should handle the error.',
    'Backpressure applies once the queue depth exceeds the high water mark. Needless to say, this is documented elsewhere.',
  ].join('\n\n');

  it('does not flatten a multi-paragraph document into one block', () => {
    // Joining survivors with a single space turned a design note into a wall of
    // text -- a structural change nobody asked for, on top of the sentence
    // elision that was the actual job.
    const out = compressProse(paragraphs, { spill: () => '/spill/prose.txt' });
    expect(out.text).toContain('\n\n');
  });

  it('still removes sentences, so structure did not cost the compression', () => {
    const out = compressProse(paragraphs, { spill: () => '/spill/prose.txt' });
    expect(out.text.length).toBeLessThan(paragraphs.length);
    expect(out.elisions).toHaveLength(1);
  });
});

describe('code spans stop at the last real line', () => {
  it('does not elide trailing blank lines or name them in the range', () => {
    // A blank line must not CLOSE a block -- a function with a blank line in
    // the middle is ordinary -- but letting it EXTEND one put the blanks after
    // a function inside the span, so the recovery range pointed at lines the
    // marker never claimed to have removed.
    const source = [
      'def handler(request):',
      '    trimmed = request.strip()',
      '    upper = trimmed.upper()',
      '    parts = upper.split(",")',
      '    return "|".join(parts)',
      '',
      '',
      'def other(x):',
      '    return x',
    ].join('\n');

    const out = compressCode(source, {
      sourcePath: 'src/h.py',
      language: 'python',
    });
    const range = out.elisions[0]?.recoverAt ?? '';
    // The body is lines 2-5; the blanks at 6 and 7 are not part of it.
    expect(range).toBe('src/h.py:2-5');
  });
});

describe('a concise arrow body is not a brace-delimited body', () => {
  // The same parser the engine uses, so "valid" here means what the engine means.
  const parses = (source: string): boolean => {
    try {
      parse(source, { sourceType: 'module', plugins: ['typescript'] });
      return true;
    } catch {
      return false;
    }
  };

  it('leaves a multiline concise arrow as valid source', () => {
    // BABEL STORES A CONCISE BODY AS AN EXPRESSION, not a BlockStatement -- there are
    // no braces around it. Eliding "the lines between the first and the last" then cuts
    // the middle out of an expression and splices a marker into it, and what reaches
    // the model is not compressed source but broken source.
    const source = [
      'export const pick = (rows: Row[]) =>',
      '  rows',
      '    .filter((row) => row.enabled)',
      '    .filter((row) => row.score > 0)',
      '    .filter((row) => row.owner !== null)',
      '    .filter((row) => row.kind === "leaf")',
      '    .filter((row) => row.parent !== undefined)',
      '    .map((row) => row.id)',
      '    .sort((a, b) => a - b);',
      '',
    ].join('\n');

    expect(parses(source)).toBe(true);

    const out = compressCode(source, { sourcePath: 'src/pick.ts' });

    expect(parses(out.text)).toBe(true);
  });

  it('still elides an ordinary block body', () => {
    // The control. A fix that simply stopped eliding functions would pass the test
    // above and destroy the engine.
    const body = Array.from(
      { length: 40 },
      (_, i) => `  const value${i} = compute(${i}) * factor + offset;`
    );
    const source = [
      'export function work(): number {',
      ...body,
      '  return 0;',
      '}',
      '',
    ].join('\n');

    const out = compressCode(source, { sourcePath: 'src/work.ts' });

    expect(out.elisions.length).toBeGreaterThan(0);
    expect(out.text.length).toBeLessThan(source.length);
  });
});


describe('the ONNX adapter rejects an output shape it cannot slice', () => {
  // A stand-in runtime. `runBatch` only ever constructs a tensor and reads the
  // session's output, so nothing here needs onnxruntime -- which is the point:
  // this guard protects against a model that misbehaves, and a correctly
  // behaving real model can never exercise it.
  const runtimeReturning = (
    output: OnnxTensorLike
  ): { ort: OnnxRuntime; session: OnnxSession } => ({
    ort: {
      InferenceSession: {
        create: (): Promise<OnnxSession> => {
          throw new Error('not used by runBatch');
        },
      },
      Tensor: class {
        constructor(
          readonly type: string,
          readonly data: BigInt64Array,
          readonly dims: readonly number[]
        ) {}
      },
    },
    session: {
      inputNames: ['ids'],
      outputNames: ['embedding'],
      run: async (): Promise<Record<string, OnnxTensorLike>> => ({
        embedding: output,
      }),
    },
  });

  const tokenize = (text: string): number[] => [text.length, 1];

  it('refuses an unpooled [batch, tokens, dimensions] output', async () => {
    // THE SHAPE THAT SLIPPED THROUGH. Last dimension is 4, so the width check
    // is satisfied; the model emitted 2 x 3 x 4, so it produced six vectors for
    // two inputs. The old `produced < rows.length` test passed, and the slice
    // loop then gave input 1 the SECOND TOKEN of input 0.
    const { ort, session } = runtimeReturning({
      data: new Float32Array(2 * 3 * 4).fill(1),
      dims: [2, 3, 4],
    });

    await expect(
      runBatch(ort, session, 'ids', 'embedding', ['a', 'bb'], tokenize, 8, 4)
    ).rejects.toThrow(/produced 6 vectors of width 4 for 2 inputs/);
  });

  it('refuses an output that is not a whole number of vectors', async () => {
    // THE LAST DIMENSION IS DELIBERATELY 4, so the width check above cannot be
    // the one that fires -- a fixture rejected by an earlier guard proves
    // nothing about this one. The tensor is internally inconsistent instead:
    // it claims 2 x 4 and carries 10 values, which is 2.5 vectors.
    const { ort, session } = runtimeReturning({
      data: new Float32Array(10).fill(1),
      dims: [2, 4],
    });

    await expect(
      runBatch(ort, session, 'ids', 'embedding', ['a', 'bb'], tokenize, 8, 4)
    ).rejects.toThrow(/must produce exactly one pooled vector per input/);
  });

  it('accepts one pooled vector per input, and slices them apart', async () => {
    // The positive case, and the one that proves the guard is not simply
    // rejecting everything: two inputs, two 4-wide vectors, each recovered
    // whole and in order.
    const data = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const { ort, session } = runtimeReturning({ data, dims: [2, 4] });

    const vectors = await runBatch(
      ort,
      session,
      'ids',
      'embedding',
      ['a', 'bb'],
      tokenize,
      8,
      4
    );

    expect(vectors).toHaveLength(2);
    expect(Array.from(vectors[0])).toEqual([1, 2, 3, 4]);
    expect(Array.from(vectors[1])).toEqual([5, 6, 7, 8]);
  });

  it('copies each vector out of the runtime-owned buffer', async () => {
    // The adapter copies because onnxruntime may reuse the output buffer on the
    // next run. Overwriting the source afterwards must not disturb what was
    // already handed back.
    const data = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const { ort, session } = runtimeReturning({ data, dims: [2, 4] });

    const vectors = await runBatch(
      ort,
      session,
      'ids',
      'embedding',
      ['a', 'bb'],
      tokenize,
      8,
      4
    );
    data.fill(99);

    expect(Array.from(vectors[0])).toEqual([1, 2, 3, 4]);
  });
});

describe('a class body keeps the signatures inside it', () => {
  // THE ASYMMETRY THIS CLOSES. The indentation walk treated every declaration
  // alike: find the block, elide it, skip past it. For a function that is right,
  // and it matches what the Babel path does. For a CLASS it elided the entire
  // body as one span, so every method signature and every decorator inside went
  // with it -- while the identical shape in TypeScript kept all three signatures
  // and elided each method body separately.
  //
  // Signatures are the part an agent reads to decide whether it needs the file
  // at all, so losing them is the expensive direction of a size win.
  const NEWLINE = String.fromCharCode(10);
  const PY = [
    'class RealClass:',
    '    @property',
    '    def decorated(self):',
    '        first = 1',
    '        second = 2',
    '        return first + second',
    '',
    '    def other_method(self, count):',
    '        total = 0',
    '        for i in range(count):',
    '            total += i',
    '        return total',
    '',
    'LAST_MARKER = "sentinel"',
  ].join(NEWLINE);

  it('keeps the decorator and every method signature', () => {
    const out = compressCode(PY, { sourcePath: 'shape.py' });

    expect(out).not.toBeNull();
    const text = out?.text ?? '';
    expect(text).toContain('class RealClass:');
    expect(text).toContain('@property');
    expect(text).toContain('def decorated(self):');
    expect(text).toContain('def other_method(self, count):');
    // Module-level code after the class must survive the walk too.
    expect(text).toContain('LAST_MARKER');
  });

  it('elides the method bodies rather than the class', () => {
    const out = compressCode(PY, { sourcePath: 'shape.py' });
    const text = out?.text ?? '';

    // The bodies are gone...
    expect(text).not.toContain('total += i');
    // ...and each was removed as its own elision, which is what a span per
    // method means. A single elision here is the old behaviour: the whole class
    // collapsed into one span.
    expect((out?.elisions ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('does not treat declarations inside a string literal as real ones', () => {
    // A regex over line starts cannot see quoting, so this is the case an AST
    // would be bought for. It passes because the walk only elides BELOW a
    // declaration it matched, and these sit at module level inside a literal.
    const QUOTES = String.fromCharCode(34, 34, 34);
    const withString = [
      `SQL = ${QUOTES}`,
      'def not_a_function():',
      '    this is prose inside a triple quoted string',
      'class NotAClass:',
      '    also inside',
      QUOTES,
      '',
      'def real_one(value):',
      '    a = 1',
      '    b = 2',
      '    return value + a + b',
    ].join(NEWLINE);

    const out = compressCode(withString, { sourcePath: 'strings.py' });
    const text = out?.text ?? '';

    expect(text).toContain('def real_one(value):');
    // The literal's contents survive: nothing treated `not_a_function` as a
    // declaration whose body could be elided.
    expect(text).toContain('not_a_function');
    expect(text).toContain('NotAClass');
  });
});
