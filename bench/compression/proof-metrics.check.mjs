import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocks, markerChars, steadyAllowance } from './proof.mjs';
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

test('marker characters are counted in both envelopes, not just in ours', () => {
  // AN ARM IS MEASURED BY WHAT IT EMITTED. Counting only `[... ]` would read the
  // control's output as marker-free and hand us an allowance equal to our whole
  // marker budget on every workload -- the gate would then never bind.
  // `null` is the no-breakpoint case: nothing is cached, so every marker is
  // billed in full and the two figures are directly comparable widths.
  const bp = null;
  const ours = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '[... 269 bytes, next above ~x18p57]' },
        ],
      },
    ],
  };
  const theirs = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: '<<ccr:303a32363900,blob,269>>' }],
      },
    ],
  };
  assert.equal(markerChars(ours, bp), 35);
  assert.equal(markerChars(theirs, bp), 29);
});

test('a marker in the cached prefix is weighted at a tenth of a fresh one', () => {
  // The allowance is drawn from the same bill the cost is drawn from. A marker
  // the provider has already cached costs a tenth, so crediting it in full would
  // let an arm earn a full-price allowance for characters it is billed a tenth
  // for -- and the prefix is where most markers end up once a session is running.
  const text = '[... 269 bytes, next above ~x18p57]';
  const request = {
    messages: [
      { role: 'user', content: [{ type: 'text', text }] },
      { role: 'user', content: [{ type: 'text', text }] },
    ],
  };
  const cached = markerChars(request, { message: 0, block: 0 });
  const fresh = markerChars(request, null);
  assert.equal(cached, text.length * 0.1 + text.length);
  assert.equal(fresh, text.length * 2);
  assert.ok(cached < fresh);
});

test('an arm that emits no more marker text than the control earns nothing', () => {
  // THE FLOOR, AND THE CASE THAT MAKES THE GATE BIND. raw-build-log and
  // grep-output are incompressible by both arms, so neither emits a marker and
  // the allowance is zero: those workloads have to win or tie outright. Without
  // the floor a control that emitted MORE marker text than us would hand us a
  // negative allowance and demand we beat it by a margin it chose.
  assert.equal(steadyAllowance(0, 0), 0);
  assert.equal(steadyAllowance(100, 400), 0);
});

test('the allowance pays for marker characters and refuses anything else', () => {
  // THE FAILING ARM THE TWELVE GREEN ROWS CANNOT SUPPLY. Measured on
  // human-authored-json: our markers spend 542 cache-weighted characters against
  // the control's 449, and we are 17 tokens dearer. That passes. An arm 40
  // tokens dearer on the same markers does not, which is the whole point -- the
  // allowance is for the marker, not for a regression that happens to sit beside
  // one.
  const allowance = steadyAllowance(542, 449);
  assert.equal(allowance.toFixed(2), '23.25');
  assert.ok(243 + 17 <= 243 + allowance);
  assert.ok(!(243 + 40 <= 243 + allowance));
});
