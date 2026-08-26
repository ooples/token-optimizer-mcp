/**
 * Tool-name normalisation, and the loop hazard that comes with widening it.
 *
 * `plugin/hooks/hooks.json`'s PostToolUse matcher has always listed
 * `mcp__.*__(?:smart_edit|smart_write)`, but `normalizeTool` resolved only the
 * seven built-ins and the alias table -- so an MCP-prefixed name mapped to
 * null and the hook exited before any accounting ran. The optimizer was blind
 * to its OWN tools on exactly the path enforcement pushes the model toward:
 * staleness, mutation counting and harvest pressure all silently skipped.
 *
 * Widening the resolver is not free, because the same function feeds the
 * routing decision. Two properties therefore have to hold together:
 *
 *   1. an MCP-prefixed name resolves, so post-tool accounting sees it;
 *   2. resolving it must NEVER make the router deny the replacement and
 *      redirect it to itself.
 *
 * (2) is not hypothetical. Qwen's PreToolUse matcher is the unanchored regex
 * `edit|write_file|run_shell_command`, and `edit` matches inside
 * `mcp__x__smart_edit` -- so on that client the router really is handed
 * smart_edit calls. Without the guard, smart_edit on a large file normalises
 * to `Edit` and earns the "call smart_edit instead" verdict.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normalizeTool,
  normalizePayload,
  decide,
  readCostBytes,
  isReplacementTool,
  touchedFiles,
} from '../../hooks-core/decide.mjs';
import { observedWrites } from '../../hooks-core/pending.mjs';

let workspace;
let big;

const AVAILABLE = new Set([
  'smart_read',
  'smart_write',
  'smart_edit',
  'smart_glob',
  'smart_grep',
]);

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'toolnorm-'));
  big = join(workspace, 'big.ts');
  writeFileSync(big, 'x'.repeat(200 * 1024));
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function payloadFor(toolName, input) {
  return normalizePayload({
    session_id: 'session-1',
    cwd: workspace,
    tool_name: toolName,
    tool_input: input,
  });
}

describe('normalizeTool', () => {
  it('resolves an MCP-prefixed tool name by its trailing segment', () => {
    expect(
      normalizeTool('mcp__plugin_token-optimizer_token-optimizer__smart_edit')
    ).toBe('Edit');
    expect(normalizeTool('mcp__whatever__smart_write')).toBe('Write');
    expect(normalizeTool('mcp__whatever__smart_read')).toBe('Read');
    expect(normalizeTool('mcp__whatever__smart_grep')).toBe('Grep');
    expect(normalizeTool('mcp__whatever__smart_glob')).toBe('Glob');
  });

  it('resolves the bare replacement names too, as Codex spells them', () => {
    // integrations/codex/hooks/hooks.json's AfterTool matcher lists
    // `smart_edit|smart_write` WITHOUT an mcp__ prefix, so the unprefixed
    // spelling has to resolve or that matcher is decorative on Codex.
    expect(normalizeTool('smart_edit')).toBe('Edit');
    expect(normalizeTool('smart_write')).toBe('Write');
  });

  it('resolves NotebookEdit, which the alias table never listed', () => {
    expect(normalizeTool('NotebookEdit')).toBe('Edit');
    expect(normalizeTool('notebook_edit')).toBe('Edit');
  });

  it('still returns null for a tool it genuinely does not know', () => {
    // The permissive direction matters: an unknown tool must stay unknown
    // rather than being coerced into a built-in, which would change a routing
    // verdict for a tool nobody has considered.
    expect(normalizeTool('mcp__vendor__deploy_to_prod')).toBeNull();
    expect(normalizeTool('mcp__vendor__edit_the_database')).toBeNull();
    expect(normalizeTool('deploy_to_prod')).toBeNull();
    expect(normalizeTool('')).toBeNull();
    expect(normalizeTool(undefined)).toBeNull();
  });

  it('strips only a well-formed mcp__server__ prefix', () => {
    // A prefix strip that just took the text after the last `__` would resolve
    // `not_mcp__edit`, which is a name this project has never seen and has no
    // business coercing into the built-in Edit.
    expect(normalizeTool('not_mcp__edit')).toBeNull();
    expect(normalizeTool('mcp__edit')).toBeNull();
  });

  it('keeps every built-in and pre-existing alias resolving as before', () => {
    expect(normalizeTool('Read')).toBe('Read');
    expect(normalizeTool('MultiEdit')).toBe('MultiEdit');
    expect(normalizeTool('run_shell_command')).toBe('Bash');
    expect(normalizeTool('apply_patch')).toBe('Edit');
    expect(normalizeTool('read_file')).toBe('Read');
  });
});

describe('the loop hazard', () => {
  it('does not redirect a large-file smart_edit to smart_edit', () => {
    // The built-in spelling of the same call IS redirected -- that is the whole
    // point of enforcement -- so this pair is what proves the guard discriminates
    // rather than just disabling the Edit branch.
    const builtin = decide(
      payloadFor('Edit', { file_path: big, old_string: 'x', new_string: 'y' }),
      { seen: {} },
      AVAILABLE
    );
    expect(builtin).not.toBeNull();
    expect(builtin.reason).toMatch(/smart_edit/);

    const replacement = decide(
      payloadFor('mcp__x__smart_edit', { file_path: big }),
      { seen: {} },
      AVAILABLE
    );
    expect(replacement).toBeNull();
  });

  it('does not redirect any of the other replacements to themselves', () => {
    const cases = [
      ['mcp__x__smart_read', { file_path: big }],
      ['mcp__x__smart_grep', { pattern: 'foo' }],
      ['mcp__x__smart_glob', { pattern: '**/*.ts' }],
      ['mcp__x__smart_write', { file_path: big, content: 'y'.repeat(200000) }],
      ['smart_edit', { file_path: big }],
      ['smart_write', { file_path: big, content: 'y'.repeat(200000) }],
    ];
    for (const [tool, input] of cases) {
      expect(decide(payloadFor(tool, input), { seen: {} }, AVAILABLE)).toBeNull();
    }
  });

  it('does not redirect a smart_read of a file already read this session', () => {
    // The re-read branch fires on `state.seen`, not on size, so it is a second
    // independent way the same call could have been told to call itself.
    const payload = payloadFor('mcp__x__smart_read', { file_path: big });
    const state = { seen: { [payload.tool_input.file_path]: true } };
    expect(decide(payload, state, AVAILABLE)).toBeNull();
  });

  it('still redirects a built-in Read the guard must not have disabled', () => {
    const payload = payloadFor('Read', { file_path: big });
    const state = { seen: {} };
    const verdict = decide(payload, state, AVAILABLE);
    expect(verdict).not.toBeNull();
    expect(verdict.reason).toMatch(/smart_read/);
  });
});

