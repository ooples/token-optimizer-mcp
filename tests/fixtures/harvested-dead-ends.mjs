/**
 * Dead-ends this project actually hit, harvested rather than invented.
 *
 * WHY A SECOND CORPUS. The hand-written cases in ab-injection-harness.mjs were
 * authored by someone who already knew the answers, and it showed: three of the
 * five failed to catch the control at all. A case the control gets right
 * measures nothing, and a corpus full of them can make the graph look useless or
 * useful depending only on which easy cases happen to be in it.
 *
 * These are different. Every one cost real time in this repository, every one is
 * recorded with the symptom that was actually observed, and none is inferable by
 * reading the code in the time budget the subject is given -- which is the
 * condition the proof protocol requires and the hand-written set only partly
 * met.
 *
 * THE CLASS FIELD IS THE POINT. The multi-turn run showed that a dead-end only
 * fires when verification is expensive: given tools, the subject runs `ls` and
 * the trap never springs. So each case records WHY it is hard, and the four
 * classes are measured separately rather than averaged into one rate:
 *
 *   expensive      the failure only surfaces after costly work -- a timeout, a
 *                  full build, a CI round trip. Cheap inspection cannot settle
 *                  it, so prior knowledge is the only shortcut.
 *   plausible      no error at all. The wrong path looks exactly like success,
 *                  so the subject has no signal that it needs to look further.
 *   non-inferable  the fact lives in history or in a person's head, not in the
 *                  tree. No amount of local reading produces it.
 *   restricted     fires only when the subject cannot reach for the cheap check.
 *                  Reported SEPARATELY and never in the headline: handicapping
 *                  the control is not a fair comparison, it is a demonstration.
 *
 * Each case carries `symptom` -- what was actually seen when it bit -- because a
 * claim without its symptom is unfalsifiable, and the whole point of this corpus
 * is that these are checkable against real history.
 */

