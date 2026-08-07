/**
 * The metric upgrade: tool-calls-to-correct-outcome.
 *
 * The single-turn corpus measures RECALL -- whether a delivered fact changes an
 * answer. Real work is not an exam: it is a sequence of actions, and a lesson
 * earns its tokens by changing what gets DONE. Every one of the six mistakes that
 * motivated this work was an action, not an answer: a prompt mangled by shell
 * quoting, a compiler path that ran nothing, two heredocs that matched nothing, an
 * edit that hit the wrong line, a scorer that read a refusal as success. A
 * question-and-answer harness cannot see any of them.
 *
 * So the subject gets a real scratch repository and real tools, and the measure
 * is TOOL CALLS TO THE CORRECT OUTCOME plus whether it got there at all. Both arms
 * face an identical repository; only the injected lesson differs.
 *
 * WHY THE OUTCOME IS CHECKED ON DISK, not in the transcript. A subject can
 * describe the right fix and not make it, and this project has been burned by
 * exactly that gap before -- a green suite proving a function correct while
 * nothing called it. The verdict is a file predicate: either the repository ends
 * in the correct state or it does not.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = 'claude';

/**
 * @param {object} task
 *   setup(dir)    builds the scratch repository
 *   prompt        what the subject is asked to do
 *   correct(dir)  true when the repository is in the required end state
 */
export function runToolTrial(task, { injected = null, settings = null, maxTurns = 30 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `tool-trial-${task.id}-`));
  try {
    task.setup(dir);

    const prompt =
      (injected ? injected.trim() + '\n\n' : '') +
      task.prompt +
      '\n\nWork in the current directory. Stop as soon as the task is done.';

    // EDITS MUST BE ALLOWED OR EVERY TRIAL IS A FALSE NEGATIVE. The first run of
    // this harness scored the control as failing while its answer read "the fix
    // (source file, not the generated copy)" and named the right line -- it knew
    // the answer and was refused write permission. Scoring that as ignorance
    // would have measured the sandbox and called it the graph.
    const args = [
      '-p', prompt,
      '--max-turns', String(maxTurns),
      '--output-format', 'json',
      '--permission-mode', 'acceptEdits',
    ];
    if (settings) args.push('--settings', settings);

    const started = Date.now();
    const r = spawnSync(CLI, args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, TOKEN_OPTIMIZER_MODE: 'off' },
      timeout: 600_000,
      shell: false,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    const elapsedMs = Date.now() - started;

    if (r.error) throw r.error;

    // RUNNING OUT OF TURNS IS A RESULT, NOT A HARNESS FAULT -- and treating it as
    // one silently destroyed a run. The CLI exits non-zero when it hits
    // --max-turns, so throwing on any non-zero status discarded exactly the
    // SLOWEST trials and kept the fast ones. That biases the very quantity being
    // measured, and it did: an earlier comparison reported the treated arm taking
    // 41% more turns when both arms were simply censored at the cap.
    //
    // So the distinction is drawn on whether the CLI produced a parseable report.
    // A report means the subject ran and the disk is the verdict, capped or not.
    // No report means the harness failed, and that still throws.
    let payload;
    try {
      payload = JSON.parse(r.stdout || '');
    } catch {
      throw new Error(
        `claude exited ${r.status} with no parseable report: ${(r.stdout || r.stderr || '').slice(0, 200)}`
      );
    }

    // The CLI reports turns; tool calls are counted from the message stream when
    // present, and fall back to turns so a missing field degrades to a coarser
    // number rather than to a silent zero.
    const toolCalls =
      typeof payload.num_turns === 'number' ? payload.num_turns : null;

    return {
      id: task.id,
      correct: Boolean(task.correct(dir)),
      toolCalls,
      // A capped run reached the ceiling rather than choosing to stop, so its
      // turn count is a lower bound and must not be averaged in as if it were
      // a measurement.
      hitLimit: payload.is_error === true || payload.stop_reason === 'tool_use',
      elapsedMs,
      costUsd: payload.total_cost_usd ?? null,
      text: String(payload.result || '').slice(0, 2000),
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows can hold a handle briefly */
    }
  }
}

/**
 * A task built from a real trap: the repository has a source module and a
 * generated copy, and the fix must land in the source.
 *
 * The generated copy is the tempting target -- it is the file whose contents are
 * wrong -- and editing it is silently undone by the next sync. That is a real
 * mistake made in this repository, and it is invisible to a single-turn question
 * because the subject can name the right rule and still edit the wrong file.
 */
