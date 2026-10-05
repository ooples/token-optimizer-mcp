import {
  scanRequest,
  serialiseKeepingPrefix,
} from '../../../src/proxy/cached-prefix.js';

const msg = (text: string) => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

/** The shape the captures have: pretty-printed, which is what breaks stringify. */
const build = (msgs: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    { model: 'claude-sonnet-5', max_tokens: 1024, messages: msgs, ...extra },
    null,
    2
  );

describe('cached-prefix', () => {
  it('finds the end of every message in an indented request', () => {
    const text = build([msg('one'), msg('two'), msg('three')]);
    const scan = scanRequest(text);
    expect(scan).not.toBeNull();
    expect(scan?.messages).toHaveLength(3);
    // Each recorded end really is the end of that message, byte for byte.
    const first = scan!.messages[0];
    expect(JSON.parse(text.slice(first.start, first.end))).toEqual(msg('one'));
  });

  it('keeps the whole prefix when nothing changed, and still parses', () => {
    const msgs = [msg('one'), msg('two'), msg('three')];
    const text = build(msgs);
    const parsed = JSON.parse(text);
    const out = serialiseKeepingPrefix(text, parsed);
    expect(out).not.toBeNull();
    // THE PROPERTY THAT MATTERS TWICE OVER: the body still means what the
    // strategy produced, AND it opens with the client's own bytes.
    expect(JSON.parse(out as string)).toEqual(parsed);
    expect(text.startsWith((out as string).slice(0, 200))).toBe(true);
  });

  it('preserves a prefix far longer than the 57-char envelope', () => {
    const msgs = [msg('a'.repeat(4000)), msg('b'.repeat(4000)), msg('tail')];
    const text = build(msgs);
    const parsed = JSON.parse(text);
    const next = { ...parsed, messages: [msgs[0], msgs[1], msg('rewritten')] };
    const out = serialiseKeepingPrefix(text, next);
    expect(out).not.toBeNull();
    expect(JSON.parse(out as string)).toEqual(next);
    let common = 0;
    while (common < text.length && text[common] === (out as string)[common])
      common += 1;
    // Re-serialising would have agreed for ~57 characters; this keeps both
    // untouched messages.
    expect(common).toBeGreaterThan(8000);
  });

  it('refuses when the first message itself was rewritten', () => {
    const msgs = [msg('one'), msg('two')];
    const text = build(msgs);
    const parsed = JSON.parse(text);
    const next = { ...parsed, messages: [msg('CHANGED'), msgs[1]] };
    expect(serialiseKeepingPrefix(text, next)).toBeNull();
  });

  it('refuses when a key ahead of messages was edited, rather than dropping it', () => {
    // `model` is spelled before `messages`, so it rides along in the copied
    // bytes. An edited one would be silently reverted -- refuse instead.
    const msgs = [msg('one'), msg('two')];
    const text = build(msgs);
    const parsed = JSON.parse(text);
    const next = { ...parsed, model: 'claude-opus-5' };
    expect(serialiseKeepingPrefix(text, next)).toBeNull();
  });

  it('carries keys that follow messages, including ones the strategy added', () => {
    const msgs = [msg('one'), msg('two')];
    const text = build(msgs, { tools: [] });
    const parsed = JSON.parse(text);
    const next = { ...parsed, system: 'injected' };
    const out = serialiseKeepingPrefix(text, next);
    expect(out).not.toBeNull();
    expect(JSON.parse(out as string)).toEqual(next);
  });

  it('handles a message holding braces and escaped quotes in its text', () => {
    // The scanner walks bracket depth, so a payload that LOOKS like structure
    // would derail it if strings were not skipped whole.
    const tricky = msg('a "}" and a {"[": "]"} and a backslash \\ here');
    const msgs = [tricky, msg('two')];
    const text = build(msgs);
    const parsed = JSON.parse(text);
    const next = { ...parsed, messages: [tricky, msg('rewritten')] };
    const out = serialiseKeepingPrefix(text, next);
    expect(out).not.toBeNull();
    expect(JSON.parse(out as string)).toEqual(next);
  });

  it('shortens the message list without leaving a dangling comma', () => {
    const msgs = [msg('one'), msg('two'), msg('three')];
    const text = build(msgs);
    const parsed = JSON.parse(text);
    const next = { ...parsed, messages: [msgs[0]] };
    const out = serialiseKeepingPrefix(text, next);
    expect(out).not.toBeNull();
    expect(JSON.parse(out as string)).toEqual(next);
  });

  it('returns null on a body that is not an object with messages', () => {
    expect(scanRequest('[]')).toBeNull();
    expect(scanRequest('{"model":"x"}')).toBeNull();
    expect(scanRequest('not json')).toBeNull();
  });
  it('does not revert an edit the strategy made in place', () => {
    // The strategies mutate the parsed request rather than rebuilding it, so
    // the "before" side has to be re-read from the original bytes. If it were
    // taken from the parsed object, this edit would compare equal to itself
    // and be overwritten by the stale text.
    const text = build([msg('one'), msg('two')]);
    const parsed = JSON.parse(text);
    parsed.messages[0].content[0].text = 'REWRITTEN IN PLACE';
    const out = serialiseKeepingPrefix(text, parsed);
    // Nothing is preservable, so the caller re-serialises -- and crucially the
    // edit is not silently undone.
    expect(out).toBeNull();
  });

  it('keeps an untouched prefix even when a later message was edited in place', () => {
    const text = build([msg('one'), msg('two'), msg('three')]);
    const parsed = JSON.parse(text);
    parsed.messages[2].content[0].text = 'REWRITTEN IN PLACE';
    const out = serialiseKeepingPrefix(text, parsed);
    expect(out).not.toBeNull();
    expect(JSON.parse(out as string)).toEqual(parsed);
    expect(JSON.parse(out as string).messages[2].content[0].text).toBe(
      'REWRITTEN IN PLACE'
    );
  });
});
