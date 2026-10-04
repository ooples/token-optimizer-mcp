/**
 * Make the protocol agree with the payload.
 *
 * Fifty-three tools in this package can answer `{"success": false, "error":
 * ...}`, and every one of those answers was returned as an MCP result with no
 * `isError` flag. Two things followed from that, both wrong:
 *
 *   1. A client reading the protocol saw a successful call. `health_monitor`
 *      reporting that it could not reach what it monitors looked exactly like
 *      `health_monitor` reporting that everything is fine, and only a client
 *      that parses the text and knows this package's own field names could
 *      tell them apart.
 *   2. `observeMcpToolCall` decides `ok` from `isError`, so every one of those
 *      failures was counted as a success. The surface's measured success rate
 *      was overstated by exactly the number of failures it reported in prose
 *      -- a fabricated measurement, and the thing this repo treats as its
 *      worst defect class.
 *
 * The flag is derived from the payload the tool returned rather than set at
 * each of the hundred-odd return sites, because one policy is checkable and a
 * hundred are not. An explicit `isError` already on the response wins: a tool
 * that has decided is not second-guessed.
 */
export function flagPayloadFailure<T>(result: T): T {
  const response = result as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
  } | null;
  if (!response || typeof response !== 'object' || 'isError' in response) {
    return result;
  }
  const content = response.content;
  if (!Array.isArray(content)) {
    return result;
  }
  const failed = content.some((entry) => {
    if (entry?.type !== 'text' || typeof entry.text !== 'string') {
      return false;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(entry.text);
    } catch {
      /* A tool that answers prose has not claimed either outcome. */
      return false;
    }
    return (
      typeof payload === 'object' &&
      payload !== null &&
      (payload as { success?: unknown }).success === false
    );
  });
  /*
   * The cast says what the spread already is: the caller's own result object
   * with one boolean added. It is a cast rather than a wider return type so
   * the hundred-odd result shapes `handleToolCall` returns keep flowing
   * through this one call unchanged.
   */
  return failed ? ({ ...response, isError: true } as T) : result;
}