describe('the normalised name reaches post-tool accounting', () => {
  it('marks a replacement call as a replacement on the payload', () => {
    expect(payloadFor('mcp__x__smart_edit', { file_path: big }).replacement)
      .toBe(true);
    expect(payloadFor('Edit', { file_path: big }).replacement).toBe(false);
  });

  it('gives NotebookEdit a canonical mutating name', () => {
    // pending.mjs's MUTATING set matches on the canonical name, so a notebook
    // edit only reaches invalidation once this resolves.
    expect(payloadFor('NotebookEdit', { file_path: big }).tool_name).toBe(
      'Edit'
    );
  });

  it('reaches invalidation for a real NotebookEdit without being routed', () => {
    // Claude Code spells the target `notebook_path`, which normalizePayload
    // deliberately does NOT fold into the canonical `file_path` -- so the Edit
    // branch finds no path and the call is allowed, while touchedFiles and
    // pending.writtenPath (which both already read notebook_path) finally get
    // a payload to work with because the NAME now resolves.
    const payload = payloadFor('NotebookEdit', {
      notebook_path: big,
      new_source: 'z',
    });
    expect(payload.tool_name).toBe('Edit');
    expect(decide(payload, { seen: {} }, AVAILABLE)).toBeNull();
    // touchedFiles canonicalises separators, so compare on the leaf.
    expect(touchedFiles(payload).map((item) => item.path)).toEqual([
      expect.stringMatching(/big\.ts$/),
    ]);
    expect(observedWrites(payload, {}).map((e) => e.path)).toContain(big);
  });
});

describe('what the newly-resolving names must NOT be counted as', () => {
  it('does not charge a smart_read the whole file it did not send', () => {
    // recordRead prices this at bytes/4 tokens and feeds it to the holdout
    // comparison as downstream read cost. smart_read returns a diff, so
    // charging the full file would inflate the very arm the optimizer claims
    // is cheaper -- a measurement error pointing the flattering way.
    expect(readCostBytes(payloadFor('Read', { file_path: big }))).toBe(
      200 * 1024
    );
    expect(
      readCostBytes(payloadFor('mcp__x__smart_read', { file_path: big }))
    ).toBe(0);
  });

  it('recognises a replacement however the host spells it', () => {
    expect(isReplacementTool('mcp__x__smart_edit')).toBe(true);
    expect(isReplacementTool('SMART_EDIT')).toBe(true);
    expect(isReplacementTool('Edit')).toBe(false);
    expect(isReplacementTool('mcp__vendor__deploy_to_prod')).toBe(false);
    expect(isReplacementTool(null)).toBe(false);
  });
});
