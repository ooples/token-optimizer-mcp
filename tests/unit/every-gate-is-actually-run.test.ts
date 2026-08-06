import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * A gate nothing runs is not a gate.
 *
 * `verify:clients` checks the shape of every client integration. No workflow
 * invoked it, so nobody noticed when #256 removed the numeric version pin and
 * left this script still asserting it. Anyone running it by hand got:
 *
 *     104/129 checks passed        (exit 1)
 *
 * for weeks, while CI stayed green. The script was not wrong about a real
 * invariant — it was enforcing an invariant the project had deliberately
 * abandoned, and being unrun is what let the two drift apart.
 *
 * Found by an agent doing something else entirely, which is the point: nothing
 * in the repository could have told anyone, because nothing ran it.
 *
 * This asserts that every verification script package.json exposes is reachable
 * from CI. A new one added and never wired fails here rather than rotting
 * quietly until someone runs it by accident.
 */

const ROOT = process.cwd();

const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  .scripts as Record<string, string>;

const workflowText = readdirSync(join(ROOT, '.github', 'workflows'))
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => readFileSync(join(ROOT, '.github', 'workflows', f), 'utf8'))
  .join('\n');

/**
 * Scripts whose whole job is to verify something and fail the build.
 *
 * Matched by name rather than listed by hand, so a newly added `verify:*` is
 * covered the day it appears instead of the day someone remembers this file.
 */
const gates = Object.keys(scripts).filter((name) => /^verify:/.test(name));

describe('verification scripts are reachable from CI', () => {
  it('finds some gates to check, so this cannot pass vacuously', () => {
    expect(gates.length).toBeGreaterThan(0);
  });

  /**
   * Script names a body actually INVOKES, parsed rather than substring-matched.
   *
   * `body.includes('verify:ui')` also matches a comment, an `echo`, and the
   * longer name `verify:ui:extra` -- so a gate could read as covered when CI
   * never runs it. Only `npm run <name>` occurrences count, and the name must
   * end at a word boundary.
   */
  const invocations = (body: string): string[] =>
    [...body.matchAll(/npm(?:\s+--\S+)*\s+run\s+([\w:.-]+)/g)].map((m) => m[1]);

  const workflowInvocations = new Set(invocations(workflowText));

  /**
   * Does CI reach this script, through any depth of wrapper?
   *
   * Resolved RECURSIVELY. A single hop was enough today and would quietly stop
   * being enough the moment someone wrapped a gate twice, which is the kind of
   * silent gap this whole file exists to prevent. `seen` bounds a cycle.
   */
  const runsInCi = (name: string, seen = new Set<string>()): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    if (workflowInvocations.has(name)) return true;
    return Object.entries(scripts).some(
      ([outer, outerBody]) =>
        outer !== name &&
        invocations(outerBody).includes(name) &&
        runsInCi(outer, seen)
    );
  };

  it.each(gates)('%s is executed in CI', (gate) => {
    // An AGGREGATE is covered when everything it invokes is covered.
    // `verify:all` chains the others, so wiring it too would run every gate
    // twice. The invariant is that every verification EXECUTES, not that every
    // script name appears somewhere in a workflow file.
    const parts = invocations(scripts[gate]).filter((g) => gates.includes(g));

    const reachable =
      runsInCi(gate) || (parts.length > 0 && parts.every((p) => runsInCi(p)));

    expect({ gate, reachable }).toEqual({ gate, reachable: true });
  });
});
