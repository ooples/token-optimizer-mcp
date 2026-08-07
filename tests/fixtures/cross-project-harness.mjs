/**
 * Builds the two arms for the CROSS-PROJECT proof.
 *
 * The lesson is written into project A's graph through `writeHarvested` -- the
 * same function the harvest worker calls -- so promotion to the shared tier
 * happens by the production path rather than by the harness reaching into the
 * store. Then the real `pretooluse-router.mjs` is spawned inside project B, whose
 * graph is empty and which has never seen the claim.
 *
 * TREATMENT is what the hook actually emits there. CONTROL is the same prompt
 * with nothing injected. If the treatment arm is empty for a case, that case is
 * NOT admitted -- an arm with no injection is a second control, and scoring it as
 * a treatment failure would blame the graph for a harness fault.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const HOOK = join(process.cwd(), 'plugin', 'hooks', 'pretooluse-router.mjs');
const CORE = (n) => pathToFileURL(join(process.cwd(), 'hooks-core', n)).href;

/**
 * @returns {Promise<{arms: Array, sharedDir: string, cleanup: Function}>}
 */
export async function buildCrossArms(cases) {
  const { writeHarvested } = await import(CORE('harvest-write.mjs'));

  const shared = mkdtempSync(join(tmpdir(), 'xproj-shared-'));
  const state = mkdtempSync(join(tmpdir(), 'xproj-state-'));
  const made = [shared, state];

  // NEW ON EVERY RUN. Injection is once-per-session and the gate persists to
  // disk, so a fixed id makes the treatment arm silently degrade into a second
  // control on the second run -- the failure mode this project has already been
  // bitten by once in exactly this harness family.
  const run = randomBytes(6).toString('hex');

  const arms = [];
  for (const c of cases) {
    // A FRESH PAIR OF PROJECTS PER CASE, so one case's lesson cannot answer
    // another's task through the shared tier.
    const projectA = mkdtempSync(join(tmpdir(), `xproj-a-${c.id}-`));
    const projectB = mkdtempSync(join(tmpdir(), `xproj-b-${c.id}-`));
    made.push(projectA, projectB);
    mkdirSync(join(projectA, '.git'), { recursive: true });
    mkdirSync(join(projectB, '.git'), { recursive: true });

    const anchor = join(projectA, 'subject.mjs');
    writeFileSync(anchor, 'export function subject() {}\n');

    const wikiA = join(projectA, '.token-optimizer', 'wiki');
    mkdirSync(wikiA, { recursive: true });
    mkdirSync(join(projectB, '.token-optimizer', 'wiki'), { recursive: true });

    // Written through the PRODUCTION path, with the shared dir pointed at the
    // scratch store, so promotion is the real promotion.
    // RESTORED IN A finally. Without it, a throw from writeHarvested leaves this
    // scratch directory installed as the process-wide shared store, and every
    // test that runs afterwards reads and writes another case's lessons. That is
    // cross-test contamination arriving through an error path, which is the kind
    // that survives a green suite.
    const prevShared = process.env.TOKEN_OPTIMIZER_SHARED_DIR;
    let written;
    try {
      process.env.TOKEN_OPTIMIZER_SHARED_DIR = shared;
      written = writeHarvested(
        wikiA,
        [
          {
            type: 'command',
            claim: c.claim,
            confidence: 0.95,
            trigger: c.trigger,
            anchors: [anchor],
          },
        ],
        { sessionId: `xproj-seed-${run}`, projectRoot: projectA }
      );
    } finally {
      if (prevShared === undefined) delete process.env.TOKEN_OPTIMIZER_SHARED_DIR;
      else process.env.TOKEN_OPTIMIZER_SHARED_DIR = prevShared;
    }

    // Probe from project B through the REAL hook.
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        session_id: `xproj-${c.id}-${run}`,
        cwd: projectB,
        tool_name: 'Bash',
        tool_input: { command: c.probeCommand },
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        TOKEN_OPTIMIZER_SHARED_DIR: shared,
        TOKEN_OPTIMIZER_STATE_DIR: state,
        // The harness builds the TREATMENT arm; its job is to capture what the
        // hook emits when it serves. With the holdout live, a case whose command
        // hashes into the withheld arm produces nothing and the treatment arm
        // becomes a second control.
        TOKEN_OPTIMIZER_HOLDOUT: '0',
      },
      timeout: 30_000,
    });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`hook exited ${r.status}: ${r.stderr}`);

    const injected =
      JSON.parse(r.stdout || '{}').hookSpecificOutput?.additionalContext ?? '';

    arms.push({
      case: c,
      seeded: written.length === 1,
      projectA,
      projectB,
      injected,
      // The claim must have arrived FROM ELSEWHERE, not from project B's own
      // graph -- otherwise this measures local retrieval wearing a cross-project
      // label.
      crossed: injected.includes('From other projects on this machine'),
    });
  }

  return {
    arms,
    sharedDir: shared,
    cleanup: () => {
      for (const d of made) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* windows can hold a handle briefly */
        }
      }
    },
  };
}
