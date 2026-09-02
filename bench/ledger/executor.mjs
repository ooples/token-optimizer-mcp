/**
 * Driving a real agent in a container, and turning one run into one row.
 *
 * This is the only part of Ledger that spends money, and it is deliberately the
 * thinnest part: it starts a container, reads three numbers out of the agent's
 * own JSON, and hands the workspace back. It scores nothing -- the verifier
 * belongs to the task, so an executor cannot influence its own mark.
 *
 * THE SUCCESS SIGNAL IS `is_error`, NEVER `subtype`. Measured against the real
 * CLI: an unauthenticated run returns
 *
 *     { subtype: "success", is_error: true, num_turns: 1,
 *       total_cost_usd: 0, result: "Not logged in - Please run /login" }
 *
 * so a harness keying on `subtype` would record that as a SUCCESSFUL run
 * costing nothing -- an infinitely efficient optimizer, arriving silently, for
 * every run in a campaign whose credentials had expired. The credentials in
 * this rig are short-lived by design, which makes that failure likely rather
 * than hypothetical.
 *
 * COST IS RECORDED EVEN WHEN THE RUN FAILS, because the ledger charges
 * failures. A run that burned four turns and died still spent that money, and
 * the row has to say so.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where the agent works, and where its state lives, inside the container. */
/** A run that produced no usage still needs every column, so a report can sum. */
export const EMPTY_TOKENS = Object.freeze({
  input: 0,
  output: 0,
  cache_creation: 0,
  cache_read: 0,
  web_search: 0,
  web_fetch: 0,
});

const WORK = '/work';
const STATE = '/state';

/**
 * Runs a command, capturing stdout/stderr, with a hard timeout.
 *
 * Injected as a parameter everywhere below so the executor's own logic --
 * argument construction, JSON parsing, failure classification -- is testable
 * without docker or an API key.
 */
export function realSpawn(command, args, { timeoutMs = 900_000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL rather than SIGTERM: a wedged container that ignores a polite
      // signal would otherwise hold the campaign open indefinitely.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error), timedOut });
    });
  });
}

/**
 * Turns the agent's JSON into the three numbers a row needs.
 *
 * Exported and pure, because this is where a harness silently goes wrong and it
 * should be pinned by tests rather than trusted.
 */
