/**
 * What a tool call actually SAID, not merely whether it worked.
 *
 * `recordToolOutcome` has carried a `success` boolean since the pipeline
 * landed. A boolean cannot tell a compile error from a test failure from a
 * denied permission, and those are three different findings -- so the failure
 * findings that carry the most value had nothing to be built out of. This suite
 * pins the two additions that fix that, and pins them AT THE BOUNDARY:
 * redaction and the size cap live inside `recordToolOutcome`, because a claim
 * built from this text is injected into model context and exported to markdown,
 * and a second caller added later must not be able to skip them.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readEvidence,
  recordToolOutcome,
  record,
} from '../../hooks-core/metrics.mjs';
import { outputFrom, exitFrom } from '../../hooks-core/adapter.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'res-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const outcome = (extra) =>
  recordToolOutcome(dir, {
    surface: 'command',
    anchor: 'npm test',
    toolName: 'Bash',
    success: false,
    ...extra,
  });
const latest = () =>
  readEvidence(dir)
    .filter((e) => e.kind === 'tool-outcome')
    .pop();

describe('tool-outcome carries output and exit', () => {
  it('records the output and the exit code alongside success', () => {
    outcome({ output: 'FAIL x.test.ts', exit: 1 });
    expect(latest().success).toBe(false);
    expect(latest().exit).toBe(1);
    expect(latest().output).toContain('FAIL');
  });

  it('redacts secrets out of captured output', () => {
    outcome({ output: 'API_TOKEN=abcdef123456 failed', exit: 1 });
    expect(latest().output).not.toContain('abcdef123456');
  });

  it('caps output so a huge log is never stored whole', () => {
    outcome({ output: 'x'.repeat(100000), exit: 0 });
    expect(latest().output.length).toBeLessThanOrEqual(4096);
  });

  it('leaves exit null when the client reports no code, rather than guessing 0', () => {
    outcome({ output: 'denied' });
    expect(latest().exit).toBeNull();
  });

  it('leaves exit null for a non-integer code rather than coercing it', () => {
    // 'ENOENT' and 1.5 are both "no code was reported" as far as a finding is
    // concerned; coercing either would fabricate an observation.
    outcome({ output: 'x', exit: 'ENOENT' });
    expect(latest().exit).toBeNull();
  });

  it('keeps a reported exit of 0 distinguishable from an unreported one', () => {
    // The whole point of the null: 0 must mean "the client said zero".
    outcome({ output: 'ok', exit: 0, success: true });
    expect(latest().exit).toBe(0);
  });

  it('omits output entirely when nothing was captured', () => {
    // Not '' and not the string "undefined": an absent capture has to stay
    // distinguishable from an empty one, or a finding is built from nothing.
    outcome({ exit: 1 });
    expect(latest().output).toBeUndefined();
    expect(JSON.stringify(latest())).not.toContain('undefined');
  });

  it('redacts before capping, so truncation cannot expose a secret tail', () => {
    // CONSTRUCTED SO ONLY THE ORDER CAN DECIDE IT, and so only ONE redaction
    // pattern is in play (the `ghp_` prefix rule, which needs 10+ trailing
    // characters). The token starts 11 characters before the 4096 cap, so
    // capping FIRST leaves `ghp_abcdefg` -- seven trailing characters, below
    // the quantifier, no match, and a live secret fragment in cleartext.
    // Redacting first sees the whole 24-character token and removes it.
    outcome({
      output: `${'x'.repeat(4084)} ghp_abcdefghijklmnopqrst`,
      exit: 1,
    });
    expect(latest().output).not.toContain('ghp_abcdef');
  });

  it('does not disturb the injection join the pipeline already performs', () => {
    outcome({ output: 'x', exit: 1 });
    expect(latest().joinMethod).toBeDefined();
  });

  it('still joins an outcome to its injection by tool call id', () => {
    // The join is the load-bearing part of this event and predates this task;
    // adding two fields must leave it exactly as it was.
    record(dir, {
      kind: 'inject',
      episodeId: 'ep-1',
      toolCallId: 'call-7',
      surface: 'command',
      anchor: 'npm test',
      findingIds: ['f-1'],
    });
    recordToolOutcome(dir, {
      episodeId: 'ep-1',
      toolCallId: 'call-7',
      surface: 'command',
      anchor: 'npm test',
      toolName: 'Bash',
      success: false,
      output: 'FAIL',
      exit: 1,
    });
    expect(latest().joinMethod).toBe('tool-call-id');
    expect(latest().findingIds).toEqual(['f-1']);
    expect(latest().injectionId).toBeTruthy();
  });
});

describe('outputFrom reads the same response family as toolSucceeded', () => {
  it('captures a shell result from the stdout and stderr streams', () => {
    const text = outputFrom({
      tool_response: { stdout: 'ran 4 tests', stderr: 'FAIL x.test.ts' },
    });
    expect(text).toContain('FAIL x.test.ts');
    expect(text).toContain('ran 4 tests');
  });

  it('puts stderr ahead of stdout so the cap cannot cut the diagnostic away', () => {
    const text = outputFrom({
      tool_response: { stdout: 'a'.repeat(50), stderr: 'the reason' },
    });
    expect(text.indexOf('the reason')).toBeLessThan(text.indexOf('aaaa'));
  });

  it('reads the camelCase and tool_result envelopes too', () => {
    expect(outputFrom({ toolResponse: { stderr: 'boom' } })).toBe('boom');
    expect(outputFrom({ tool_result: 'plain text result' })).toBe(
      'plain text result'
    );
  });

  it("captures this project's own MCP tools, whose results are content blocks", () => {
    // normalizeTool now resolves mcp__<server>__smart_edit, so smart_edit and
    // smart_write reach the post-tool path for the first time. Their result is
    // an MCP envelope, not a shell result.
    const text = outputFrom({
      tool_response: {
        content: [{ type: 'text', text: '{"success": false, "error": "no match"}' }],
        isError: true,
      },
    });
    expect(text).toContain('no match');
  });

  it('accepts a bare content array, which some hosts hand the hook directly', () => {
    expect(outputFrom({ tool_response: [{ type: 'text', text: 'block' }] })).toBe(
      'block'
    );
  });

  it('captures an error message when that is all the client reports', () => {
    expect(outputFrom({ tool_response: { error: 'permission denied' } })).toBe(
      'permission denied'
    );
    expect(
      outputFrom({ toolResponse: { error: { message: 'denied by hook' } } })
    ).toBe('denied by hook');
  });

  it('returns null rather than stringifying a shape it does not understand', () => {
    // A wall of JSON metadata or "[object Object]" in an injected claim is a
    // WRONG observation; no capture is merely a missing one.
    expect(
      outputFrom({ tool_response: { filePath: '/a.ts', structuredPatch: [{}] } })
    ).toBeNull();
    expect(outputFrom({})).toBeNull();
    expect(outputFrom(undefined)).toBeNull();
  });

  it('treats blank output as no output', () => {
    expect(outputFrom({ tool_response: { stdout: '   ', stderr: '' } })).toBeNull();
  });
});

describe('exitFrom reports only a real exit code', () => {
  it('reads the code a client supplies, including zero', () => {
    expect(exitFrom({ tool_response: { exit_code: 2 } })).toBe(2);
    expect(exitFrom({ toolResponse: { exitCode: 0 } })).toBe(0);
    expect(exitFrom({ tool_result: { returncode: 137 } })).toBe(137);
  });

  it('accepts a code serialized as a digit string', () => {
    expect(exitFrom({ tool_response: { exit_code: '1' } })).toBe(1);
  });

  it('returns null when no client reported a code', () => {
    expect(exitFrom({ tool_response: { stdout: 'fine' } })).toBeNull();
    expect(exitFrom({})).toBeNull();
  });

  it('ignores `code`, which JSON-RPC and errno both reuse', () => {
    // -32602 is an RPC error, ENOENT is an errno; recording either as an exit
    // status would be a confident lie about a call that never had one.
    expect(exitFrom({ tool_response: { code: -32602 } })).toBeNull();
    expect(exitFrom({ tool_response: { code: 'ENOENT' } })).toBeNull();
  });

  it('ignores a long digit string, which is an id rather than a status', () => {
    expect(exitFrom({ tool_response: { exit_code: '1755123456789' } })).toBeNull();
  });
});