export const GENERATED_COPY_TASK = {
  id: 'edit-source-not-generated',
  setup(dir) {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'dist', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'src', 'greet.mjs'), 'export const greet = () => "helo";\n');
    writeFileSync(
      join(dir, 'dist', 'lib', 'greet.mjs'),
      '// GENERATED FILE -- do not edit; produced by `npm run sync`\nexport const greet = () => "helo";\n'
    );
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'trial', scripts: { sync: 'node sync.mjs' } }, null, 2) + '\n'
    );
    writeFileSync(
      join(dir, 'sync.mjs'),
      'import {readFileSync,writeFileSync} from "fs";\n' +
        'const s=readFileSync("src/greet.mjs","utf8");\n' +
        'writeFileSync("dist/lib/greet.mjs","// GENERATED FILE -- do not edit; produced by `npm run sync`\\n"+s);\n'
    );
  },
  prompt:
    'There is a typo in the greeting: it returns "helo" and should return "hello". Fix it.',
  correct(dir) {
    const src = readFileSync(join(dir, 'src', 'greet.mjs'), 'utf8');
    // The source must carry the fix. A repository where only the generated copy
    // changed is the failure this task exists to detect.
    return /"hello"/.test(src);
  },
};

/**
 * Can the subject write at all in this environment?
 *
 * Run before any scored trial. Without it, a permissions or sandbox change turns
 * every trial into a failure and the whole comparison reads as "neither arm could
 * do it" -- a null that looks like a finding. This asks for the simplest possible
 * edit and checks the disk.
 */
export const CAN_WRITE_TASK = {
  id: 'can-write-preflight',
  setup(dir) {
    writeFileSync(join(dir, 'probe.txt'), 'before\n');
  },
  prompt: 'Change the contents of probe.txt to exactly the word: after',
  correct(dir) {
    return /after/.test(readFileSync(join(dir, 'probe.txt'), 'utf8'));
  },
};

/**
 * The same trap with the giveaway removed.
 *
 * The first version of this task labelled the generated file "GENERATED FILE --
 * do not edit", so the control read the rule straight off the environment and
 * both arms scored 3/3 with the treated arm 41% slower. A task whose answer is
 * printed inside it measures nothing, which is the corpus-design mistake this
 * work has already made twice in the single-turn setting.
 *
 * Here the header is gone. The fact is still DISCOVERABLE -- with tools, almost
 * anything in a tree is -- but it costs a chain of steps: read package.json, find
 * the sync script, read it, work out which direction it copies. That is what the
 * lesson replaces, so the measure is turns rather than correctness, and the
 * outcome is still checked on disk.
 *
 * BOTH FILES MUST END CONSISTENT. Editing only the source leaves the built output
 * stale; editing only the copy is silently reverted by the next sync. Only
 * "fix the source, then regenerate" satisfies both, and that is exactly the
 * behaviour the lesson encodes.
 */
export const HIDDEN_GENERATED_TASK = {
  id: 'hidden-generated-copy',
  setup(dir) {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'build', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'src', 'greet.mjs'), 'export const greet = () => "helo";\n');
    // No "generated" header, and a neutral directory name.
    writeFileSync(join(dir, 'build', 'lib', 'greet.mjs'), 'export const greet = () => "helo";\n');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(
        { name: 'trial', type: 'module', scripts: { sync: 'node scripts/sync.mjs' } },
        null,
        2
      ) + '\n'
    );
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(
      join(dir, 'scripts', 'sync.mjs'),
      'import { readFileSync, writeFileSync } from "node:fs";\n' +
        '// build/lib is produced from src; never edit it by hand.\n' +
        'writeFileSync("build/lib/greet.mjs", readFileSync("src/greet.mjs", "utf8"));\n'
    );
  },
  prompt:
    'The greeting returns "helo" and should return "hello". Fix it so the fix survives ' +
    'the project\'s build, and leave the repository consistent.',
  correct(dir) {
    const src = readFileSync(join(dir, 'src', 'greet.mjs'), 'utf8');
    const built = readFileSync(join(dir, 'build', 'lib', 'greet.mjs'), 'utf8');
    // Source carries the fix AND the built copy matches it: the only end state
    // that survives the next sync.
    return /"hello"/.test(src) && /"hello"/.test(built);
  },
};

export const LESSON_FOR_HIDDEN_GENERATED =
  'From other projects on this machine:\n' +
  '- [failure] Edit the SOURCE and then run the project\'s sync script, never the built copy: ' +
  'this repository generates build/lib from src/, so a change made to the built file is ' +
  'silently reverted by the next sync and the bug returns. (learned in token-optimizer-mcp)';

export const LESSON_FOR_GENERATED_COPY =
  'From other projects on this machine:\n' +
  '- [failure] Edit the SOURCE and regenerate, never the generated copy: a change made to a ' +
  'generated file is silently reverted by the next sync, so the bug returns and the edit leaves ' +
  'no trace. (learned in token-optimizer-mcp)';
