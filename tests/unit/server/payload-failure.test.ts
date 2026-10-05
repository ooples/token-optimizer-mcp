import { describe, it, expect } from '@jest/globals';
import { flagPayloadFailure } from '../../../src/server/payload-failure.js';

/**
 * A failure in the payload has to be a failure in the protocol.
 *
 * Fifty-three tools in this package can answer `{"success": false}`, and every
 * one of those answers used to be returned as a successful MCP result. The
 * client could not tell a tool that failed from one that did not without
 * parsing the text and knowing this package's own field names, and
 * `observeMcpToolCall` -- which reads `isError` and nothing else -- counted
 * every one of them as a success.
 */
describe('flagPayloadFailure', () => {
  const textResult = (payload: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  });

  it('flags a payload that says it failed', () => {
    expect(
      flagPayloadFailure(textResult({ success: false, error: 'no' }))
    ).toEqual({
      content: [{ type: 'text', text: '{"success":false,"error":"no"}' }],
      isError: true,
    });
  });

  it('leaves a payload that says it succeeded alone', () => {
    const result = textResult({ success: true, data: { n: 1 } });
    expect(flagPayloadFailure(result)).toBe(result);
  });

  it('leaves a payload that claims neither outcome alone', () => {
    /*
     * Most tools return their data with no `success` key at all. Absence is
     * not failure, and inferring one would turn every such tool into an error.
     */
    const result = textResult({ files: ['a.ts'] });
    expect(flagPayloadFailure(result)).toBe(result);
  });

  it('does not second-guess a tool that already decided', () => {
    /*
     * `isError: false` beside `success: false` is a tool saying the call
     * itself worked. Overriding it would make this policy unopposable.
     */
    const result = { ...textResult({ success: false }), isError: false };
    expect(flagPayloadFailure(result)).toBe(result);
  });

  it('leaves prose alone', () => {
    const result = { content: [{ type: 'text', text: 'not json at all' }] };
    expect(flagPayloadFailure(result)).toBe(result);
  });

  it('flags when any one entry says it failed', () => {
    const flagged = flagPayloadFailure({
      content: [
        { type: 'text', text: JSON.stringify({ note: 'first' }) },
        { type: 'text', text: JSON.stringify({ success: false }) },
      ],
    });
    expect((flagged as { isError?: boolean }).isError).toBe(true);
  });

  it('passes a result with no content through unchanged', () => {
    const empty = {};
    expect(flagPayloadFailure(empty)).toBe(empty);
    expect(flagPayloadFailure(null)).toBeNull();
  });

  it('does not treat a non-false success value as a failure', () => {
    /*
     * `success: 0` and `success: "false"` are not `false`. Coercing them would
     * fail a call on a payload that never said it failed.
     */
    for (const value of [0, 'false', null, undefined]) {
      const result = textResult({ success: value });
      expect(flagPayloadFailure(result)).toBe(result);
    }
  });
});
