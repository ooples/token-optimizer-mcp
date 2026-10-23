/**
 * #484: a deferred optimizer tool the session could not LOAD is as absent as
 * one a call was refused for.
 *
 * Claude Code defers MCP schemas: it lists `mcp__token-optimizer__wiki_write`
 * as registered and the model has to find it with a tool search before it can
 * call it. When that search comes back without the tool, no call is made, so
 * the #470 refusal reader -- which reads replies to calls -- has nothing to
 * find, and the Stop hook kept blocking the turn on a `wiki_write` the session
 * had already failed to load. The fixtures below are shaped exactly as the
 * reported session's transcript recorded its searches: a `server_tool_use`
 * block for `tool_search_tool_regex` and a `tool_search_tool_result` block whose
 * `tool_references` came back empty.
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
import { toolSearchOutcomesFromTranscript } from '../../hooks-core/transcript.mjs';

// These tests are about WHETHER the harvest prompt is generated; how it is
// delivered (held for the next turn by default, 2026-10-21) is covered by
// harvest-gate.test.mjs. Pin the continuation so the prompt is observable here.
process.env.TOKEN_OPTIMIZER_HARVEST_TURN = '1';

const ROOT = process.cwd();
const QUALIFIED = 'mcp__token-optimizer__wiki_write';

let workspace;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'deferred-search-'));
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function transcript(lines, name = 'transcript.jsonl') {
  const path = join(workspace, name);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n'));
  return path;
}

/** The host announcing its deferred tools, as Claude Code records it. */
const announced = (names) => ({
  type: 'attachment',
  attachment: { type: 'deferred_tools_delta', addedNames: names },
});

/** A server-side regex search and its result, in one assistant entry. */
const regexSearch = (id, pattern, found, { limit, timestamp } = {}) => ({
  type: 'assistant',
  timestamp,
  message: {
    role: 'assistant',
    content: [
      {
        type: 'server_tool_use',
        id,
        name: 'tool_search_tool_regex',
        input: limit === undefined ? { pattern } : { pattern, limit },
      },
      {
        type: 'tool_search_tool_result',
        tool_use_id: id,
        content: {
          type: 'tool_search_tool_search_result',
          tool_references: found.map((tool_name) => ({
            type: 'tool_reference',
            tool_name,
          })),
        },
      },
    ],
  },
});