export const HARVESTED = [
  {
    id: 'crlf-canary-noop',
    class: 'plausible',
    symptom:
      'A canary that removed a guard reported PASS. The guard looked load-bearing. ' +
      'The edit had matched nothing: the anchor used \\n and the file was CRLF.',
    claim:
      'A canary edit that silently fails to apply reports PASS, which reads as "the guard works". ' +
      'Anchors written with \\n match nothing in a CRLF file. Assert the edit applied before trusting the result.',
    trigger: 'canary|sabotage|revert the guard',
    task:
      'You are about to verify that a test really guards a behaviour, by temporarily breaking the ' +
      'behaviour and checking the test fails. Describe the procedure you would follow. Be specific ' +
      'about how you know the result is trustworthy.',
    // Walks in: trusts the pass/fail outcome without confirming the sabotage landed.
    walksIn: (s) =>
      !/(verify|confirm|assert|check).{0,40}(applied|landed|took effect|actually chang)/i.test(
        s
      ) && !/grep|diff|print the (file|line)|read it back/i.test(s),
    avoids: (s) =>
      /(verify|confirm|assert|check).{0,40}(applied|landed|took effect|actually chang)/i.test(
        s
      ) || /grep|diff|print the (file|line)|read it back/i.test(s),
  },

  {
    id: 'spawnsync-stub-deadlock',
    class: 'expensive',
    symptom:
      'A test spawned a child that called a stub HTTP server in the SAME process, using spawnSync. ' +
      'The child waited for a response the blocked event loop could never send. 60s timeout, exit null.',
    claim:
      'spawnSync blocks the event loop, so a child process cannot be served by an HTTP stub running ' +
      'in the same process -- both sides wait until the timeout. Use async spawn when the test is also the server.',
    trigger: 'spawnSync|spawn.*test server|stub server',
    task:
      'You are writing a test that spawns a CLI as a child process. The CLI makes an HTTP request, ' +
      'and you want to answer it from a stub server you start inside the test itself. Outline how you ' +
      'would spawn the child. State which child_process function you use and why.',
    walksIn: (s) =>
      /spawnSync/i.test(s) &&
      !/(async|await|non-?blocking|event loop|deadlock)/i.test(s),
    // `(?!.*spawnSync)` only constrains the position where the match STARTS,
    // so an answer naming spawnSync first and `spawn(` later satisfied it. The
    // exclusion has to be a separate test over the whole answer.
    // NAMING THE FIX, NOT THE FAILURE. Merely mentioning "deadlock" scored as
    // avoided -- which meant the recorded SYMPTOM, a description of the bug,
    // counted as a correct answer. Credit requires choosing the non-blocking
    // call, or explicitly rejecting spawnSync for this use.
    avoids: (s) =>
      (!/spawnSync/i.test(s) &&
        /(\bspawn\s*\(|\bexecFile\b|\bexeca\b)/i.test(s)) ||
      /(do not|don't|never|avoid|not).{0,30}spawnSync/i.test(s) ||
      (/spawnSync.{0,80}(would |will )?(block|deadlock)/i.test(s) &&
        /(\bspawn\s*\(|\basync\b|\bawait\b)/i.test(s)),
  },

  {
    id: 'once-per-session-gate',
    class: 'plausible',
    symptom:
      'An A/B harness produced injected context on its first run and null on every run after. ' +
      'The session id was fixed, and the once-per-session gate persists to disk.',
    claim:
      'Injection is once-per-session and the gate persists to disk, so any harness reusing a fixed ' +
      'session id works exactly once. The treatment arm silently degrades into a second control arm.',
    trigger: 'session_id|harness|A/B|buildArms',
    task:
      'You are writing a harness that measures whether injected context helps. It runs a hook that ' +
      'serves context once per session. What must the harness do about session identity, and how ' +
      'would you know it is still working on the tenth run?',
    // The lesson can be stated either as the fix (a new session id per run) or
    // as the failure mode it prevents (reusing one works exactly once). Both
    // count; only an answer that does neither walks in.
    avoids: (s) =>
      /(unique|fresh|random|new|different).{0,30}session/i.test(s) ||
      /per[- ]run/i.test(s) ||
      /(reus|fixed|same).{0,40}session.{0,60}(once|first run|only work)/i.test(
        s
      ),
    walksIn: (s) =>
      !/(unique|fresh|random|new|different).{0,30}session/i.test(s) &&
      !/per[- ]run/i.test(s) &&
      !/(reus|fixed|same).{0,40}session.{0,60}(once|first run|only work)/i.test(
        s
      ),
  },

  {
    id: 'failopen-smoke-test',
    class: 'expensive',
    symptom:
      'A test that runs every hook entry point stayed green with a required import deleted. ' +
      'main() returned early before reaching the line that would have thrown.',
    claim:
      'Running a fail-open hook does not exercise its body: it returns early on missing input, so a ' +
      'missing import survives a smoke test. Catching that needs static analysis (no-undef), not execution.',
    trigger: 'smoke test|hook.*load|entry point',
    task:
      'You want a test that catches a missing import in a set of CLI scripts. Each script is designed ' +
      'to fail open: on unusable input it exits 0 without doing anything. Describe the check you would ' +
      'write, and say what it would miss.',
    // `AST` needs a word boundary and case sensitivity: with /i and no
    // boundary it matched inside "last", "fast", "past" and "cast", which
    // INVERTED the score on perfectly ordinary answers.
    walksIn: (s) =>
      /(run|execute|spawn|invoke)/i.test(s) &&
      !/(lint|no-undef|static|parse|eslint)/i.test(s) &&
      !/\bAST\b/.test(s),
    avoids: (s) =>
      /(lint|no-undef|static analys|eslint)/i.test(s) || /\bAST\b/.test(s),
  },

  {
    id: 'batch-origin-collapse',
    class: 'non-inferable',
    symptom:
      'Verified human corrections were stored with ORIGIN_HARVESTED. The selector that serves them ' +
      'filters on human origin, so it matched nothing the pipeline had ever written.',
    claim:
      'A write path taking one batch-wide origin discards per-item provenance computed upstream. ' +
      'The consumer filtered on the discarded value, so a whole feature ran and delivered nothing.',
    trigger: 'writeHarvested|origin|provenance',
    task:
      'A pipeline validates items and computes a per-item trust level, then hands the whole batch to a ' +
      'writer that takes a single trust level as an option. A downstream consumer selects only the ' +
      'highest trust level. What is the bug, and how would you have detected it?',
    walksIn: (s) =>
      !/(per[- ]item|per[- ]finding|each item).{0,50}(origin|provenance|trust)/i.test(
        s
      ),
    avoids: (s) =>
      /(per[- ]item|per[- ]finding|each item|individual).{0,60}(origin|provenance|trust|level)/i.test(
        s
      ) || /batch.{0,40}(discard|overwrit|lose|collaps)/i.test(s),
  },

  {
    id: 'detached-exit-crash',
    class: 'expensive',
    symptom:
      'A detached worker aborted with 0xC0000409 on every Windows run: process.exit() fired while ' +
      'the sockets from an HTTP call were still closing. Silent, because nothing reads a detached exit status.',
    claim:
      'Calling process.exit() immediately after an HTTP call crashes on Windows -- libuv asserts when ' +
      'the process exits while handles are still closing. Let the loop drain and use an unref’d watchdog instead.',
    trigger: 'process\\.exit|detached|worker',
    task:
      'A detached background worker makes an HTTP request, writes a file, and must never linger. ' +
      'Write the last three lines of that script -- how it terminates. Explain the choice.',
    // The symptom itself says "still closing", so crediting that phrase made a
    // description of the crash score as a correct answer. Credit requires
    // naming what the script should DO instead.
    walksIn: (s) =>
      /process\.exit\(/i.test(s) && !/(unref|exitCode|drain|watchdog)/i.test(s),
    avoids: (s) =>
      /(\bunref\b|exitCode|let the loop drain|\bwatchdog\b)/i.test(s),
  },

  {
    id: 'squash-merge-cherry',
    class: 'non-inferable',
    symptom:
      'git cherry reported every commit of a merged PR as unmerged, because the PR was squashed. ' +
      'Rebasing then tried to replay work already in master and conflicted.',
    claim:
      'After a squash merge, git cherry and patch-id comparisons report the original commits as ' +
      'unmerged, because the squashed commit has a different patch id. Rebase --onto the branch point instead.',
    trigger: 'git cherry|rebase|squash',
    task:
      'A PR you branched from has been merged into master with a squash merge. Your branch still has ' +
      'its original commits. Describe how you get your branch onto current master without replaying ' +
      'work that is already there.',
    walksIn: (s) => /git cherry|patch[- ]id/i.test(s) && !/squash/i.test(s),
    avoids: (s) =>
      /(--onto|squash.{0,40}(different|new) (patch|commit)|drop.{0,30}already)/i.test(
        s
      ),
  },

  {
    id: 'checkout-b-keeps-changes',
    class: 'plausible',
    symptom:
      'git checkout -B on a new start point silently carried uncommitted edits onto the new branch. ' +
      'A fix meant for one branch appeared on another, and the anchor for re-applying it was already gone.',
    claim:
      'git checkout -B moves HEAD but keeps uncommitted working-tree changes, so edits follow you onto ' +
      'the new branch. Stash or commit first if the new branch is meant to be clean.',
    trigger: 'checkout -B|checkout -b|new branch',
    task:
      'You have uncommitted changes on branch A. You want a NEW branch off origin/master that does not ' +
      'contain them. State the exact git commands, in order.',
    walksIn: (s) =>
      /checkout -[bB]/.test(s) &&
      !/(stash|commit|worktree|-- \.|restore)/i.test(s),
    avoids: (s) =>
      /(stash|commit first|git worktree|git restore|checkout -- )/i.test(s),
  },
];

/** The classes reported separately. `restricted` never enters the headline. */
export const CLASSES = [
  'expensive',
  'plausible',
  'non-inferable',
  'restricted',
];

/** Every case must be scoreable, or it silently contributes nothing. */
export function corpusProblems(cases = HARVESTED) {
  const problems = [];
  const seen = new Set();
  for (const c of cases) {
    if (seen.has(c.id)) problems.push(`duplicate id: ${c.id}`);
    seen.add(c.id);
    if (!CLASSES.includes(c.class))
      problems.push(`${c.id}: unknown class ${c.class}`);
    for (const field of ['symptom', 'claim', 'trigger', 'task']) {
      if (!c[field] || !String(c[field]).trim())
        problems.push(`${c.id}: empty ${field}`);
    }
    if (typeof c.walksIn !== 'function' || typeof c.avoids !== 'function') {
      problems.push(`${c.id}: missing scorer`);
    }
  }
  return problems;
}
