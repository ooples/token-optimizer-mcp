/*
 * The rules the published schema has to keep enforcing.
 *
 * Validation is derived from the definitions `tools/list` serves, which means
 * every rule now lives in one place. That is the point of the change, and it is
 * also what this test guards: a rule deleted from a definition is a rule no
 * longer checked anywhere, and nothing else in the suite would notice.
 *
 * Two classes are pinned here.
 *
 * SECURITY. src/validation/tool-schemas.ts used to hold safeGitRef, safePathArg
 * and safeFilterText -- hand-written zod validators that refused argv injection
 * (a leading '-') and control-character injection (NUL, CR, LF) in the string
 * fields that reach git and the shell. They are gone; the same rules are
 * published as `pattern` on the properties themselves. The in-tool
 * assertSafeGitRef / assertSafeArg / execFileSafe argv-mode guards remain the
 * inner layer, so this is defense in depth either way -- but the outer layer
 * must not quietly stop existing.
 *
 * CONDITIONAL REQUIREMENTS. Three tools require different fields depending on
 * `operation`. That used to be a hand-written discriminated union no caller
 * could see, intersected into the derived schema. It is now published as
 * sibling `anyOf` branches, so a caller can read it -- and the branches have to
 * actually bite. Measured during the change: a branch written as
 * `{ properties: { operation: { const: 'store' } }, required: [...] }` derived
 * to `unknown` because it declares no `type`, and a union of vacuous branches
 * enforces nothing.
 */
import { describe, it, expect } from '@jest/globals';
import { toolSchemaMap } from '../../src/validation/tool-schemas.js';
import { validateToolArgs } from '../../src/validation/validator.js';

/**
 * The two rules, kept apart because they are not the same rule.
 *
 * ARGV fields land in a position where a value beginning with '-' would be read
 * as an option rather than as data, so they refuse it. FILTER fields are free
 * text handed to git as the value half of `--author=<v>`, where a leading '-'
 * is data and a legitimate query may well start with one -- the deleted
 * safeFilterText said so in as many words ("argv-mode safe; reject only
 * NUL/newline"), and the published pattern says the same thing. Both classes
 * refuse control characters.
 *
 * Asserting one rule for both would mean either losing the leading-'-' check on
 * the fields that need it, or pinning a refusal the product does not make.
 */
const FIELD_CLASS = Object.freeze({ argv: 'argv', filter: 'filter' } as const);
type FieldClass = (typeof FIELD_CLASS)[keyof typeof FIELD_CLASS];

/** Values that must be refused wherever they appear. */
const CONTROL_CHARS = ['a\u0000b', 'a\nb', 'a\rb'];

/** Values that must be refused in an argv position and allowed in free text. */
const LEADING_DASH = ['-x', '--upload-pack=touch /tmp/pwned'];

/** A tool, one of its string fields, how the field is used, a valid request. */
const GUARDED: Array<[string, string, FieldClass, Record<string, unknown>]> = [
  // The base request is the tool's own published requirement and nothing else.
  // An earlier draft put `operation` on all of them: none of these tools except
  // smart_user publishes that key, so every request was refused as an
  // unrecognized key and the injection arm passed without testing a pattern.
  ['smart_diff', 'source', FIELD_CLASS.argv, {}],
  ['smart_diff', 'target', FIELD_CLASS.argv, {}],
  ['smart_diff', 'filePattern', FIELD_CLASS.argv, {}],
  ['smart_branch', 'mergedInto', FIELD_CLASS.argv, {}],
  ['smart_merge', 'branch', FIELD_CLASS.argv, {}],
  ['smart_merge', 'commit', FIELD_CLASS.argv, {}],
  ['smart_log', 'branch', FIELD_CLASS.argv, {}],
  ['smart_log', 'filePath', FIELD_CLASS.argv, {}],
  ['smart_security', 'filePath', FIELD_CLASS.argv, {}],
  ['smart_user', 'username', FIELD_CLASS.argv, { operation: 'get-user-info' }],
  [
    'smart_user',
    'groupname',
    FIELD_CLASS.argv,
    { operation: 'get-group-info' },
  ],
  ['smart_user', 'path', FIELD_CLASS.argv, { operation: 'check-permissions' }],
  ['smart_log', 'author', FIELD_CLASS.filter, {}],
  ['smart_log', 'grep', FIELD_CLASS.filter, {}],
  ['smart_branch', 'pattern', FIELD_CLASS.filter, {}],
];

