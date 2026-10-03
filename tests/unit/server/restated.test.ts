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
    // would corrupt the answer, so the walk stops at `resolved` and at every
    // other key a tool puts unauthored material under. That boundary is what
    // makes it safe to follow a `metadata` to any depth elsewhere.
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

  it('drops an option equal to the default its own schema publishes', () => {
    // The caller named no mode. They still know this one: `graph` is printed
    // as the default of `mode` in the schema they read before calling.
    const out = withoutRestated(
      { mode: 'graph', graph: { nodes: [] } },
      { projectRoot: 'C:/work' },
      new Map<string, unknown>([['mode', 'graph']])
    );
    expect(out).toEqual({ graph: { nodes: [] } });
  });

  it('keeps a value the tool worked out under a declared input name', () => {
    // THE POSITIVE CONTROL, and the case that forced this rule to compare
    // values. `environment` IS a declared input of smart_env, so a rule
    // keyed on input NAMES deleted this field -- but its schema says
    // "auto-detected if not specified" and publishes no default, so with no
    // caller value the reply is reporting a detection. The whole point of
    // the exercise is to make small replies smaller without making them say
    // less, and by name this one lost a quarter of what it had to say.
    const out = withoutRestated(
      { environment: 'production', variables: 8 },
      { envFile: 'C:/work/.env' },
      new Map<string, unknown>()
    );
    expect(out).toEqual({ environment: 'production', variables: 8 });
  });

  it('keeps an object that shares a name with an input', () => {
    // A default is a scalar; a structure under the same name is a finding
    // that happens to collide with an input name.
    const format = { indent: 2, quotes: 'single' };
    const out = withoutRestated({ format }, {}, new Map([['format', 'json']]));
    expect(out).toEqual({ format });
  });

  it('drops cache state written as something other than cacheHit', () => {
    // `isDiff` says this reply is a diff against what the cache already had,
    // and `incrementalUpdate` that only changed files were walked. Both
    // describe how this process answered, which is what `cacheHit` says.
    const out = withoutRestated(
      {
        metadata: { isDiff: true, incrementalUpdate: true, findings: 3 },
      },
      {}
    );
    expect(out).toEqual({ metadata: { findings: 3 } });
  });

  it('drops restated facts about the caller own file', () => {
    // The caller has the file. Its size, its format, its language and its
    // extension are things they can see without being told, and they are
    // FIXED costs -- so they land whole on the smallest replies, which are
    // the ones that have to beat simply reading the file.
    const out = withoutRestated(
      {
        metadata: {
          size: 4096,
          format: 'json',
          language: 'typescript',
          extension: '.ts',
          errors: 2,
        },
      },
      {}
    );
    expect(out).toEqual({ metadata: { errors: 2 } });
  });

  it('reaches a bookkeeping container deeper than the envelope', () => {
    // smart_pretty keeps a second copy of its cache flag three levels down,
    // at `data.format.metadata.cacheHit`. Pruning only directly beneath the
    // root left it there, so the rule follows `metadata` and `summary`
    // wherever they sit.
    const out = withoutRestated(
      { data: { format: { lines: 12, metadata: { cacheHit: true } } } },
      {}
    );
    expect(out).toEqual({ data: { format: { lines: 12 } } });
  });

  it('does not walk into a key holding text the tool did not author', () => {
    // THE SECOND BOUNDARY, and the reason reaching deeper is safe at all.
    // The descent stops dead at the keys where a tool puts the caller's own
    // material, so a file that happens to contain the word `metadata` is
    // returned byte for byte.
    const content = {
      metadata: { cacheHit: true, size: 10 },
      success: true,
    };
    const out = withoutRestated({ content, lines: 2 }, {});
    expect(out).toEqual({ content, lines: 2 });
    expect((out as { content: typeof content }).content).toEqual(content);
  });
});