export function readOutcome({ code, stdout, stderr, timedOut }) {
  if (timedOut) {
    return { status: 'timeout', usd: 0, turns: 0, tokens: EMPTY_TOKENS, detail: 'killed after timeout' };
  }

  let parsed = null;
  try {
    // The CLI prints one JSON object in --output-format json. Anything else --
    // a crash, a usage message -- is not a run and must not be read as one.
    parsed = JSON.parse(stdout.trim());
  } catch {
    return {
      status: 'error',
      usd: 0,
      turns: 0,
      tokens: EMPTY_TOKENS,
      detail: `unparseable output (exit ${code}): ${(stderr || stdout).slice(0, 300)}`,
    };
  }

  const usd = Number(parsed.total_cost_usd) || 0;
  const turns = Number(parsed.num_turns) || 0;

  // THE TOKEN BREAKDOWN, because cost alone cannot say WHERE the money went.
  //
  // Diagnosing the leader took exactly this decomposition and Ledger could not
  // produce it: on matched tasks their output tokens are 0.722 of control while
  // their cache_read is 0.784 and their cache_creation 0.909 -- and output is
  // billed at $15/M against cache_read's $0.30/M, so a 28% cut in the smallest
  // column is worth more than a 22% cut in the largest. A harness that records
  // only total_cost_usd can compare arms but cannot tell you which lever moved,
  // which is how this product spent its life optimising the cheapest token
  // class.
  const u = parsed.usage || {};
  const tokens = {
    input: Number(u.input_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    cache_creation: Number(u.cache_creation_input_tokens) || 0,
    cache_read: Number(u.cache_read_input_tokens) || 0,
    // Server-side tool use is billed separately and is NOT in any token column.
    // It was 76% of one benchmark task's cost, invisible to every token-based
    // model of that task, so it is captured rather than inferred.
    web_search: Number(u.server_tool_use?.web_search_requests) || 0,
    web_fetch: Number(u.server_tool_use?.web_fetch_requests) || 0,
  };

  // `is_error`, not `subtype`, and not the exit code either: the CLI exits 0 on
  // an authentication failure while reporting is_error true.
  if (parsed.is_error) {
    return { status: 'failed', usd, turns, tokens, detail: String(parsed.result || '').slice(0, 300) };
  }
  return { status: 'ok', usd, turns, tokens, detail: null };
}

/**
 * The arm's Claude Code settings, written where the container can read them.
 *
 * An arm IS its settings plus its environment: which hooks are bound, whether
 * an MCP server is declared, what mode the optimizer runs in. Keeping that as
 * plain settings JSON means an arm is reproducible by anyone with the file, and
 * that no arm-specific code path exists in this harness to be got wrong.
 */
export function writeArmSettings(dir, arm) {
  const path = join(dir, 'settings.json');
  writeFileSync(path, JSON.stringify(arm.settings ?? {}, null, 2));
  return path;
}

/**
 * Builds the docker arguments for one run.
 *
 * Pure and exported so the mounts and flags are asserted by tests rather than
 * discovered to be wrong halfway through a paid campaign.
 */
export function dockerArgs({
  image,
  workspace,
  stateDir,
  armDir,
  credentials,
  prompt,
  model,
  env = {},
  network = 'bridge',
}) {
  const args = [
    'run', '--rm',
    '-v', `${workspace}:${WORK}`,
    '-v', `${stateDir}:${STATE}`,
    '-v', `${armDir}:/arm:ro`,
    '-v', `${credentials}:/auth/credentials.json:ro`,
    // HOME IS THE STATE DIRECTORY, which is the whole cold/warm mechanism: a
    // fresh directory is a cold run, a shared one is a warm sequence. Nothing
    // else needs to change between the two tracks.
    '-e', `HOME=${STATE}`,
    '-w', WORK,
    '--network', network,
  ];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);

  // THE PROMPT TRAVELS AS AN ENVIRONMENT VARIABLE, NEVER INSIDE THE SCRIPT.
  //
  // Interpolating it -- even via JSON.stringify -- corrupts it silently, and
  // this was caught on a real run rather than reasoned about. JSON.stringify
  // escapes quotes and backslashes but NOT backticks, so a prompt containing
  // inline code went into a double-quoted shell string and `timeout_ms` became
  // command substitution: sh ran it, got nothing, and the agent received "the
  // value of the  key". It then answered sensibly, asked which key was meant,
  // exited 0, and scored 0 -- so the run looked like the ARM failing the task.
  //
  // Backticks in a prompt are ordinary. Docker passes -e values to the process
  // without shell interpretation, and "$VAR" expansion does not re-run
  // substitution on the expanded value, so this is the form that cannot be
  // mangled by content.
  args.push('-e', `LEDGER_PROMPT=${prompt}`);

  args.push('--entrypoint', 'sh', image, '-c', containerScript({ model }));
  return args;
}

/**
 * The script the container runs.
 *
 * Credentials are copied rather than used in place because the CLI rewrites the
 * file when it refreshes a token, and the mount is read-only -- deliberately,
 * so a container cannot corrupt the host's live credentials.
 */
function containerScript({ model }) {
  // The model name is ours and constrained, so interpolating it is safe; the
  // PROMPT is arbitrary text from a task and never appears here at all.
  const modelFlag = model ? `--model ${JSON.stringify(model)}` : '';
  return [
    'set -e',
    'mkdir -p "$HOME/.claude"',
    'cp /auth/credentials.json "$HOME/.claude/.credentials.json"',
    'chmod 600 "$HOME/.claude/.credentials.json"',
    // "$LEDGER_PROMPT" in double quotes: expanded verbatim, with no further
    // word-splitting, globbing or command substitution applied to its value.
    // stderr stays separate so a warning cannot corrupt the JSON on stdout.
    `exec claude -p "$LEDGER_PROMPT" --output-format json ` +
      `--settings /arm/settings.json ${modelFlag} --dangerously-skip-permissions`,
  ].join('\n');
}

/**
 * An executor bound to an image, credentials and arm, ready to hand to the
 * campaign runner.
 *
 * The workspace is created and set up on the HOST and mounted in, so the
 * verifier can read it afterwards without extracting anything from a container
 * that no longer exists.
 */
