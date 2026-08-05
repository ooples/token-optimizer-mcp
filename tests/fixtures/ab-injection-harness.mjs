/**
 * Builds the A/B arms from the REAL hook, not from hand-written hints.
 *
 * For each seeded dead-end it runs plugin/hooks/pretooluse-router.mjs with the
 * command the subject is likely to reach for, and captures the additionalContext
 * the hook actually emits. The treatment prompt is that string verbatim -- which
 * is exactly what Claude Code prepends -- so the experiment tests the shipped
 * delivery path rather than a mock of it.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { putNode, putNodeWithEdges, wikiDir, contentHash } from '../../hooks-core/wiki.mjs';
import { indexFile } from '../../hooks-core/staleness.mjs';

// RESOLVED FROM THIS FILE, not from an absolute path. The harness was written
// with the author's checkout baked in, which meant it ran nowhere else -- and a
// proof harness that only works on one machine cannot be re-run to check a
// later change, which is most of its value.
const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, '..', '..', 'plugin', 'hooks', 'pretooluse-router.mjs');

// Five dead-ends this session actually hit. Each cost real time, and none is
// discoverable by quickly reading the code -- which is the condition that makes
// the control arm a fair comparison rather than a reading-comprehension test.
export const CASES = [
  {
    id: 'npx-jest',
    class: 'non-inferable',
    claim:
      'Run the suite with npm test, not npx jest: the project passes --experimental-vm-modules, and bare npx jest silently skips every ESM suite.',
    trigger: '\\bnpx\\s+jest\\b',
    probeCommand: 'npx jest tests/unit/foo.test.ts',
    task: 'You need to run the unit tests for this Node project (it uses Jest and ESM). State the EXACT shell command you would run. One line, command only.',
    // The dead-end is answering with a bare `npx jest`.
    walksIn: (s) => /\bnpx\s+jest\b/i.test(s) && !/npm\s+(run\s+)?test/i.test(s),
    avoids: (s) => /npm\s+(run\s+)?test/i.test(s),
  },
  {
    id: 'csproj-name',
    class: 'non-inferable',
    claim:
      'The test project file is tests/AiDotNet.Tests/AiDotNetTests.csproj -- the DIRECTORY is AiDotNet.Tests but the csproj has no dot. Guessing the symmetric name gives MSB1009 Project file does not exist.',
    trigger: 'dotnet\\s+(build|test)',
    probeCommand: 'dotnet build tests/AiDotNet.Tests/AiDotNet.Tests.csproj',
    task: 'In a .NET repo there is a test project under tests/AiDotNet.Tests/. State the EXACT dotnet build command you would run, including the csproj path. One line, command only.',
    walksIn: (s) => /AiDotNet\.Tests\.csproj/i.test(s),
    avoids: (s) => /AiDotNetTests\.csproj/i.test(s),
  },
  {
    id: 'pipe-exit',
    class: 'plausible',
    claim:
      'Piping a dotnet build or test through | tail or | head makes the shell report the PIPE exit status, not dotnet. A build that failed with MSB1009 came back as exit 0 and was reported as succeeding.',
    trigger: '\\b(dotnet|npm|cargo)\\b.*\\|\\s*(tail|head)\\b',
    probeCommand: 'dotnet build App.csproj | tail -20',
    task: 'You want to run `dotnet build App.csproj`, show only the last 20 lines of output, AND reliably know whether the build itself failed. State the EXACT shell command(s). Keep it to one or two lines.',
    // `tee` alone is NOT a fix: it still leaves the pipeline's status as the
    // last command's. What actually propagates failure is `set -o pipefail`,
    // PIPESTATUS, or capturing the status before any pipe (redirect to a file,
    // read the code, then show the tail).
    avoids: (s) =>
      /set\s+-o\s+pipefail|pipefail/i.test(s) ||
      /PIPESTATUS/i.test(s) ||
      /LASTEXITCODE/i.test(s) ||
      />\s*\S+\.(log|txt)[\s\S]*(\$\?|LASTEXITCODE)/i.test(s),
    walksIn: (s) =>
      /\|\s*(tail|head|tee)/i.test(s) &&
      !/set\s+-o\s+pipefail|pipefail|PIPESTATUS|LASTEXITCODE/i.test(s) &&
      !/>\s*\S+\.(log|txt)[\s\S]*(\$\?|LASTEXITCODE)/i.test(s),
  },
  {
    id: 'fetch-refspec',
    class: 'plausible',
    claim:
      "A checkout's remote.origin.fetch can be clobbered to a single tag refspec, so git fetch origin master silently never updates origin/master and every 'commits behind' check lies. Verify with git config --get-all remote.origin.fetch.",
    trigger: 'git\\s+fetch',
    probeCommand: 'git fetch origin master',
    task: 'You must confirm your local branch is up to date with the remote master before rebasing. State the EXACT git command(s) you would run to be certain. Keep it to one or two lines.',
    walksIn: (s) => /git\s+fetch/i.test(s) && !/remote\.origin\.fetch|ls-remote/i.test(s),
    avoids: (s) => /remote\.origin\.fetch|ls-remote/i.test(s),
  },
  {
    id: 'dirty-pr',
    class: 'non-inferable',
    claim:
      'A PR whose mergeStateStatus is DIRTY causes GitHub to schedule NO pull_request-triggered workflows at all, because it cannot build refs/pull/N/merge. Runs are never created rather than cancelled. Check gh pr view N --json mergeStateStatus first.',
    trigger: 'gh\\s+(pr|run)\\b',
    probeCommand: 'gh run list --branch my-branch',
    task: 'A GitHub PR shows only 2 checks and the main CI workflow never appears, even after pushing new commits. State the EXACT first gh command you would run to diagnose why. One line, command only.',
    walksIn: (s) => /gh\s+run\s+(list|view)/i.test(s) && !/mergeStateStatus|mergeable/i.test(s),
    avoids: (s) => /mergeStateStatus|mergeable/i.test(s),
  },
];

export function buildArms() {
  const project = mkdtempSync(join(tmpdir(), 'ab-'));
  mkdirSync(join(project, '.git'), { recursive: true });
  const dir = wikiDir(project);
  const anchor = join(project, 'subject.mjs');
  writeFileSync(anchor, 'export function subject() {}\n');

  // A SESSION ID THAT IS NEW ON EVERY RUN.
  //
  // The id used to be `ab-${c.id}`, fixed. Injection is deliberately
  // once-per-session and that gate persists to disk under the shared state
  // root, so the FIRST run of this harness served the findings and recorded
  // them, and every run after it received nothing at all.
  //
  // That is the worst possible failure for a measurement instrument: the
  // treatment arm silently degrades into a second control arm, both answer the
  // same way, and the experiment reports that the graph does not help. It
  // reproduces exactly -- run buildArms() twice and the second call returns
  // null for all five cases.
  const run = randomBytes(6).toString('hex');

  const out = [];
  for (const c of CASES) {
    // Fresh graph per case so one case's finding cannot answer another's task.
    const caseProject = mkdtempSync(join(tmpdir(), `ab-${c.id}-`));
    mkdirSync(join(caseProject, '.git'), { recursive: true });
    const caseDir = wikiDir(caseProject);
    const caseAnchor = join(caseProject, 'subject.mjs');
    writeFileSync(caseAnchor, 'export function subject() {}\n');

    // REAL hash, via the same indexer production uses. A placeholder made every
    // finding render as STALE and 'treat this finding as unverified' -- the
    // injection was telling the subject to discount itself.
    indexFile(caseDir, caseAnchor);
    const fid = putNode(caseDir, { kind: 'file', key: caseAnchor, hash: contentHash(caseAnchor) });
    putNodeWithEdges(
      caseDir,
      {
        kind: 'finding',
        key: `ab-${c.id}`,
        claim: c.claim,
        type: 'command',
        trigger: c.trigger,
        confidence: 0.95,
        origin: 'agent',
      },
      [{ edge: 'derived_from', to: fid }]
    );

    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        session_id: `ab-${c.id}-${run}`,
        cwd: caseProject,
        tool_name: 'Bash',
        tool_input: { command: c.probeCommand },
      }),
      encoding: 'utf8',
      env: { ...process.env, TOKEN_OPTIMIZER_WIKI_DIR: caseDir },
    });

    // FAIL FAST. A hook that crashed and a hook that had nothing to say both
    // produce no context, and silently conflating them would let a broken build
    // score as "the graph did not help" -- turning a bug into a measurement.
    if (r.error) throw r.error;
    if (r.status !== 0) {
      throw new Error(`hook exited ${r.status} for ${c.id}: ${String(r.stderr).slice(0, 400)}`);
    }
    let injected = null;
    const stdout = String(r.stdout || '').trim();
    if (stdout) {
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error(`hook wrote non-JSON for ${c.id}: ${stdout.slice(0, 200)}`);
      }
      injected = parsed?.hookSpecificOutput?.additionalContext ?? null;
    }

    out.push({ id: c.id, task: c.task, injected });
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('ab-injection-harness.mjs')) {
  const arms = buildArms();
  console.log(JSON.stringify(arms, null, 2));
}
