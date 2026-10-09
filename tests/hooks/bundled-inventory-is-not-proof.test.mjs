/**
 * A BUNDLED INVENTORY IS NOT PROOF THAT A TOOL CAN BE CALLED.
 *
 * Issue #469. The client entry points write an install-time list of optimizer
 * tool names into the environment, and that list used to land in
 * TOKEN_OPTIMIZER_MCP_CAPABILITIES -- the variable capabilities.mjs reads as a
 * HOST-supplied inventory. A list the generator made up therefore read back as
 * "the host named these tools in this session", so every plugin install claimed
 * positive runtime inventory evidence whether or not a single tool had been
 * registered. The reported session was told it had evidence for 19 tools, could
 * call none of them, and was told to call them again after every failure.
 *
 * WHY THESE TESTS HAVE TWO ARMS EACH. The whole hook suite already passed with
 * the defect in place, because every existing test states its inventory through
 * TOKEN_OPTIMIZER_MCP_CAPABILITIES -- the proven grade -- so nothing exercised
 * the bundled one. A test that only checks the healthy arm proves the gate
 * exists, not that it is reached; each case below therefore pins the behaviour
 * at BOTH grades.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  isToolAbsentMessage,
  markOptimizerToolAbsent,
  markOptimizerToolOk,
  observeOptimizerToolCall,
  optimizerToolEvidence,
  optimizerToolsForHook,
  unreachableOptimizerTools,
} from '../../hooks-core/capabilities.mjs';
import { absentToolsFromTranscript } from '../../hooks-core/transcript.mjs';

const ROOT = process.cwd();
const BUNDLED = 'smart_read,smart_grep,wiki_write';

let workspace;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'bundled-grade-'));
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

/** A hook environment with BOTH capability variables cleared. */
function baseEnv() {
  const env = { ...process.env };
  delete env.TOKEN_OPTIMIZER_MCP_CAPABILITIES;
  delete env.TOKEN_OPTIMIZER_MCP_CAPABILITIES_BUNDLED;
  return {
    ...env,
    TOKEN_OPTIMIZER_NUDGE_AFTER: '1',
    TOKEN_OPTIMIZER_STATE_DIR: join(workspace, '.state'),
    TOKEN_OPTIMIZER_WIKI_DIR: join(workspace, '.wiki'),
    TOKEN_OPTIMIZER_SHARED_DIR: join(workspace, '.shared'),
  };
}

function run(script, payload, env) {
  const result = spawnSync(process.execPath, [script], {
    cwd: workspace,
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

describe('the two grades of tool evidence stay apart', () => {
  test('a bundled list contributes names but never proof', () => {
    const bundled = optimizerToolEvidence(
      {},
      { TOKEN_OPTIMIZER_MCP_CAPABILITIES_BUNDLED: BUNDLED }
    );
    expect(bundled.proven).toBe(false);
    expect([...bundled.names].sort()).toEqual([
      'smart_grep',
      'smart_read',
      'wiki_write',
    ]);
  });

  test('a host-stated list is still proof', () => {
    // THE POSITIVE CONTROL. An operator or a host that really does know the
    // inventory keeps the grade it always had, and it outranks the bundled
    // default -- otherwise the fix above would just be a downgrade of
    // everything.
    const host = optimizerToolEvidence(
      {},
      {
        TOKEN_OPTIMIZER_MCP_CAPABILITIES: 'wiki_write',
        TOKEN_OPTIMIZER_MCP_CAPABILITIES_BUNDLED: BUNDLED,
      }
    );
    expect(host.proven).toBe(true);
    expect([...host.names]).toEqual(['wiki_write']);
  });

  test('a proven EMPTY inventory still beats the bundled default', () => {
    // The documented escape hatch: a user, a host or a benchmark arm running
    // the hooks with no server states the empty string and must get native
    // tools back, not the nine names this package ships with.
    const off = optimizerToolEvidence(
      {},
      {
        TOKEN_OPTIMIZER_MCP_CAPABILITIES: '',
        TOKEN_OPTIMIZER_MCP_CAPABILITIES_BUNDLED: BUNDLED,
      }
    );
    expect(off.proven).toBe(true);
    expect(off.names.size).toBe(0);
  });

  test('bundled names survive into later hook events', () => {
    // THE REGRESSION THIS FIX COULD EASILY HAVE SHIPPED. `optimizerToolsForHook`
    // used to return an empty set whenever nothing was proven, which was
    // unreachable while the bundled default was written into the proven
    // variable. Grading it honestly without this would have switched routing
    // advice off for every plugin install -- a regression dressed as a fix.
    const carried = optimizerToolsForHook(
      {},
      {},
      { TOKEN_OPTIMIZER_MCP_CAPABILITIES_BUNDLED: BUNDLED }
    );
    expect(carried.proven).toBe(false);
    expect([...carried.names].sort()).toEqual([
      'smart_grep',
      'smart_read',
      'wiki_write',
    ]);
  });
});

describe('no generated entry point can launder the grade again', () => {
  /** Every .mjs under a directory tree, so no entry file can hide from the scan. */
  function sources(dir, found = []) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.name === 'node_modules') continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) sources(path, found);
      else if (item.name.endsWith('.mjs')) found.push(path);
    }
    return found;
  }

  test('every generated entry writes the bundled variable and not the proven one', () => {
    const offenders = [];
    let wrote = 0;
    for (const path of [
      ...sources(join(ROOT, 'plugin')),
      ...sources(join(ROOT, 'integrations')),
    ]) {
      const source = readFileSync(path, 'utf8');
      // The assignment, not the prose: the comment block in these files
      // discusses TOKEN_OPTIMIZER_MCP_CAPABILITIES on purpose, at length.
      if (
        /^process\.env\.TOKEN_OPTIMIZER_MCP_CAPABILITIES\s*\?\?=/m.test(source)
      )
        offenders.push(path.slice(ROOT.length + 1));
      if (
        /^process\.env\.TOKEN_OPTIMIZER_MCP_CAPABILITIES_BUNDLED\s*\?\?=/m.test(
          source
        )
      )
        wrote += 1;
    }
    expect(offenders).toEqual([]);
    // THE POSITIVE CONTROL FOR THE SCAN ITSELF. An assertion that only counted
    // offenders would pass just as happily if the walk found no files, or if
    // every entry had stopped declaring an inventory at all.
    expect(wrote).toBeGreaterThanOrEqual(30);
  });
});

