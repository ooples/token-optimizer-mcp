/**
 * The harvest model the machine already has.
 *
 * Semantic extraction has always required an API key or a local endpoint. On a
 * machine with neither it does not run at all -- measured on the development
 * machine for this package, 3 harvested findings against 237 written by the
 * agent itself, because nobody configures a variable they have never heard of.
 * Yet the client that just ran the session is installed by definition, and
 * every one of them ships a headless mode. So the model was already there.
 *
 * These tests hold the two things that make that safe rather than merely
 * clever: the child must not re-enter the harvest, and the payload has to
 * reach each client the way that client actually accepts it. Both failed
 * silently when first written -- the enablement gate answered `off:no-key`
 * before the CLI path was ever consulted, and `copilot` given a prompt on
 * stdin answers that it cannot read stdin and exits 0.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extract,
  harvestFailure,
  harvestMode,
  harvestEnabled,
  hostCliHarvest,
  ARG_STDIN_INSTRUCTION,
} from '../../hooks-core/harvest.mjs';
import { CLIENT_CAPABILITIES, CLIENT_HARVEST_CLI, harvestCliFor } from '../../hooks-core/capabilities.mjs';

const FINDING = {
  type: 'command',
  claim: 'the stub CLI answered',
  evidence: 'printed by the stub',
  applicability: 'while proving the host-CLI transport works',
  confidenceLabel: 'verified',
  anchors: ['hooks-core/harvest.mjs'],
};

let dir;
let stub;
let record;
let saved;

/**
 * A stand-in for a host CLI.
 *
 * Records what it was handed -- argv, stdin, and the mode variable it
 * inherited -- then prints a reply. `banner` reproduces the thing that broke
 * the first parser: `codex exec` prints `sandbox: workspace-write [workdir,
 * /tmp, $TMPDIR]` before the model speaks, so the first `[` in the stream is
 * not the findings array.
 */