export function dockerExecutor({
  image,
  credentials,
  arms,
  model,
  timeoutMs = 900_000,
  spawnFn = realSpawn,
  workRoot = tmpdir(),
  keepWorkspaces = false,
} = {}) {
  if (!image) throw new Error('dockerExecutor requires an image');
  if (!credentials) throw new Error('dockerExecutor requires a credentials path');

  const armDirs = new Map();
  const ensureArmDir = (armName) => {
    if (armDirs.has(armName)) return armDirs.get(armName);
    const arm = arms?.[armName];
    if (!arm) throw new Error(`unknown arm: ${armName}`);
    const dir = mkdtempSync(join(workRoot, `ledger-arm-${armName}-`));
    writeArmSettings(dir, arm);
    armDirs.set(armName, dir);
    return dir;
  };

  return async function execute({ task, arm, track, rep, stateDir }) {
    const workspace = mkdtempSync(join(workRoot, `ledger-ws-${task.id}-`));
    try {
      task.setup(workspace);
    } catch (error) {
      // A fixture that cannot be built is a harness fault, not an agent result.
      // It must not be scored as a failed run -- that would charge the arm for
      // our bug and quietly depress its number.
      //
      // FREED HERE, because this is the one exit that returns `workspace: null`.
      // Everywhere else the caller releases the directory once scoring has read
      // it, and that release is driven off the returned workspace -- so on this
      // path nobody holds a reference and the directory leaks for the life of
      // the machine. A fixture that fails usually fails for every rep, which
      // turns one bug into hundreds of abandoned trees.
      discardWorkspace(workspace);
      return { status: 'setup-error', usd: 0, turns: 0, workspace: null, error: String(error) };
    }

    // A RULES FILE IS PART OF AN ARM, because for the leader it IS the arm.
    // Their CLI is invoked 0.38 times per task while their claude_md carries
    // the output discipline that moves their numbers, so an arm format that
    // could only express hooks and environment could not represent them at all
    // -- and a head-to-head of the mechanism that actually works would have
    // been impossible to run.
    //
    // Written into the WORKSPACE rather than injected, because that is how the
    // client loads it natively and how they ship it. Delivery differs between
    // us and them, and the comparison has to preserve that.
    // RESOLVED THROUGH ensureArmDir FIRST, which is what raises "unknown arm".
    // Reading arms[arm] directly here bypassed that guard and turned a clear
    // error into "Cannot read properties of undefined (reading 'claudeMd')" --
    // I broke the loud failure while adding a feature beside it.
    const armDir = ensureArmDir(arm);
    const definition = arms[arm];
    if (definition.claudeMd) {
      writeFileSync(join(workspace, 'CLAUDE.md'), definition.claudeMd);
    }

    const state = stateDir || mkdtempSync(join(workRoot, `ledger-state-${arm}-`));
    mkdirSync(state, { recursive: true });

    const result = await spawnFn(
      'docker',
      dockerArgs({
        image,
        workspace,
        stateDir: state,
        armDir,
        credentials,
        prompt: task.prompt,
        model,
        env: arms[arm].env || {},
      }),
      { timeoutMs }
    );

    const outcome = readOutcome(result);

    return {
      status: outcome.status,
      usd: outcome.usd,
      turns: outcome.turns,
      tokens: outcome.tokens || EMPTY_TOKENS,
      // WHETHER a workspace may be freed is decided here, because this layer
      // owns the flag; WHEN it is freed is decided in run.mjs, because that is
      // where scoring finishes reading it. Splitting the two is deliberate --
      // the previous attempt put both here and could not free anything, since
      // the verifier had not run yet, so the block was left empty and
      // `keepWorkspaces` silently did nothing at all.
      //
      // Only FAILURES are worth keeping: they are the ones an operator opens to
      // find out what the agent did. A successful run's workspace is the
      // expected output and is never inspected, so it is freed either way --
      // otherwise the flag trades a debugging aid for a full disk.
      keepWorkspace: keepWorkspaces && outcome.status !== 'ok',
      // The verifier reads the host directory. Handed back on failure too, so a
      // partially-completed run can still earn partial credit -- an agent that
      // fixed the bug and then timed out did do some of the work.
      workspace,
      error: outcome.detail,
      track,
      rep,
    };
  };
}

/** Frees a workspace the caller is finished scoring. */
export function discardWorkspace(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is not worth failing a campaign over */
  }
}
