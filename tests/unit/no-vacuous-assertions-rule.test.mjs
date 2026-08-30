/**
 * The gate's own tests.
 *
 * A lint rule that polices test quality and has no tests of its own is the
 * joke it sounds like -- and the gap was not theoretical. The rule matched only
 * a bare `it(...)` / `test(...)` callee, so every modified form was skipped in
 * silence, including `it.each([...])(...)`, which this repository already uses
 * in tests/hooks/path-cannot-abort-the-process.test.mjs. The suite stayed green
 * and the coverage it implied was not there.
 *
 * Run through ESLint's own RuleTester so the assertions are about what ESLint
 * actually reports, not about a hand-rolled walk of the AST.
 */
import { RuleTester } from 'eslint';
import rule from '../../eslint-rules/no-vacuous-assertions.mjs';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

const VACUOUS = [{ messageId: 'vacuous' }];

// Called at module top level, deliberately: RuleTester declares its own
// describe/it, so wrapping it in one is 'Cannot nest a describe inside a test'.
ruleTester.run('no-vacuous-assertions', rule, {
  valid: [
    // A negative assertion is a refinement when a positive one already
    // pins the behaviour.
    `test('x', () => { expect(r.decision).toBe('allow'); expect(r.reason).not.toContain('deny'); });`,
    // Specific values, not existence. These are legitimate specifications
    // and flagging them is what made an earlier draft unusable.
    `test('x', () => { expect(out.hooks).toBeUndefined(); });`,
    `test('x', () => { expect(base).toBeNull(); });`,
    `test('x', () => { expect(() => redact(null)).not.toThrow(); });`,
    `test('x', () => { expect(a).toEqual(['a', 'b']); });`,
    // A suite is not a test; its assertions belong to the tests inside it.
    `describe.each([1])('x', () => { expect(x).toBeDefined(); });`,
    // No callback at all.
    `test.todo('later');`,
    // Assertions extracted into a helper are invisible to a rule that reads
    // one callback, so a call to one counts as the positive assertion. This
    // exact shape fired on generators-are-eol-insensitive.test.ts after a
    // reviewer asked for the extraction.
    `test('x', () => { expectRoutesThroughHelper(code); expect(code).not.toMatch(/x/); });`,
    `test('x', () => { assertShapeOf(r); expect(r.reason).not.toContain('deny'); });`,
    // Not a test function.
    `notATest('x', () => { expect(x).toBeDefined(); });`,
  ],
  invalid: [
    {
      code: `test('x', () => { expect(body).not.toContain('smart_write'); });`,
      errors: VACUOUS,
    },
    {
      code: `it('x', () => { expect(r.reason).not.toMatch(/unchanged/); });`,
      errors: VACUOUS,
    },
    {
      code: `test('x', () => { expect(out.joinMethod).toBeDefined(); });`,
      errors: VACUOUS,
    },
    {
      code: `test('x', () => { expect(read.fp).toBeTruthy(); });`,
      errors: VACUOUS,
    },
    // The forms the rule used to skip. Each of these is one report, not
    // two: `it.each(table)` alone carries no callback and is ignored.
    {
      code: `test.only('x', () => { expect(a).toBeDefined(); });`,
      errors: VACUOUS,
    },
    {
      // A bare `expect(x)` is not an assertion and must not excuse the test,
      // and an ordinary helper call is not an assertion helper either.
      code: `test('x', () => { doSomeSetup(a); expect(a).toBeTruthy(); });`,
      errors: VACUOUS,
    },
    {
      code: `it.skip('x', () => { expect(a).toBeTruthy(); });`,
      errors: VACUOUS,
    },
    {
      code: `test.concurrent('x', async () => { expect(a).toBeDefined(); });`,
      errors: VACUOUS,
    },
    {
      code: `it.each([[1], [2]])('x %s', (n) => { expect(n).toBeDefined(); });`,
      errors: VACUOUS,
    },
    {
      code:
        'test.each`a\\n${1}\\n`("x", ({ a }) => { expect(a).toBeTruthy(); });',
      errors: VACUOUS,
    },
    {
      code: `test.concurrent.each([[1]])('x', async (n) => { expect(n).toBeDefined(); });`,
      errors: VACUOUS,
    },
  ],
});
