/**
 * WHAT A RATIO ON A WHOLE BODY WOULD NOT CATCH. The arithmetic of an echo ratio
 * is a set membership test and a division, and it is not where this can go
 * wrong. It goes wrong in the streaming: a reply arrives split at arbitrary
 * byte offsets, and a scanner that loses a window at every boundary, glues two
 * words into one, or parks forever on a key-shaped VALUE reports a plausible
 * number that is not the one it claims. Each of those is pinned here against
 * the same reply delivered whole.
 */

import {
  ECHO_ENV,
  ECHO_MAX_PENDING,
  contextNgrams,
  createEchoScanner,
  echoEnabled,
  extractTextValues,
} from '../../../src/proxy/echo.js';

const CONTEXT =
  'the cache engine stores compressed blocks on disk and keys them by a ' +
  'content hash so the engine is idempotent across runs and machines';

function block(text: string): string {
  return JSON.stringify({ type: 'text', text });
}

function delta(text: string): string {
  const frame = JSON.stringify({
    type: 'content_block_delta',
    delta: { type: 'text_delta', text },
  });
  return ['event: content_block_delta', 'data: ' + frame, '', ''].join('\n');
}

function scan(context: string, chunks: readonly string[], size = 4) {
  const scanner = createEchoScanner(context, size);
  if (scanner === null) return null;
  for (const chunk of chunks) scanner.push(chunk);
  return scanner.ratio();
}

describe('turning the scanner on', () => {
  it('stays off unless it is asked for', () => {
    for (const value of ['', '0', 'false', 'off', ' OFF '])
      expect(echoEnabled({ [ECHO_ENV]: value })).toBe(false);
    expect(echoEnabled({})).toBe(false);
    // POSITIVE CONTROL: it does turn on, so the refusals above are about the
    // values and not about the reader never returning true.
    for (const value of ['1', 'true', 'on', 'yes'])
      expect(echoEnabled({ [ECHO_ENV]: value })).toBe(true);
  });
});

describe('the context n-gram set', () => {
  it('refuses a context too short to hold one window', () => {
    expect(contextNgrams('one two three', 4)).toBeNull();
    expect(contextNgrams('', 4)).toBeNull();
    expect(contextNgrams('one two three four', 0)).toBeNull();
    // POSITIVE CONTROL: exactly one window's worth yields exactly one n-gram.
    expect(contextNgrams('one two three four', 4)?.size).toBe(1);
  });

  it('counts windows, not words', () => {
    // Six words, windows of four: positions 0..2, so three n-grams.
    expect(contextNgrams('a b c d e f', 4)?.size).toBe(3);
  });

  it('treats a reordered window as a different n-gram', () => {
    const forward = contextNgrams('a b c d', 4);
    const backward = contextNgrams('d c b a', 4);
    expect(forward?.size).toBe(1);
    expect(backward?.size).toBe(1);
    const [one] = [...(forward ?? [])];
    const [other] = [...(backward ?? [])];
    expect(one).not.toBe(other);
  });
});

describe('pulling text out of a buffer', () => {
  it('leaves an unfinished value for the next chunk', () => {
    const first = extractTextValues('{"text":"hello wo');
    expect(first.values).toEqual([]);
    const second = extractTextValues(first.rest + 'rld"}');
    expect(second.values).toEqual(['hello world']);
  });

  it('passes a key-shaped value instead of waiting for it forever', () => {
    // `"text"` here is the VALUE of `type`. A scanner that treated it as an
    // unfinished key would re-scan the same offset on every chunk until its
    // pending buffer overflowed -- on every Anthropic response ever sent.
    const { values, rest } = extractTextValues(block('copied words here'));
    expect(values).toEqual(['copied words here']);
    expect(rest.length).toBeLessThan(ECHO_MAX_PENDING);
  });

  it('reads an escaped quote as part of the value, not as its end', () => {
    expect(extractTextValues(block('say "hi" now')).values).toEqual([
      'say "hi" now',
    ]);
  });

  it('reads a key written with whitespace around the colon', () => {
    expect(extractTextValues('{"text" :  "spaced out"}').values).toEqual([
      'spaced out',
    ]);
  });

  it('ignores a text key whose value is not a string', () => {
    expect(extractTextValues('{"text":12345,"content":null}').values).toEqual(
      []
    );
    // POSITIVE CONTROL: a string value in the same shape is still read.
    expect(extractTextValues('{"text":12345,"content":"kept"}').values).toEqual([
      'kept',
    ]);
  });
});

