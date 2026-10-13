/**
 * Cline's payload has to arrive with a tool name the pipeline recognises.
 *
 * TWO SEPARATE MISTAKES STACKED, and either one alone made the integration a
 * silent no-op:
 *
 *   1. Cline sends the tool as `toolName`; the adapter read `body.tool`. So
 *      `tool_name` came out null, and the handler exits on a null tool name --
 *      before authoredWrite or recordAuthoredContent could run.
 *   2. Cline's write tools are `write_to_file` and `replace_in_file`, while
 *      `authoredWrite` tests membership of {Edit, MultiEdit, Write}. Reading
 *      the right field would still not have matched.
 *
 * Neither failure raises anything. The hook runs, finds no tool, allows
 * everything, and records nothing -- which looks exactly like a client with
 * nothing to optimise.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { join } from 'path';
import { pathToFileURL } from 'url';

const CORE = (name) =>
  pathToFileURL(join(process.cwd(), 'hooks-core', name)).href;

let normalizeClientPayload;
let normalizePayload;

beforeAll(async () => {
  // THE REAL COMPOSITION, as the router runs it:
  //   normalizePayload(normalizeClientPayload(client, event, raw))
  // Testing either half alone would miss the seam this bug lived in.
  ({ normalizeClientPayload } = await import(CORE('adapter.mjs')));
  ({ normalizePayload } = await import(CORE('decide.mjs')));
});

const throughPipeline = (raw, event) =>
  normalizePayload(normalizeClientPayload('cline', event, raw));

/** A Cline pre-tool payload, in the shape Cline actually sends. */
const clinePayload = (toolName, parameters = {}) => ({
  taskId: 'task-1',
  workspaceRoots: ['/repo'],
  model: { slug: 'claude' },
  preToolUse: { toolName, parameters },
});

describe('a successful optimizer call on cline is graded as one (#485 review)', () => {
  /**
   * Run the cline post-tool hook in a fresh process, as cline runs it, and
   * return the optimizer tools its state recorded as having answered.
   */
  async function gradedOk(postToolUse) {
    const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { spawnSync } = await import('child_process');
    const dir = mkdtempSync(join(tmpdir(), 'cline-grade-'));
    try {
      const payload = { taskId: 'task-grade', workspaceRoots: [dir], postToolUse };
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { run } = await import(${JSON.stringify(CORE('adapter.mjs'))}); await run('cline', 'post-tool');`,
        ],
        {
          input: JSON.stringify(payload),
          encoding: 'utf8',
          env: {
            ...process.env,
            TOKEN_OPTIMIZER_STATE_DIR: join(dir, 'state'),
            TOKEN_OPTIMIZER_WIKI_DIR: join(dir, 'wiki'),
            TOKEN_OPTIMIZER_SHARED_DIR: join(dir, 'shared'),
          },
        }
      );
      expect(result.status).toBe(0);
      let names = [];
      try {
        for (const file of readdirSync(join(dir, 'state')).filter((f) => f.endsWith('.json'))) {
          const state = JSON.parse(readFileSync(join(dir, 'state', file), 'utf8'));
          names = names.concat(Object.keys(state.optimizerToolOkAt ?? {}));
        }
      } catch {
        // No state written at all: nothing was graded.
      }
      return names;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reads the name cline nests under postToolUse', async () => {
    expect(
      await gradedOk({ toolName: 'mcp__token-optimizer__wiki_write', parameters: {}, success: true })
    ).toEqual(['wiki_write']);
  });

  it('reads the real name inside a use_mcp_tool call', async () => {
    expect(
      await gradedOk({
        toolName: 'use_mcp_tool',
        parameters: { server_name: 'token-optimizer', tool_name: 'wiki_write', arguments: '{}' },
        success: true,
      })
    ).toEqual(['wiki_write']);
  });

  it("records nothing for another server's tool of the same name (control)", async () => {
    expect(
      await gradedOk({
        toolName: 'use_mcp_tool',
        parameters: { server_name: 'some-other-wiki', tool_name: 'wiki_write' },
        success: true,
      })
    ).toEqual([]);
  });

  it('records nothing for a tool that is not an optimizer tool (control)', async () => {
    expect(
      await gradedOk({
        toolName: 'use_mcp_tool',
        parameters: { server_name: 'other', tool_name: 'fetch_page' },
        success: true,
      })
    ).toEqual([]);
  });
});

describe('a cline payload reaches the pipeline', () => {
  it('reads the tool from toolName, which is the field cline sends', () => {
    const payload = throughPipeline(
      clinePayload('read_file', { path: '/repo/src/a.ts' }),
      'pre-tool'
    );

    // Canonicalised to 'Read' by normalizePayload, which is the point: the
    // name arrives and is recognised. The exact value, not merely something
    // truthy -- a null here is the silent no-op the handler exits on.
    expect(payload.tool_name).toBe('Read');
  });

  it.each([
    ['write_to_file', 'Write'],
    ['replace_in_file', 'Edit'],
  ])('maps %s to %s, which is what authoredWrite matches', (cline, canonical) => {
    const payload = throughPipeline(
      {
        taskId: 'task-1',
        workspaceRoots: ['/repo'],
        postToolUse: {
          toolName: cline,
          parameters: { path: '/repo/src/a.ts', content: 'export const a = 1;' },
        },
      },
      'post-tool'
    );

    expect(payload.tool_name).toBe(canonical);
    // The whole point of the rename: this set is what gates recording an
    // authored write, and cline's own spellings are not in it.
    expect(new Set(['Edit', 'MultiEdit', 'Write']).has(payload.tool_name)).toBe(
      true
    );
  });

  it('still accepts a payload that carries the older tool field', () => {
    // Kept as a fallback rather than replaced: a payload carrying it costs
    // nothing to accept, and dropping support would be a regression for any
    // client or fixture still sending it.
    const raw = {
      taskId: 'task-2',
      workspaceRoots: ['/repo'],
      preToolUse: { tool: 'read_file', parameters: {} },
    };

    expect(throughPipeline(raw, 'pre-tool').tool_name).toBe('Read');
  });
});