describe('a tool search is evidence about the tools it looked for', () => {
  test('a search that covers wiki_write and returns nothing marks it missed', () => {
    const path = transcript([
      announced([QUALIFIED]),
      regexSearch('s1', '__wiki_write$', [], {
        limit: 2,
        timestamp: '2026-10-12T13:30:23.000Z',
      }),
    ]);
    expect(toolSearchOutcomesFromTranscript(path)).toEqual({
      missed: [{ name: 'wiki_write', at: Date.parse('2026-10-12T13:30:23.000Z') }],
      loaded: [],
    });
  });

  test('a regex is tested against the names the host announced', () => {
    // `__wiki_write$` cannot match the bare name; it matches only a qualified
    // one, so this host-specific name is the one that has to be tried.
    const path = transcript([
      announced(['mcp__plugin_token-optimizer_token-optimizer__wiki_write']),
      regexSearch('s1', 'plugin_token-optimizer_token-optimizer__wiki_write$', [], {
        limit: 1,
      }),
    ]);
    expect(toolSearchOutcomesFromTranscript(path).missed.map((m) => m.name)).toEqual([
      'wiki_write',
    ]);
  });

  test('an overlong announced name is not a pattern subject', () => {
    // A search pattern is run against each announced name, and the quantifier
    // limit is only safe for a short subject; real names are under 70 characters.
    const long = `mcp__${'s'.repeat(120)}__wiki_write`;
    const path = transcript([
      announced([long]),
      regexSearch('s1', `${'s'.repeat(120)}__wiki_write$`, [], { limit: 1 }),
    ]);
    expect(toolSearchOutcomesFromTranscript(path)).toEqual({ missed: [], loaded: [] });
  });

  test('a search that does not cover the tool says nothing about it', () => {
    const path = transcript([
      regexSearch('s1', '^(WebSearch|WebFetch)$', [], { limit: 5 }),
    ]);
    expect(toolSearchOutcomesFromTranscript(path)).toEqual({ missed: [], loaded: [] });
  });

  test('a full page proves nothing about what it left out', () => {
    // Two results at limit 2: the search may have matched wiki_write and cut it.
    const path = transcript([
      regexSearch('s1', 'wiki|Web', ['WebSearch', 'WebFetch'], { limit: 2 }),
    ]);
    expect(toolSearchOutcomesFromTranscript(path).missed).toEqual([]);

    // THE CONTROL: the same search with room to spare is a miss.
    const roomy = transcript(
      [regexSearch('s2', 'wiki|Web', ['WebSearch', 'WebFetch'], { limit: 5 })],
      'roomy.jsonl'
    );
    expect(toolSearchOutcomesFromTranscript(roomy).missed.map((m) => m.name)).toEqual([
      'wiki_write',
      'wiki_query',
    ]);
  });

  test('an empty search after a load is not a miss', () => {
    // A loaded tool leaves the deferred registry, so searching again finds nothing.
    const path = transcript([
      regexSearch('s1', 'wiki_write', [QUALIFIED], { limit: 2, timestamp: '2026-10-12T14:00:00.000Z' }),
      regexSearch('s2', 'wiki_write', [], { limit: 2, timestamp: '2026-10-12T14:05:00.000Z' }),
    ]);
    expect(toolSearchOutcomesFromTranscript(path)).toEqual({
      missed: [],
      loaded: [{ name: 'wiki_write', at: Date.parse('2026-10-12T14:00:00.000Z') }],
    });
  });

  test('a call that answered proves the tool loaded, and a later empty search does not undo it', () => {
    const path = transcript([
      {
        type: 'assistant',
        timestamp: '2026-10-12T14:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: QUALIFIED, input: {} }] },
      },
      {
        type: 'user',
        timestamp: '2026-10-12T14:00:01.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'recorded' }] },
      },
      regexSearch('s1', 'wiki_write', [], { limit: 2, timestamp: '2026-10-12T14:05:00.000Z' }),
    ]);
    expect(toolSearchOutcomesFromTranscript(path)).toEqual({
      missed: [],
      loaded: [{ name: 'wiki_write', at: Date.parse('2026-10-12T14:00:01.000Z') }],
    });
  });

  test('a backtracking pattern is refused rather than run', () => {
    // Run in a child with a deadline: a pattern like these does not throw, it
    // never returns, and a hung regex freezes jest's own timer with it.
    const path = transcript([
      regexSearch('s1', '(.*)*x', [], { limit: 5 }),
      regexSearch('s2', '(.|.)*x', [], { limit: 5 }),
      // The same shapes one parenthesis deeper, which the first guard missed.
      regexSearch('s3', '((.*))*x', [], { limit: 5 }),
      regexSearch('s4', '((.|.))*x', [], { limit: 5 }),
    ]);
    const module = join(ROOT, 'hooks-core', 'transcript.mjs').replace(/\\/g, '/');
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import('file:///${module}'); console.log(JSON.stringify(m.toolSearchOutcomesFromTranscript(${JSON.stringify(path)})));`,
      ],
      { encoding: 'utf8', timeout: 10_000 }
    );
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({ missed: [], loaded: [] });
  });

  test('a search that returns the tool reports it loaded', () => {
    const path = transcript([
      regexSearch('s1', 'wiki_write', [QUALIFIED], {
        limit: 2,
        timestamp: '2026-10-12T14:00:00.000Z',
      }),
    ]);
    expect(toolSearchOutcomesFromTranscript(path)).toEqual({
      missed: [],
      loaded: [{ name: 'wiki_write', at: Date.parse('2026-10-12T14:00:00.000Z') }],
    });
  });

  test('a client-side select: search reads its tool_reference result', () => {
    const select = (id) => ({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id, name: 'ToolSearch', input: { query: `select:${QUALIFIED}` } },
        ],
      },
    });
    const result = (id, content) => ({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content }],
      },
    });
    const missedPath = transcript([
      select('c1'),
      result('c1', 'No matching deferred tools found'),
    ]);
    expect(toolSearchOutcomesFromTranscript(missedPath).missed.map((m) => m.name)).toEqual([
      'wiki_write',
    ]);
    const loadedPath = transcript(
      [select('c2'), result('c2', [{ type: 'tool_reference', tool_name: QUALIFIED }])],
      'loaded.jsonl'
    );
    expect(toolSearchOutcomesFromTranscript(loadedPath).loaded.map((m) => m.name)).toEqual([
      'wiki_write',
    ]);
  });

  test('a search that failed is about the search, not the tool', () => {
    const path = transcript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'server_tool_use',
              id: 's1',
              name: 'tool_search_tool_regex',
              input: { pattern: 'wiki_write' },
            },
            {
              type: 'tool_search_tool_result',
              tool_use_id: 's1',
              content: { type: 'tool_search_tool_result_error', error_code: 'unavailable' },
            },
          ],
        },
      },
      regexSearch('s2', '(wiki_write', [], { limit: 2 }), // an invalid pattern
    ]);
    expect(toolSearchOutcomesFromTranscript(path)).toEqual({ missed: [], loaded: [] });
  });
});

describe('the Stop hook stops asking for a tool the session could not load', () => {
  const STOP = join(ROOT, 'plugin', 'hooks', 'stop.mjs');
  const POST = join(ROOT, 'plugin', 'hooks', 'post-tool.mjs');

  function env() {
    const base = { ...process.env };
    delete base.TOKEN_OPTIMIZER_MCP_CAPABILITIES;
    delete base.TOKEN_OPTIMIZER_MCP_CAPABILITIES_BUNDLED;
    return {
      ...base,
      TOKEN_OPTIMIZER_NUDGE_AFTER: '1',
      TOKEN_OPTIMIZER_STATE_DIR: join(workspace, '.state'),
      TOKEN_OPTIMIZER_WIKI_DIR: join(workspace, '.wiki'),
      TOKEN_OPTIMIZER_SHARED_DIR: join(workspace, '.shared'),
    };
  }

  function run(script, payload, hookEnv) {
    const result = spawnSync(process.execPath, [script], {
      cwd: workspace,
      env: hookEnv,
      input: JSON.stringify(payload),
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return result.stdout ? JSON.parse(result.stdout) : null;
  }

  function editThenStop(sessionId, transcriptPath, hookEnv) {
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
      hookEnv
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
      hookEnv
    );
  }

  function stateOf(hookEnv, sessionId) {
    const files = readdirSync(hookEnv.TOKEN_OPTIMIZER_STATE_DIR).filter((name) =>
      name.startsWith(sessionId)
    );
    expect(files).toHaveLength(1);
    return JSON.parse(
      readFileSync(join(hookEnv.TOKEN_OPTIMIZER_STATE_DIR, files[0]), 'utf8')
    );
  }

  test('asks for wiki_write when the search found it (positive control)', () => {
    const path = transcript([
      announced([QUALIFIED]),
      regexSearch('s1', '__wiki_write$', [QUALIFIED], { limit: 2 }),
    ]);
    const output = editThenStop('stop-loaded', path, env());
    expect(JSON.stringify(output)).toContain('wiki_write');
  });

  test('does not ask once every search for it came back empty', () => {
    // The reported session, reduced: the host announced the deferred tool and
    // the model's searches for it returned no references.
    const path = transcript([
      announced([QUALIFIED, 'mcp__plugin_token-optimizer_token-optimizer__wiki_write']),
      regexSearch('s1', '__wiki_write$', [], { limit: 2, timestamp: '2026-10-12T13:30:23.000Z' }),
      regexSearch('s2', 'wiki_write', [], { limit: 2, timestamp: '2026-10-12T13:30:24.000Z' }),
    ]);
    const hookEnv = env();
    const output = editThenStop('stop-unloadable', path, hookEnv);

    // Pinned by the state the hook wrote, not only by what it left out: a bare
    // `not.toContain` would also pass if the hook had never run.
    const state = stateOf(hookEnv, 'stop-unloadable');
    expect(Object.keys(state.optimizerToolAbsentAt ?? {})).toEqual(['wiki_write']);
    expect(state.edits).toBe(1);
    expect(JSON.stringify(output ?? {})).not.toContain('wiki_write');
  });

  test('an empty search after a successful call does not take the tool away', () => {
    // The call succeeded first (a PostToolUse for wiki_write); the later search
    // comes back empty because the tool is no longer deferred. The load that
    // preceded the call is outside the transcript the Stop hook reads, so only
    // the stored success can tell the empty search apart from a miss.
    const path = transcript([]);
    const hookEnv = env();
    run(
      POST,
      {
        hook_event_name: 'PostToolUse',
        session_id: 'stop-called',
        transcript_path: path,
        cwd: workspace,
        tool_name: QUALIFIED,
        tool_input: { claim: 'x' },
        tool_response: { success: true },
      },
      hookEnv
    );
    transcript([
      announced([QUALIFIED]),
      regexSearch('s1', 'wiki_write', [], { limit: 2, timestamp: '2099-01-01T00:00:00.000Z' }),
    ]);
    const output = editThenStop('stop-called', path, hookEnv);
    const state = stateOf(hookEnv, 'stop-called');
    expect(Object.keys(state.optimizerToolOkAt ?? {})).toEqual(['wiki_write']);
    expect(state.optimizerToolAbsentAt?.wiki_write).toBeUndefined();
    expect(JSON.stringify(output)).toContain('wiki_write');
  });

  test('a successful call seen only in the transcript keeps the tool, as on Claude Code', () => {
    // Claude Code's PostToolUse matcher never sends a wiki_write call to the
    // hooks, so no post-tool event is run here: the transcript is all there is.
    const path = transcript([
      announced([QUALIFIED]),
      {
        type: 'assistant',
        timestamp: '2026-10-12T14:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: QUALIFIED, input: {} }] },
      },
      {
        type: 'user',
        timestamp: '2026-10-12T14:00:01.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'recorded' }] },
      },
      regexSearch('s1', 'wiki_write', [], { limit: 2, timestamp: '2026-10-12T14:05:00.000Z' }),
    ]);
    const hookEnv = env();
    const output = editThenStop('stop-transcript-call', path, hookEnv);
    const state = stateOf(hookEnv, 'stop-transcript-call');
    expect(Object.keys(state.optimizerToolOkAt ?? {})).toEqual(['wiki_write']);
    expect(state.optimizerToolAbsentAt?.wiki_write).toBeUndefined();
    expect(JSON.stringify(output)).toContain('wiki_write');
  });

  test('a later search that loads it brings the request back', () => {
    const path = transcript([
      announced([QUALIFIED]),
      regexSearch('s1', 'wiki_write', [], { limit: 2, timestamp: '2026-10-12T13:30:00.000Z' }),
      regexSearch('s2', 'wiki_write', [QUALIFIED], {
        limit: 2,
        timestamp: '2026-10-12T13:40:00.000Z',
      }),
    ]);
    const output = editThenStop('stop-recovered', path, env());
    expect(JSON.stringify(output)).toContain('wiki_write');
  });
});
