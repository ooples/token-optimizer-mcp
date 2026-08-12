/**
 * End-to-end: does a finding actually reach the model?
 *
 * The unit tests prove `forTouch` and `forCommand` return the right string.
 * That was never the defect. The defect was that NOTHING CALLED THEM -- both
 * were imported only by their own tests while the production hook imported
 * `refusalPayload` and `substitutionFor` from the same module. A unit test
 * suite can be entirely green while the feature ships dead, and it was.
 *
 * So these tests spawn the real hook binary with a real PreToolUse payload and
 * assert on what it writes to stdout. That is the only thing that can tell the
 * difference between "the function works" and "the model gets it".
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { putNode, putNodeWithEdges, wikiDir } from '../../hooks-core/wiki.mjs';

const HOOK = join(process.cwd(), 'plugin', 'hooks', 'pretooluse-router.mjs');

let project;
let dir;
// UNIQUE PER RUN. The once-per-session gate is persisted to disk now, so a
// fixed session id would make the suite observe its OWN previous run and
// correctly decline to re-inject -- a hermeticity problem in the test, not a
// product bug. It surfaced the moment the persistence defect was fixed.
let session;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'inject-e2e-'));
  // A repository marker, so projectRootFor resolves to this temp project and
  // the hook consults THIS graph rather than walking up to a real one.
  mkdirSync(join(project, '.git'), { recursive: true });
  dir = wikiDir(project);
  session = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
});

afterEach(() => {
  try {
    rmSync(project, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

function seedFinding({ key, claim, type = 'command', trigger, anchorPath }) {
  const fileId = putNode(dir, { kind: 'file', key: anchorPath, hash: 'abc' });
  putNodeWithEdges(
    dir,
    { kind: 'finding', key, claim, type, trigger, confidence: 0.95, origin: 'agent' },
    [{ edge: 'derived_from', to: fileId }]
  );
}

/** Runs the hook exactly as Claude Code would, returning parsed stdout. */
function runHook(payload, env = {}) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      // This suite verifies DELIVERY. Production holdout assignment is time-
      // stratified, so leaving it enabled makes the same fixture randomly
      // become a valid control-arm silence on some UTC days.
      TOKEN_OPTIMIZER_HOLDOUT: '0',
      TOKEN_OPTIMIZER_WIKI_DIR: dir,
      TOKEN_OPTIMIZER_SHARED_DIR: dir,
      ...env,
    },
  });
  // FAIL FAST rather than treating a crash as "no context". A hook that died
  // and a hook that had nothing to say both produce no additionalContext, and
  // conflating them would let a broken build pass every silence assertion here.
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`hook exited ${result.status}: ${String(result.stderr).slice(0, 400)}`);
  }

  const stdout = String(result.stdout || '').trim();
  let json = null;
  if (stdout) {
    try {
      json = JSON.parse(stdout);
    } catch {
      throw new Error(`hook wrote non-JSON: ${stdout.slice(0, 200)}`);
    }
  }
  // Only an EMPTY stdout from a successful process is a bare allow.
  return { status: result.status, stdout: result.stdout, json };
}

describe('injection reaches the model through the real hook', () => {
  it('delivers a command finding before the command runs', () => {
    const anchor = join(project, 'harvest.mjs');
    writeFileSync(anchor, 'export function harvest() {}\n');
    seedFinding({
      key: 'f-npm-test',
      claim: 'Run the suite with npm test, not npx jest: bare jest skips ESM suites.',
      trigger: '\\bnpx\\s+jest\\b',
      anchorPath: anchor,
    });

    const { json } = runHook({
      session_id: session,
      cwd: project,
      tool_name: 'Bash',
      tool_input: { command: 'npx jest tests/unit' },
    });

    // THE ASSERTION THAT MATTERS. Before this change the hook wrote nothing at
    // all on an allowed call, so this was necessarily null.
    expect(json?.hookSpecificOutput?.additionalContext).toBeTruthy();
    expect(json.hookSpecificOutput.additionalContext).toContain('npm test');
    expect(json.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  });

  it('stays silent on an unrelated command', () => {
    const anchor = join(project, 'harvest.mjs');
    writeFileSync(anchor, 'export function harvest() {}\n');
    seedFinding({
      key: 'f-npm-test',
      claim: 'Run the suite with npm test, not npx jest.',
      trigger: '\\bnpx\\s+jest\\b',
      anchorPath: anchor,
    });

    const { json } = runHook({
      session_id: session,
      cwd: project,
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    });

    expect(json?.hookSpecificOutput?.additionalContext ?? null).toBeNull();
  });

  it('says nothing when the optimizer is off, so the control arm is honest', () => {
    const anchor = join(project, 'harvest.mjs');
    writeFileSync(anchor, 'export function harvest() {}\n');
    seedFinding({
      key: 'f-npm-test',
      claim: 'Run the suite with npm test, not npx jest.',
      trigger: '\\bnpx\\s+jest\\b',
      anchorPath: anchor,
    });

    // The A/B control depends on this being truly silent. If the off switch
    // leaked even a hint, every measured difference would be understated.
    const { json } = runHook(
      {
        session_id: session,
        cwd: project,
        tool_name: 'Bash',
        tool_input: { command: 'npx jest tests/unit' },
      },
      { TOKEN_OPTIMIZER_MODE: 'off' }
    );

    expect(json?.hookSpecificOutput?.additionalContext ?? null).toBeNull();
  });

  it('never fails the user’s call, even with a corrupt graph', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'graph.jsonl'), '{not json at all\n');

    const { status, json } = runHook({
      session_id: session,
      cwd: project,
      tool_name: 'Bash',
      tool_input: { command: 'npx jest' },
    });

    // Delivery is an optimization. A broken graph must cost the user nothing.
    expect(status).toBe(0);
    expect(json?.hookSpecificOutput?.permissionDecision ?? 'allow').not.toBe('deny');
  });
});