describe('a call that proves a tool absent takes it out of the inventory', () => {
  test('a "no such tool" reply drops the name at every grade', () => {
    const state = {};
    observeOptimizerToolCall(state, 'mcp__token-optimizer__wiki_write', {
      ok: false,
      text: 'Error: No such tool available: mcp__token-optimizer__wiki_write',
      at: 1000,
    });
    expect(state.optimizerToolAbsentAt).toEqual({ wiki_write: 1000 });

    const bundled = optimizerToolsForHook({}, state, {
      TOKEN_OPTIMIZER_MCP_CAPABILITIES_BUNDLED: BUNDLED,
    });
    expect([...bundled.names].sort()).toEqual(['smart_grep', 'smart_read']);

    // Even a host's own inventory loses it: the host said it registered the
    // tool and the call says otherwise, and the call is the later and more
    // direct observation.
    const host = optimizerToolsForHook({}, state, {
      TOKEN_OPTIMIZER_MCP_CAPABILITIES: BUNDLED,
    });
    expect(host.proven).toBe(true);
    expect([...host.names].sort()).toEqual(['smart_grep', 'smart_read']);
  });

  test('an ordinary failure does NOT drop the name', () => {
    // THE NEGATIVE CONTROL, and the one that decides whether this is safe to
    // ship. wiki_write refuses an unanchored claim and smart_read fails on a
    // missing path; treating either as "the tool does not exist" would disable
    // the whole subsystem on the first ordinary error.
    const state = {};
    observeOptimizerToolCall(state, 'mcp__token-optimizer__wiki_write', {
      ok: false,
      text: 'unanchored writes are refused: every claim needs at least one anchor',
    });
    expect(state.optimizerToolAbsentAt).toBeUndefined();
    expect(isToolAbsentMessage('every claim needs at least one anchor')).toBe(
      false
    );
    expect(isToolAbsentMessage('No such tool available: x')).toBe(true);
  });

  test('a later successful call revokes an absence, and an earlier one does not', () => {
    // THE RELOAD CASE, which is how #469 was actually investigated: the
    // reporter ran `/plugin` and `/reload-plugins` mid-session. A suppression
    // that cannot be revoked costs that user the tool for the rest of the
    // session. The second half is the control that makes the comparison real
    // rather than a one-way switch -- a success that PREDATES the refusal must
    // leave the suppression standing.
    const repaired = {};
    markOptimizerToolAbsent(repaired, 'mcp__token-optimizer__smart_read', 1000);
    expect([...unreachableOptimizerTools(repaired)]).toEqual(['smart_read']);
    observeOptimizerToolCall(repaired, 'mcp__token-optimizer__smart_read', {
      ok: true,
      at: 2000,
    });
    expect([...unreachableOptimizerTools(repaired)]).toEqual([]);

    const stillBroken = {};
    markOptimizerToolOk(stillBroken, 'mcp__token-optimizer__smart_read', 1000);
    markOptimizerToolAbsent(
      stillBroken,
      'mcp__token-optimizer__smart_read',
      2000
    );
    expect([...unreachableOptimizerTools(stillBroken)]).toEqual(['smart_read']);
  });

  test('the transcript cannot re-suppress a tool a later call reached', () => {
    // WHY THE INSTANT IS STORED RATHER THAN A FLAG. The transcript scan runs on
    // every hook event and re-reads the SAME old refusal each time, so a plain
    // "unreachable" list would re-add a name the moment after a successful
    // call cleared it, and the revocation above would be dead in practice.
    const state = {};
    markOptimizerToolOk(state, 'mcp__token-optimizer__wiki_write', 5000);
    for (let event = 0; event < 3; event += 1) {
      markOptimizerToolAbsent(state, 'mcp__token-optimizer__wiki_write', 1000);
    }
    expect([...unreachableOptimizerTools(state)]).toEqual([]);
  });
});

