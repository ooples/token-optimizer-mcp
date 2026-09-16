import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocks } from './proof.mjs';
import { fixtures } from './fixtures.mjs';

test('nested tool text and images contribute at the parent cache position', () => {
  const request = {
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content: [
              { type: 'text', text: 'visible result' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
                },
              },
            ],
          },
        ],
      },
    ],
  };
  const result = blocks(request);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, 'visible result');
  assert.ok(result[1].tokens > 0);
  assert.deepEqual(
    result.map((r) => r.at),
    [
      { message: 0, block: 0 },
      { message: 0, block: 0 },
    ]
  );
});

test('agent fixtures declare the tools they call', () => {
  for (const fixture of fixtures().filter((f) =>
    f.name.startsWith('agent-loop')
  )) {
    const names = fixture.request.tools.map((t) => t.name);
    assert.deepEqual(names, ['Read', 'Bash']);
    for (const message of fixture.request.messages) {
      for (const block of message.content) {
        if (block.type === 'tool_use') assert.ok(names.includes(block.name));
      }
    }
  }
});
