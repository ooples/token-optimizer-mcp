import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocks, markerTokens, steadyAllowance } from './proof.mjs';
import { tokens } from './currency.mjs';
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

test('marker tokens are counted in both envelopes, not just in ours', () => {
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
  // COUNTED, NOT DIVIDED. 35 characters of prose is 15 tokens and 29 of hex is
  // 14, so these two markers cost very nearly the same despite the width
  // between them -- which is exactly what the chars/4 allowance got wrong.
  assert.equal(markerTokens(ours, bp), 15);
  assert.equal(markerTokens(theirs, bp), 14);
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
  const cached = markerTokens(request, { message: 0, block: 0 });
  const fresh = markerTokens(request, null);
  const one = tokens(text);
  assert.equal(cached, one * 0.1 + one);
  assert.equal(fresh, one * 2);
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

test('the allowance pays for marker tokens and refuses anything else', () => {
  // THE FAILING ARM THE TWELVE GREEN ROWS CANNOT SUPPLY. Measured on
  // human-authored-json, in the counted currency: our markers spend 244
  // cache-weighted tokens against the control's 218, and we are 25 tokens
  // dearer. That passes, with a token and a bit to spare. An arm 40 tokens
  // dearer on the same markers does not, which is the whole point -- the
  // allowance is for the marker, not for a regression that happens to sit
  // beside one.
  //
  // THE INPUTS USED TO BE CHARACTERS AND THE EXPECTATION WAS 23.25, which was
  // (542 - 449) / 4. Both halves changed when the currency became a
  // measurement: the figures below are token counts taken from the same run
  // the published table comes from, and the allowance is now the difference
  // itself rather than a quarter of it.
  const allowance = steadyAllowance(244, 218);
  assert.equal(allowance.toFixed(2), '26.00');
  assert.ok(243 + 25 <= 243 + allowance);
  assert.ok(!(243 + 40 <= 243 + allowance));
});