describe('the published schema enforces its own rules', () => {
  it('refuses control characters in every guarded field', () => {
    const accepted: string[] = [];
    for (const [tool, field, , base] of GUARDED) {
      const schema = toolSchemaMap[tool];
      expect(schema).toBeDefined();
      for (const value of CONTROL_CHARS)
        if (schema.safeParse({ ...base, [field]: value }).success)
          accepted.push(`${tool}.${field} accepted ${JSON.stringify(value)}`);
    }
    expect(accepted).toEqual([]);
  });

  it('refuses a leading dash where the value becomes an argv element', () => {
    const accepted: string[] = [];
    for (const [tool, field, cls, base] of GUARDED) {
      if (cls !== FIELD_CLASS.argv) continue;
      for (const value of LEADING_DASH)
        if (toolSchemaMap[tool].safeParse({ ...base, [field]: value }).success)
          accepted.push(`${tool}.${field} accepted ${JSON.stringify(value)}`);
    }
    expect(accepted).toEqual([]);
    // The arm has to be non-empty or it proves nothing about the patterns.
    expect(
      GUARDED.filter(([, , cls]) => cls === FIELD_CLASS.argv).length
    ).toBeGreaterThan(8);
  });

  it('allows a leading dash in free-text git filters', () => {
    // Not an oversight: a search for "-Wall" is a search, and argv mode puts
    // the value where git cannot read it as an option. Pinned so that
    // tightening the pattern has to be a decision rather than a side effect.
    const refused: string[] = [];
    for (const [tool, field, cls, base] of GUARDED) {
      if (cls !== FIELD_CLASS.filter) continue;
      for (const value of LEADING_DASH)
        if (!toolSchemaMap[tool].safeParse({ ...base, [field]: value }).success)
          refused.push(`${tool}.${field} refused ${JSON.stringify(value)}`);
    }
    expect(refused).toEqual([]);
  });

  it('still accepts the ordinary values those fields are for', () => {
    // The positive control. A pattern that refuses everything would pass the
    // check above while breaking every real call.
    const refused: string[] = [];
    const ORDINARY: Record<string, string> = {
      source: 'main',
      target: 'feature/a-b',
      filePattern: 'src/index.ts',
      mergedInto: 'master',
      branch: 'release/1.2.3',
      commit: 'HEAD~1',
      author: 'Someone <someone@example.com>',
      grep: 'fix: the thing',
      filePath: 'src/server/index.ts',
      username: 'build-agent',
      groupname: 'developers',
      path: 'src/server',
      pattern: 'feature/*',
    };
    for (const [tool, field, , base] of GUARDED) {
      const value = ORDINARY[field];
      const result = toolSchemaMap[tool].safeParse({ ...base, [field]: value });
      if (!result.success)
        refused.push(
          `${tool}.${field} refused ${JSON.stringify(value)}: ` +
            result.error.issues.map((i) => i.message).join('; ')
        );
    }
    expect(refused).toEqual([]);
  });
});

/** A receipt that satisfies cognition_record's published item schema. */
const RECEIPT = {
  graderId: 'g',
  passed: true,
  artifactHash: 'h',
  signature: 's',
};

/** tool, what the case is, whether it must be accepted, the request. */
const CONDITIONAL: Array<[string, string, boolean, Record<string, unknown>]> = [
  [
    'cognition_record',
    'record without kind',
    false,
    {
      operation: 'record',
      semanticObject: { id: 'x' },
      evidenceReceipts: [RECEIPT],
    },
  ],
  [
    'cognition_record',
    'record complete',
    true,
    {
      operation: 'record',
      kind: 'decision',
      semanticObject: { id: 'x' },
      evidenceReceipts: [RECEIPT],
    },
  ],
  [
    'cognition_record',
    'verify-evidence needs no kind',
    true,
    { operation: 'verify-evidence', evidenceReceipts: [RECEIPT] },
  ],
  [
    'optimization_storage',
    'store without its payload',
    false,
    { operation: 'store', originalTextHash: 'h' },
  ],
  [
    'optimization_storage',
    'store complete',
    true,
    {
      operation: 'store',
      originalTextHash: 'h',
      optimizedText: 't',
      originalTokens: 10,
      optimizedTokens: 5,
      tokensSaved: 5,
    },
  ],
  [
    'optimization_storage',
    'retrieve needs no payload',
    true,
    { operation: 'retrieve', originalTextHash: 'h' },
  ],
  [
    'context_delta',
    'compute-delta without content',
    false,
    { operation: 'compute-delta', sessionId: 's', filePath: 'f' },
  ],
  [
    'context_delta',
    'compute-delta complete',
    true,
    {
      operation: 'compute-delta',
      sessionId: 's',
      filePath: 'f',
      currentContent: 'c',
    },
  ],
  [
    'context_delta',
    'seed without content',
    false,
    { operation: 'seed', sessionId: 's', filePath: 'f' },
  ],
  [
    'context_delta',
    'clear needs no content',
    true,
    { operation: 'clear', sessionId: 's', filePath: 'f' },
  ],
];

describe('published conditional requirements are enforced', () => {
  it.each(CONDITIONAL)('%s: %s', (tool, _case, shouldAccept, args) => {
    const result = toolSchemaMap[tool].safeParse(args);
    const detail = result.success
      ? ''
      : result.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ');
    expect({ accepted: result.success, detail }).toEqual({
      accepted: shouldAccept,
      detail: shouldAccept ? '' : expect.stringMatching(/\S/),
    });
  });

  it('the refusal names the missing fields rather than failing generically', () => {
    /*
     * What the caller is actually told. A branch that derived to `unknown`
     * would accept this request, and a branch that refused everything would
     * fail the accepted cases above -- but a union reports one `invalid_union`
     * issue at the root with message "Invalid input" and buries each branch's
     * real issues in `unionErrors`, so before validator.ts flattened them the
     * caller learned only that something was wrong.
     */
    let message = '';
    try {
      validateToolArgs('optimization_storage', {
        operation: 'store',
        originalTextHash: 'h',
      });
      throw new Error('expected a store with no payload to be refused');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('optimizedText');
    expect(message).toContain('originalTokens');
    expect(message).toContain('optimizedTokens');
    expect(message).toContain('tokensSaved');
    expect(message).not.toContain('root: Invalid input');
  });

  it('says the same field once, not once per side of the intersection', () => {
    // cognition_record's branch list sits beside its property list, so both
    // halves report a missing `kind`. One line per missing field.
    let message = '';
    try {
      validateToolArgs('cognition_record', {
        operation: 'record',
        semanticObject: { id: 'x' },
        evidenceReceipts: [RECEIPT],
      });
      throw new Error('expected a record with no kind to be refused');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const kindLines = message
      .split('\n')
      .filter((line) => line.includes('kind'));
    expect(kindLines.length).toBe(1);
  });
});
