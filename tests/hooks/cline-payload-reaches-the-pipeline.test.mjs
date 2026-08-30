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