describe('the transcript is the only place a failed call exists on Claude Code', () => {
  /** One assistant tool_use plus its user tool_result, as Claude Code writes them. */
  function transcript(lines) {
    const path = join(workspace, 'transcript.jsonl');
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n'));
    return path;
  }

  const attempt = (id, name) => ({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input: {} }],
    },
  });
  const reply = (id, content, isError) => ({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content, is_error: isError },
      ],
    },
  });

  test('reads back the tool a host refused as unknown', () => {
    const path = transcript([
      attempt('t1', 'mcp__token-optimizer__wiki_write'),
      reply(
        't1',
        'No such tool available: mcp__token-optimizer__wiki_write',
        true
      ),
    ]);
    expect(absentToolsFromTranscript(path)).toEqual([
      { name: 'mcp__token-optimizer__wiki_write', at: 0 },
    ]);
  });

  test('carries the instant the refusal was recorded', () => {
    const at = '2026-10-08T12:00:00.000Z';
    const path = transcript([
      attempt('t1', 'mcp__token-optimizer__wiki_write'),
      { ...reply('t1', 'No such tool available', true), timestamp: at },
    ]);
    expect(absentToolsFromTranscript(path)).toEqual([
      { name: 'mcp__token-optimizer__wiki_write', at: Date.parse(at) },
    ]);
  });

  test('reads an MCP content block the same way', () => {
    const path = transcript([
      attempt('t1', 'mcp__token-optimizer__smart_grep'),
      reply(
        't1',
        [{ type: 'text', text: 'MCP server "token-optimizer" not connected' }],
        true
      ),
    ]);
    expect(absentToolsFromTranscript(path)).toEqual([
      { name: 'mcp__token-optimizer__smart_grep', at: 0 },
    ]);
  });

  test('ignores a failure that is about the request, not the registry', () => {
    const path = transcript([
      attempt('t1', 'mcp__token-optimizer__wiki_write'),
      reply('t1', 'unanchored writes are refused', true),
      attempt('t2', 'mcp__token-optimizer__smart_read'),
      reply('t2', 'done', false),
    ]);
    expect(absentToolsFromTranscript(path)).toEqual([]);
  });

  test('returns names only -- no transcript text of any kind', () => {
    // The standing constraint on this reader. It runs over raw transcript text
    // that has never crossed a redaction boundary, so what it returns has to be
    // a tool name and nothing else.
    const secret = 'PRIVATE-PROMPT-TEXT-0xdeadbeef';
    const path = transcript([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: secret }] },
      },
      attempt('t1', 'mcp__token-optimizer__wiki_write'),
      reply('t1', `No such tool available (context: ${secret})`, true),
    ]);
    const out = absentToolsFromTranscript(path);
    expect(out).toEqual([{ name: 'mcp__token-optimizer__wiki_write', at: 0 }]);
    expect(JSON.stringify(out)).not.toContain(secret);
  });
});

