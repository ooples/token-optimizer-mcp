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

  it.each(gates)('%s is executed in CI', (gate) => {
    const body = scripts[gate];

    // An AGGREGATE is covered when everything it runs is covered. `verify:all`
    // exists for humans -- it chains the others -- so wiring it as well would
    // just run every gate twice. The invariant is that every verification
    // EXECUTES in CI, not that every script name appears in a workflow.
    const parts = gates.filter((g) => g !== gate && body.includes(g));

    const runsInCi = (name: string): boolean => {
      if (workflowText.includes(`npm run ${name}`)) return true;
      // Or via any other script a workflow does run.
      return Object.entries(scripts).some(
        ([outer, outerBody]) =>
          outer !== name &&
          outerBody.includes(name) &&
          workflowText.includes(`npm run ${outer}`)
      );
    };

    const reachable =
      runsInCi(gate) || (parts.length > 0 && parts.every(runsInCi));

    expect({ gate, reachable }).toEqual({ gate, reachable: true });
  });
});
