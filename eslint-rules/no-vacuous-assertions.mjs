/**
 * Bans assertions that pass when the code under test is broken.
 *
 * WHY THIS EXISTS AS A RULE RATHER THAN A HABIT. Four separate defects in one
 * day shipped or nearly shipped behind a green suite, each a different spelling
 * of the same mistake:
 *
 *   1. `expect(body).not.toContain('smart_write')` -- passes if the call THREW
 *      and returned an error object, which is not the behaviour under test.
 *   2. `expect(r.reason).not.toMatch(/unchanged/)` -- passes if the router
 *      denied for any OTHER reason, so it could not detect the session-isolation
 *      regression it existed to catch.
 *   3. A payload built at module scope from a `beforeAll` variable was
 *      `undefined`, the hook failed open, and every "is allowed" assertion
 *      passed while exercising nothing.
 *   4. A fixture larger than the default chunk size meant a control test read
 *      only chunk 0, so it passed for a reason unrelated to its subject.
 *
 * The common shape is a NEGATIVE or EXISTENTIAL assertion carrying the whole
 * weight of a test. Such an assertion is satisfied by every failure mode as
 * well as by the intended behaviour, so it cannot discriminate -- and a test
 * that cannot discriminate is worse than no test, because it reports safety.
 *
 * WHAT IS ALLOWED. A negative assertion is fine when a POSITIVE one in the same
 * test already pins the behaviour: `expect(x.decision).toBe('allow')` followed
 * by `expect(x.reason).not.toContain('deny')` is a refinement, not a claim.
 * The rule therefore fires only when a test's assertions are ALL negative or
 * existential.
 *
 * Escape hatch: `// eslint-disable-next-line local/no-vacuous-assertions` with
 * a reason. Deliberate, because "this test really can only assert an absence"
 * is occasionally true and should be argued in the diff rather than silently
 * permitted.
 */

/**
 * Matchers that assert a value merely EXISTS, which a broken subject satisfies.
 *
 * `toBeNull` and `toBeUndefined` are deliberately NOT here, and that distinction
 * is the rule's whole accuracy. An earlier version included them and flagged 157
 * tests, nearly all of them correct: `expect(out.hooks).toBeUndefined()` is the
 * precise specification of a test about removing a key, and `toBeNull()` is the
 * specification of every 'no base is returned' case in the authored-content
 * suite. Those assert a SPECIFIC value; the ones below assert only that
 * something is there.
 */
const WEAK_MATCHERS = new Set(['toBeDefined', 'toBeTruthy', 'toBeFalsy']);

/**
 * Negated matchers that assert an ABSENCE FROM OUTPUT.
 *
 * This is the shape that actually shipped broken twice: `not.toContain(str)`
 * and `not.toMatch(re)` are satisfied by the intended behaviour AND by a thrown
 * error, an undefined result, a different failure reason, or a subject never
 * exercised. `not.toThrow` is excluded because it asserts the call SUCCEEDED,
 * which a broken subject does not.
 */
const ABSENCE_MATCHERS = new Set(['toContain', 'toMatch']);
const TEST_FNS = new Set(['it', 'test']);

function matcherOf(node) {
  // expect(x).not.toContain(y)  ->  { name: 'toContain', negated: true }
  let call = node;
  if (call.type !== 'CallExpression') return null;
  const callee = call.callee;
  if (callee.type !== 'MemberExpression') return null;

  const name = callee.property.name;
  let negated = false;
  let obj = callee.object;

  if (obj.type === 'MemberExpression' && obj.property.name === 'not') {
    negated = true;
    obj = obj.object;
  }
  // Walk down to the expect() call so `expect(x).resolves.not.toBe()` counts.
  let root = obj;
  while (root && root.type === 'MemberExpression') root = root.object;
  if (!root || root.type !== 'CallExpression') return null;
  if (root.callee.type !== 'Identifier' || root.callee.name !== 'expect') {
    return null;
  }
  return { name, negated };
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'a test whose assertions are all negative or existential cannot fail when the subject is broken',
    },
    schema: [],
    messages: {
      vacuous:
        'Every assertion in this test is negative or existential ({{detail}}), so it also passes when the call throws, returns undefined, or is never exercised. Add a positive assertion that pins the expected value.',
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type !== 'Identifier' ||
          !TEST_FNS.has(node.callee.name)
        ) {
          return;
        }
        const body = node.arguments[1];
        if (!body || (body.type !== 'ArrowFunctionExpression' &&
                      body.type !== 'FunctionExpression')) {
          return;
        }

        const found = [];
        const walk = (n) => {
          if (!n || typeof n.type !== 'string') return;
          if (n.type === 'CallExpression') {
            const m = matcherOf(n);
            if (m) found.push(m);
          }
          for (const key of Object.keys(n)) {
            if (key === 'parent') continue;
            const child = n[key];
            if (Array.isArray(child)) child.forEach(walk);
            else if (child && typeof child.type === 'string') walk(child);
          }
        };
        walk(body.body);

        if (found.length === 0) return;

        // Only two shapes count: an absence-from-output claim, or a bare
        // existence check. Everything else asserts a specific value and can
        // therefore fail when the subject is broken.
        const weak = found.filter(
          (m) =>
            (m.negated && ABSENCE_MATCHERS.has(m.name)) ||
            (!m.negated && WEAK_MATCHERS.has(m.name))
        );
        if (weak.length === 0 || weak.length !== found.length) return;
        const detail = [...new Set(weak.map((m) => (m.negated ? `not.${m.name}` : m.name)))].join(', ');
        context.report({ node, messageId: 'vacuous', data: { detail } });
      },
    };
  },
};