describe('the Stop hook stops asking for a tool the session cannot call', () => {
  const STOP = join(ROOT, 'plugin', 'hooks', 'stop.mjs');
  const POST = join(ROOT, 'plugin', 'hooks', 'post-tool.mjs');

  function editThen(sessionId, transcriptPath, env) {
    const file = join(workspace, 'edited.ts');
    writeFileSync(file, 'export const edited = 1;\n');
    run(
      POST,
      {
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: workspace,
        tool_name: 'Write',
        tool_input: { file_path: file },
        tool_response: { success: true },
      },
      env
    );
    return run(
      STOP,
      {
        hook_event_name: 'Stop',
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: workspace,
        model: 'claude-opus-5',
        stop_hook_active: false,
        last_assistant_message: 'Done.',
      },
      env
    );
  }

  test('asks for wiki_write when nothing has disproved it', () => {
    // THE POSITIVE CONTROL. Without this the test below would also pass if the
    // harvest prompt had simply been switched off, which is the outcome this
    // change most needed to avoid.
    const path = join(workspace, 'healthy.jsonl');
    writeFileSync(path, '');
    const output = editThen('stop-healthy', path, baseEnv());
    expect(JSON.stringify(output)).toContain('wiki_write');
  });

  test('does not ask once a call has come back "no such tool"', () => {
    const path = join(workspace, 'broken.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'w1',
                name: 'mcp__token-optimizer__wiki_write',
                input: {},
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'w1',
                content:
                  'No such tool available: mcp__token-optimizer__wiki_write',
                is_error: true,
              },
            ],
          },
        }),
      ].join('\n')
    );
    const env = baseEnv();
    const output = editThen('stop-broken', path, env);

    // PINNED POSITIVELY, not just by absence. A bare `not.toContain` here would
    // pass if the hook had thrown, emitted nothing, or never run at all -- so
    // the state the hook wrote is asserted too, which is the thing that proves
    // the refusal was actually read and acted on.
    const files = readdirSync(env.TOKEN_OPTIMIZER_STATE_DIR).filter((name) =>
      name.startsWith('stop-broken')
    );
    expect(files).toHaveLength(1);
    const state = JSON.parse(
      readFileSync(join(env.TOKEN_OPTIMIZER_STATE_DIR, files[0]), 'utf8')
    );
    expect(Object.keys(state.optimizerToolAbsentAt ?? {})).toEqual([
      'wiki_write',
    ]);
    expect(state.edits).toBe(1);
    expect(JSON.stringify(output ?? {})).not.toContain('wiki_write');
  });
});

describe('review findings on #470', () => {
  it('an unknown instant is the OLDEST, so a re-read refusal cannot outrank a success', () => {
    // THE BUG THIS FIX EXISTS FOR. stampTool read `Number(at) || Date.now()`,
    // so a transcript refusal carrying `at` 0 -- which is what the reader
    // returns when the entry has no parsable timestamp -- was stamped at the
    // CURRENT time on every hook event. The same old refusal therefore
    // outranked every later success and a repaired install never came back.
    // The original test passed only because it supplied an explicit instant.
    const state = {};
    markOptimizerToolAbsent(state, 'mcp__token-optimizer__wiki_write', 0);
    expect([...unreachableOptimizerTools(state)]).toEqual(['wiki_write']);

    observeOptimizerToolCall(state, 'mcp__token-optimizer__wiki_write', {
      ok: true,
      at: 5000,
    });
    expect([...unreachableOptimizerTools(state)]).toEqual([]);

    // The transcript is re-scanned on every later event and hands back the
    // SAME untimestamped refusal. It must not re-suppress the tool.
    for (let event = 0; event < 3; event += 1) {
      markOptimizerToolAbsent(state, 'mcp__token-optimizer__wiki_write', 0);
    }
    expect([...unreachableOptimizerTools(state)]).toEqual([]);
  });

  it('"is not available" alone does not mark a tool absent', () => {
    // The loosest alternative in TOOL_ABSENT was also the most expensive one to
    // get wrong: a match suppresses a working tool for the whole session.
    expect(isToolAbsentMessage('File is not available at that path')).toBe(
      false
    );
    expect(isToolAbsentMessage('the requested resource is not available')).toBe(
      false
    );

    // THE POSITIVE CONTROL: qualified by tool or server, it still matches, so
    // narrowing the phrase did not simply delete the alternative.
    expect(
      isToolAbsentMessage('tool mcp__token-optimizer__wiki_write is not available')
    ).toBe(true);
    expect(isToolAbsentMessage('server token-optimizer is not available')).toBe(
      true
    );
  });
});
