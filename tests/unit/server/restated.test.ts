import { describe, expect, it } from '@jest/globals';
import { withoutRestated } from '../../../src/server/restated.js';

describe('a reply does not carry what the caller already holds', () => {
  it('drops a success flag on a reply that is not an error', () => {
    const out = withoutRestated({ success: true, answer: 3 }, {});
    expect(out).toEqual({ answer: 3 });
  });

  it('keeps a success flag that reports a failure', () => {
    // `false` is the outcome. Only `true` is the redundant copy of `isError`.
    const out = withoutRestated({ success: false, error: 'no such file' }, {});
    expect(out).toEqual({ success: false, error: 'no such file' });
  });

  it('drops cache bookkeeping wherever the envelope carries it', () => {
    const out = withoutRestated(
      {
        success: true,
        findings: 2,
        cacheHit: false,
        metadata: { fileHash: 'abc123', cached: true, lines: 40 },
        summary: { fromCache: false, total: 2 },
      },
      {}
    );
    expect(out).toEqual({
      findings: 2,
      metadata: { lines: 40 },
      summary: { total: 2 },
    });
  });

  it('drops a container that held nothing but bookkeeping', () => {
    // `"metadata":{}` is four tokens that say less than no metadata key.
    const out = withoutRestated(
      { answer: 1, metadata: { cacheHit: false } },
      {}
    );
    expect(out).toEqual({ answer: 1 });
  });

  it('drops the path the caller named, however the reply spells it', () => {
    // The caller sent an absolute path; the reply answers with the same file
    // written relative to the project root, which is why a plain string
    // comparison finds nothing and this is compared by trailing segments.
    const out = withoutRestated(
      {
        configPath: 'bench/tools/fixtures/tsconfig.json',
        suggestions: ['use a base config'],
      },
      { configPath: 'C:/work/bench/tools/fixtures/tsconfig.json' }
    );
    expect(out).toEqual({ suggestions: ['use a base config'] });
  });

  it('keeps a path the caller did not name', () => {
    // An extends chain resolves a file the caller never mentioned, and naming
    // it is the answer. THE POSITIVE CONTROL for the rule above: if echo
    // matching were by key name rather than by value, this would vanish too.
    const out = withoutRestated(
      { configPath: 'packages/base/tsconfig.base.json', strict: true },
      { configPath: 'C:/work/app/tsconfig.json' }
    );
    expect(out).toEqual({
      configPath: 'packages/base/tsconfig.base.json',
      strict: true,
    });
  });

  it('leaves a caller own parsed content alone, at any depth', () => {
    // THE BOUNDARY. A config is arbitrary JSON and may legitimately contain
    // `success`, `cached` or a `metadata` object of its own. Removing one
    // would corrupt the answer, so nothing below the envelope is touched --
    // and the envelope is the reply plus a `metadata`/`summary` directly
    // beneath it, nothing deeper.
    const config = {
      success: true,
      cached: true,
      metadata: { fileHash: 'theirs', cacheHit: true },
      nested: { metadata: { cached: false } },
    };
    const out = withoutRestated(
      { success: true, resolved: config, cacheHit: false },
      {}
    );
    expect(out).toEqual({ resolved: config });
    expect((out as { resolved: typeof config }).resolved).toEqual(config);
  });

  it('returns the very same object when there was nothing to remove', () => {
    // So a reply that carries none of this is never reserialised, and its key
    // order cannot change underneath a consumer.
    const reply = { findings: [], guidance: {} };
    expect(withoutRestated(reply, {})).toBe(reply);
  });

  it('passes a string reply through untouched', () => {
    // Twenty-six tools answer with text they serialised themselves. There is
    // no envelope to walk, and guessing at one inside prose would edit the
    // answer.
    const text = '{"success":true}';
    expect(withoutRestated(text, {})).toBe(text);
  });
});