describe('the ratio a streamed reply gets', () => {
  it('finds a reply made entirely of context', () => {
    expect(
      scan(CONTEXT, [block('the cache engine stores compressed blocks')])
    ).toBe(1);
  });

  it('finds nothing in a reply that shares no phrase', () => {
    expect(
      scan(CONTEXT, [block('entirely unrelated wording appears right here')])
    ).toBe(0);
  });

  it('measures the same reply the same whether it is split or whole', () => {
    const text =
      'the cache engine stores compressed blocks on disk and then some ' +
      'entirely new wording nobody sent us before';
    const whole = scan(CONTEXT, [block(text)]);
    const streamed = scan(
      CONTEXT,
      text.split(' ').map((word, index) => delta(index === 0 ? word : ' ' + word))
    );
    expect(whole).not.toBeNull();
    // THE WINDOW SPANNING TWO DELTAS IS THE WHOLE POINT. Without the carry the
    // streamed figure counts no window at all and reads as zero echo.
    expect(streamed).toBe(whole);
    // POSITIVE CONTROL: the figure is a genuine mixture, so the equality above
    // is not two zeros or two ones agreeing.
    expect(whole).toBeGreaterThan(0);
    expect(whole).toBeLessThan(1);
  });

  it('rejoins a word split across two deltas', () => {
    // 'compressed' arrives as 'comp' + 'ressed'. Counting those as two words
    // would shift every window and lose the match.
    const split = scan(CONTEXT, [
      delta('the cache engine stores comp'),
      delta('ressed blocks on disk'),
    ]);
    expect(split).toBe(1);
    // POSITIVE CONTROL: a genuinely different word in the same position is NOT
    // matched, so the rejoin is not simply ignoring the tail.
    expect(
      scan(CONTEXT, [
        delta('the cache engine stores comp'),
        delta('licated blocks on disk'),
      ])
    ).toBeLessThan(1);
  });

  it('is insensitive to how whitespace was broken up', () => {
    expect(
      scan(CONTEXT, [block('the   cache\n engine\tstores compressed blocks')])
    ).toBe(1);
  });
});

describe('refusing rather than understating', () => {
  it('reports nothing for a context with no window in it', () => {
    expect(createEchoScanner('too short', 8)).toBeNull();
  });

  it('reports nothing for a reply shorter than one window', () => {
    expect(scan(CONTEXT, [block('three short words')])).toBeNull();
    // POSITIVE CONTROL: one more word reaches a window and yields a figure.
    expect(scan(CONTEXT, [block('three short words here')])).not.toBeNull();
  });

  it('abandons a scan whose pending buffer never closes', () => {
    const scanner = createEchoScanner(CONTEXT, 4);
    if (scanner === null) throw new Error('unreachable');
    // A real window first, so there IS a ratio to lose.
    scanner.push(block('the cache engine stores compressed blocks'));
    expect(scanner.ratio()).toBe(1);
    scanner.push('{"text":"' + 'x'.repeat(ECHO_MAX_PENDING + 1));
    expect(scanner.ratio()).toBeNull();
    // And it stays refused rather than recovering with a partial figure.
    scanner.push('"}');
    expect(scanner.ratio()).toBeNull();
  });
});

describe('the window that ends on the last word', () => {
  it('counts it, because the reply has ended by the time a ratio is asked for', () => {
    // Two windows: [zzz the cache engine] which is not in the context, and
    // [the cache engine stores] which is -- and the second one ends on the
    // reply's final word. Holding that word back scores this 0 instead of 0.5.
    expect(scan(CONTEXT, [block('zzz the cache engine stores')])).toBe(0.5);
  });

  it('reads the same ratio twice, so asking does not consume the tail', () => {
    const scanner = createEchoScanner(CONTEXT, 4);
    if (scanner === null) throw new Error('unreachable');
    scanner.push(block('zzz the cache engine stores'));
    expect(scanner.ratio()).toBe(0.5);
    expect(scanner.ratio()).toBe(0.5);
    // And a continuation still lands on a word, not on a double-counted one.
    scanner.push(block(' compressed blocks on disk'));
    expect(scanner.ratio()).toBeGreaterThan(0.5);
  });
});