const STUB = `
import { readFileSync, writeFileSync } from 'node:fs';
const out = process.env.STUB_RECORD;
let stdin = '';
if (!process.env.STUB_IGNORE_STDIN) {
  try {
    stdin = readFileSync(0, 'utf8');
  } catch {
    stdin = '';
  }
}
const named = (process.argv.slice(2).join(' ').match(/(\\S+token-optimizer-harvest-\\S+\\.txt)/) || [])[1];
writeFileSync(
  out,
  JSON.stringify({
    argv: process.argv.slice(2),
    promptFile: named ? readFileSync(named, 'utf8') : null,
    stdin,
    mode: process.env.TOKEN_OPTIMIZER_MODE ?? null,
    harvestCli: process.env.TOKEN_OPTIMIZER_HARVEST_CLI ?? null,
  })
);
if (process.env.STUB_BANNER) {
  process.stdout.write('sandbox: workspace-write [workdir, /tmp, $TMPDIR]\\n');
}
if (process.env.STUB_SILENT) process.exit(Number(process.env.STUB_EXIT || 0));
process.stdout.write('Here is what I found:\\n');
process.stdout.write(process.env.STUB_REPLY + '\\n');
process.stdout.write('Let me know if you want more.\\n');
process.exit(Number(process.env.STUB_EXIT || 0));
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'host-cli-harvest-'));
  stub = join(dir, 'stub.mjs');
  record = join(dir, 'record.json');
  writeFileSync(stub, STUB);
});

beforeEach(() => {
  saved = { ...process.env };
  for (const key of [
    'TOKEN_OPTIMIZER_HARVEST_ENDPOINT',
    'ANTHROPIC_API_KEY',
    'TOKEN_OPTIMIZER_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'TOKEN_OPTIMIZER_MODE',
    'TOKEN_OPTIMIZER_HARVEST',
  ]) {
    delete process.env[key];
  }
  process.env.STUB_RECORD = record;
  process.env.STUB_REPLY = JSON.stringify([FINDING]);
  delete process.env.STUB_BANNER;
  delete process.env.STUB_SILENT;
  delete process.env.STUB_IGNORE_STDIN;
  delete process.env.STUB_EXIT;
  if (existsSync(record)) rmSync(record);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

const asStdinCli = () => {
  process.env.TOKEN_OPTIMIZER_HARVEST_CLI = '1';
  // Quoted: on Windows process.execPath is under `C:\Program Files`, and an
  // unquoted split reported `C:\Program exited 1`.
  process.env.TOKEN_OPTIMIZER_HARVEST_CLI_COMMAND = `"${process.execPath}" "${stub}"`;
};
const asArgStdinCli = () => {
  process.env.TOKEN_OPTIMIZER_HARVEST_CLI = '1';
  process.env.TOKEN_OPTIMIZER_HARVEST_CLI_COMMAND = `"${process.execPath}" "${stub}" {-}`;
};
const asFileCli = () => {
  process.env.TOKEN_OPTIMIZER_HARVEST_CLI = '1';
  process.env.TOKEN_OPTIMIZER_HARVEST_CLI_COMMAND = `"${process.execPath}" "${stub}" {}`;
};
const handed = () => JSON.parse(readFileSync(record, 'utf8'));

describe('every supported client declares how it can be harvested', () => {
  test('all 16 clients have a row -- a CLI or an explicit null', () => {
    const clients = Object.keys(CLIENT_CAPABILITIES);
    expect(clients.length).toBe(16);
    for (const client of clients) {
      expect(Object.prototype.hasOwnProperty.call(CLIENT_HARVEST_CLI, client)).toBe(true);
    }
    // And no row for a client this package does not support, which would be a
    // backend nobody can ever reach.
    for (const row of Object.keys(CLIENT_HARVEST_CLI)) {
      expect(clients).toContain(row);
    }
  });

  test('the clients probed on a real machine are the ones marked verified', () => {
    // Guards the honesty of the table: `verified` means a probe was executed
    // against the installed CLI, and rows taken from vendor docs must not
    // claim it. A future row is welcome to flip this once someone runs it.
    const verified = Object.entries(CLIENT_HARVEST_CLI)
      .filter(([, row]) => row && row.verified)
      .map(([client]) => client)
      .sort();
    expect(verified).toEqual(['claude-code', 'codex', 'copilot']);
  });

  test('editor-hosted clients declare null rather than borrowing a neighbour', () => {
    // Reaching for whatever CLI is on PATH would send the digest to a vendor
    // the user never chose.
    for (const client of ['cursor', 'cline', 'windsurf', 'kilo', 'roo', 'zed']) {
      expect(CLIENT_HARVEST_CLI[client]).toBeNull();
    }
  });

  test('copilot gets a prompt file, because it cannot read stdin', () => {
    // Probed both ways against the installed CLI: on stdin it answers that
    // it cannot read stdin and exits 0 -- silence that looks like a session
    // with nothing to learn -- and asked to read a payload file it returns
    // the array.
    expect(CLIENT_HARVEST_CLI.copilot.delivery).toBe('prompt-file');
  });

  test('claude-code and codex take it on stdin', () => {
    expect(CLIENT_HARVEST_CLI['claude-code'].delivery).toBe('stdin');
    expect(CLIENT_HARVEST_CLI.codex.delivery).toBe('stdin');
    // `codex exec -` is the documented stdin form; without the dash it waits
    // for a prompt argument.
    expect(CLIENT_HARVEST_CLI.codex.args).toEqual(['exec', '-']);
  });

  test('an override reaches a client with no row at all', () => {
    const row = harvestCliFor('zed', { TOKEN_OPTIMIZER_HARVEST_CLI_COMMAND: 'my-llm --pipe' });
    expect(row).toMatchObject({ command: 'my-llm', args: ['--pipe'], delivery: 'stdin' });
  });

  test('a trailing {} in the override asks for a prompt file', () => {
    const row = harvestCliFor('zed', { TOKEN_OPTIMIZER_HARVEST_CLI_COMMAND: 'my-llm run {}' });
    expect(row).toMatchObject({ command: 'my-llm', args: ['run'], delivery: 'prompt-file' });
  });

  test('the client key is normalised, like every other lookup here', () => {
    // capabilityFor lower-cases and this did not, so TOKEN_OPTIMIZER_CLIENT
    // =Codex resolved a capability profile and NO harvest CLI -- harvestMode
    // then fell through to off:no-key and an opted-in harvest silently did
    // nothing on a client that plainly has one.
    expect(harvestCliFor('Codex')).toEqual(harvestCliFor('codex'));
    expect(harvestCliFor('CLAUDE-CODE')).toEqual(harvestCliFor('claude-code'));
  });

  test('a prototype key is not a client', () => {
    // A bare index reached Object.prototype: harvestCliFor('constructor')
    // returned a function whose `command` is undefined, and runHostCli would
    // have handed that straight to spawn.
    for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(harvestCliFor(key)).toBeNull();
    }
  });

  test('an override can name arg-stdin, the shape gemini and qwen use', () => {
    const row = harvestCliFor('zed', { TOKEN_OPTIMIZER_HARVEST_CLI_COMMAND: 'my-llm -p {-}' });
    expect(row).toMatchObject({ command: 'my-llm', args: ['-p'], delivery: 'arg-stdin' });
  });

  test('the arg-stdin flag value carries nothing a shell can break', () => {
    // It ends up on a Windows command line, where cmd.exe cannot carry a
    // newline inside an argument and every double quote has to be doubled.
    expect(ARG_STDIN_INSTRUCTION).not.toContain('\\n');
    expect(ARG_STDIN_INSTRUCTION).not.toContain('"');
    expect(ARG_STDIN_INSTRUCTION).not.toContain("'");
  });

  test('a quoted path in the override survives the split', () => {
    // An interpreter under `C:\\Program Files` is the obvious thing to
    // configure, and an unquoted split reported `C:\\Program exited 1`.
    const row = harvestCliFor('zed', {
      TOKEN_OPTIMIZER_HARVEST_CLI_COMMAND: '"C:\\Program Files\\nodejs\\node.exe" run.mjs',
    });
    expect(row.command).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(row.args).toEqual(['run.mjs']);
  });
});

describe('the backend is opt-in and is recognised by the enablement gate', () => {
  test('off by default even with a client that has a CLI', () => {
    process.env.TOKEN_OPTIMIZER_CLIENT = 'claude-code';
    expect(hostCliHarvest()).toBeNull();
    expect(harvestMode()).toBe('off:no-key');
  });

  test('opted in, the mode is host-cli with no key and no endpoint', () => {
    // THE BUG THIS EXISTS FOR. `harvestMode` returned off:no-key before the CLI
    // path was ever consulted, so `extract` refused in 0s having spawned
    // nothing -- a backend that needs no key, defeated by the key check.
    process.env.TOKEN_OPTIMIZER_CLIENT = 'claude-code';
    process.env.TOKEN_OPTIMIZER_HARVEST_CLI = '1';
    expect(harvestMode()).toBe('host-cli');
    expect(harvestEnabled()).toBe(true);
  });

  test('opted in on a client with no CLI still falls back to the key check', () => {
    process.env.TOKEN_OPTIMIZER_CLIENT = 'zed';
    process.env.TOKEN_OPTIMIZER_HARVEST_CLI = '1';
    expect(hostCliHarvest()).toBeNull();
    expect(harvestMode()).toBe('off:no-key');
  });

  test('the kill switch still outranks it', () => {
    process.env.TOKEN_OPTIMIZER_CLIENT = 'claude-code';
    process.env.TOKEN_OPTIMIZER_HARVEST_CLI = '1';
    process.env.TOKEN_OPTIMIZER_MODE = 'off';
    expect(harvestMode()).toBe('off:mode');
    expect(harvestEnabled()).toBe(false);
  });

  test('the opt-out still outranks it', () => {
    process.env.TOKEN_OPTIMIZER_CLIENT = 'claude-code';
    process.env.TOKEN_OPTIMIZER_HARVEST_CLI = '1';
    process.env.TOKEN_OPTIMIZER_HARVEST = '0';
    expect(harvestMode()).toBe('off:opted-out');
  });

  test('a configured local endpoint still wins, being free and private', () => {
    process.env.TOKEN_OPTIMIZER_CLIENT = 'claude-code';
    process.env.TOKEN_OPTIMIZER_HARVEST_CLI = '1';
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = 'http://127.0.0.1:11434/v1/chat/completions';
    expect(harvestMode()).toBe('local');
  });
});

describe('the payload reaches the CLI and the reply comes back', () => {
  test('stdin delivery harvests with no key and no local model', async () => {
    asStdinCli();
    const found = await extract('## Files touched\nhooks-core/harvest.mjs\n', {
      knownFiles: new Set(['hooks-core/harvest.mjs']),
    });
    expect(harvestFailure()).toBeNull();
    expect(found).toHaveLength(1);
    expect(found[0].claim).toBe('the stub CLI answered');
    const got = handed();
    expect(got.stdin).toContain('## Files touched');
    // `node stub.mjs` -- the script path is argv[1], so the child was given
    // no arguments of its own. Everything travelled on stdin.
    expect(got.argv).toEqual([]);
  });

  test('prompt-file delivery hands over a readable path, not the payload', async () => {
    asFileCli();
    const found = await extract('## Files touched\nhooks-core/harvest.mjs\n', {
      knownFiles: new Set(['hooks-core/harvest.mjs']),
    });
    expect(harvestFailure()).toBeNull();
    expect(found).toHaveLength(1);
    const got = handed();
    expect(got.stdin).toBe('');
    expect(got.argv).toHaveLength(1);
    // ONE argument, and it is a path plus a sentence -- no newlines, no
    // quotes, nothing a shell or an argument binder can tear apart. The
    // payload itself as an argument was tried and lost: cmd.exe cannot
    // carry a newline in one, and PowerShell 5.1's native binder does not
    // escape the double quotes in the JSON prompt, which split a single
    // argument into 32.
    expect(got.argv[0]).not.toContain('\n');
    expect(got.argv[0]).toMatch(/token-optimizer-harvest-.*\.txt/);
    const promptPath = got.argv[0].match(/(\S+token-optimizer-harvest-\S+\.txt)/)[1];
    expect(got.promptFile).toContain('## Files touched');
    // Removed once the child is done, whatever the outcome: this is a
    // digest of the user's session sitting in a world-readable temp
    // directory.
    expect(existsSync(promptPath)).toBe(false);
  });

  test('a payload far past any argument limit still travels whole', async () => {
    // The route the payload-as-argument design had to truncate at 15000
    // characters on Windows. A path has no such ceiling.
    asFileCli();
    const huge = `## Files touched\nhooks-core/harvest.mjs\n${'x'.repeat(120_000)}`;
    const found = await extract(huge, { knownFiles: new Set(['hooks-core/harvest.mjs']) });
    expect(found).toHaveLength(1);
    const got = handed();
    expect(got.promptFile.length).toBeGreaterThan(120_000);
    expect(got.promptFile).not.toContain('truncated');
  });
  test('the child is spawned with the kill switch, so it cannot re-enter', async () => {
    // A child session fires its own Stop hook. Unguarded that is unbounded
    // recursion, each level spending real quota. TOKEN_OPTIMIZER_HARVEST=0 was
    // tried first and was NOT enough: the child still ran its hooks and wrote
    // derive events. Only the mode kill switch makes it inert.
    asStdinCli();
    await extract('## Files touched\nhooks-core/harvest.mjs\n', {
      knownFiles: new Set(['hooks-core/harvest.mjs']),
    });
    expect(handed().mode).toBe('off');
  });

  test('a banner containing brackets does not defeat the reply parser', async () => {
    // `codex exec` prints `sandbox: workspace-write [workdir, /tmp, $TMPDIR]`
    // before the model says anything. First-bracket-to-last-bracket parses
    // that and fails, producing an empty harvest indistinguishable from a
    // session with nothing to learn.
    asStdinCli();
    process.env.STUB_BANNER = '1';
    const found = await extract('## Files touched\nhooks-core/harvest.mjs\n', {
      knownFiles: new Set(['hooks-core/harvest.mjs']),
    });
    expect(harvestFailure()).toBeNull();
    expect(found).toHaveLength(1);
  });

  test('a reply with no array is reported as a reason, not as an empty session', async () => {
    asStdinCli();
    process.env.STUB_REPLY = 'I could not find anything worth recording.';
    const found = await extract('## Files touched\nhooks-core/harvest.mjs\n', {
      knownFiles: new Set(['hooks-core/harvest.mjs']),
    });
    expect(found).toEqual([]);
    expect(harvestFailure()).toMatch(/no JSON array/);
  });

  test('a non-zero exit with nothing to parse names the exit code', async () => {
    asStdinCli();
    process.env.STUB_SILENT = '1';
    process.env.STUB_EXIT = '3';
    const found = await extract('## Files touched\nhooks-core/harvest.mjs\n', {
      knownFiles: new Set(['hooks-core/harvest.mjs']),
    });
    expect(found).toEqual([]);
    expect(harvestFailure()).toMatch(/exited 3/);
  });

  test('a non-zero exit that still printed findings keeps the findings', async () => {
    // Several of these CLIs print the reply and then exit non-zero over an
    // unrelated cleanup complaint. Throwing away a parsed array because of
    // that would discard a harvest that actually happened.
    asStdinCli();
    process.env.STUB_EXIT = '1';
    const found = await extract('## Files touched\nhooks-core/harvest.mjs\n', {
      knownFiles: new Set(['hooks-core/harvest.mjs']),
    });
    expect(found).toHaveLength(1);
    expect(harvestFailure()).toBeNull();
  });

  test('an arg-stdin flag value is one line, and the payload rides stdin', async () => {
    // THE SAME WINDOWS CONSTRAINT prompt-file exists for. Pushing `system`
    // here put the multi-line PROMPT -- extended by withAnchorChoices with a
    // newline-separated file list, and full of the JSON prompt's double
    // quotes -- onto a cmd.exe command line, which cannot carry a newline in
    // an argument at all.
    asArgStdinCli();
    const found = await extract('## Files touched\\nhooks-core/harvest.mjs\\n', {
      knownFiles: new Set(['hooks-core/harvest.mjs']),
    });
    expect(harvestFailure()).toBeNull();
    expect(found).toHaveLength(1);
    const got = handed();
    expect(got.argv).toEqual([ARG_STDIN_INSTRUCTION]);
    // Nothing is lost by shortening the argument: the whole payload, prompt
    // included, is on stdin, which these CLIs document as their input.
    expect(got.stdin).toContain('## Files touched');
    expect(got.stdin).toContain('JSON array');
  });

  test('the prompt file is named unguessably, not merely uniquely', async () => {
    // mode 0o600 governs a file this call creates and says nothing about one
    // already at the path, and pid plus clock is guessable enough for another
    // local user to pre-create it as a symlink in the shared temp directory.
    // `flag: 'wx'` closes the race; a random name removes the guess.
    asFileCli();
    await extract('## Files touched\\nhooks-core/harvest.mjs\\n', {
      knownFiles: new Set(['hooks-core/harvest.mjs']),
    });
    const named = handed().argv[0].match(/(\S+token-optimizer-harvest-\S+\.txt)/)[1];
    expect(named).not.toContain(String(process.pid));
    expect(named).toMatch(
      /token-optimizer-harvest-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.txt$/
    );
  });

  test('a child that never reads stdin is reported, not thrown', async () => {
    // EPIPE arrives as an event on child.stdin, which the try/catch cannot
    // see. With no listener it is an uncaught exception that takes the hook
    // process down instead of resolving runHostCli -- and copilot, which
    // exits 0 without reading stdin, is exactly this child. The proof that
    // the listener works is that this test completes at all: an uncaught
    // exception here fails the run regardless of the assertions.
    asStdinCli();
    process.env.STUB_IGNORE_STDIN = '1';
    process.env.STUB_SILENT = '1';
    const found = await extract('x'.repeat(600_000), {
      knownFiles: new Set(['hooks-core/harvest.mjs']),
    });
    expect(found).toEqual([]);
    expect(harvestFailure()).toBeTruthy();
  });

  test('a command that does not exist fails with a reason', async () => {
    process.env.TOKEN_OPTIMIZER_HARVEST_CLI = '1';
    process.env.TOKEN_OPTIMIZER_HARVEST_CLI_COMMAND =
      'token-optimizer-no-such-cli-exists-anywhere';
    const found = await extract('## Files touched\nhooks-core/harvest.mjs\n', {
      knownFiles: new Set(['hooks-core/harvest.mjs']),
    });
    expect(found).toEqual([]);
    expect(harvestFailure()).toBeTruthy();
  });

});
