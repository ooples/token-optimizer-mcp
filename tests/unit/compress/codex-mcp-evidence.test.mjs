import { test, expect } from '@jest/globals';
import { mcpRefreshEvidence } from '../../../bench/live/codex-mcp-evidence.mjs';
const path = 'C:/test/routes.json';
const read = (diff = false) => ({
  type: 'item.completed',
  item: {
    type: 'mcp_tool_call',
    server: 'token_optimizer',
    tool: 'smart_read',
    arguments: { path },
    status: 'completed',
    result: {
      content: [
        {
          text: JSON.stringify({ metadata: { fromCache: diff, isDiff: diff } }),
        },
      ],
    },
  },
});
const refresh = {
  type: 'item.completed',
  item: {
    type: 'command_execution',
    command: 'node refresh.mjs',
    exit_code: 0,
  },
};
test('requires real reads on both sides of refresh and a cached diff', () => {
  expect(mcpRefreshEvidence([read(), refresh, read(true)], path).passed).toBe(
    true
  );
  expect(mcpRefreshEvidence([read(), read(true), refresh], path).passed).toBe(
    false
  );
  expect(mcpRefreshEvidence([read(), refresh, read()], path).passed).toBe(
    false
  );
  expect(
    mcpRefreshEvidence([read(), refresh, read(true)], 'C:/other/routes.json')
      .passed
  ).toBe(false);
});
test('failed calls and failed refresh cannot prove cache use', () => {
  const failedRead = read(true);
  failedRead.item.error = 'failed';
  expect(mcpRefreshEvidence([read(), refresh, failedRead], path).passed).toBe(
    false
  );
  expect(
    mcpRefreshEvidence(
      [
        read(),
        { ...refresh, item: { ...refresh.item, exit_code: 1 } },
        read(true),
      ],
      path
    ).passed
  ).toBe(false);
});
