import { describe, expect, it } from '@jest/globals';
import { compressBody } from '../../../src/proxy/server.js';
import { anchorStore } from '../../../src/compress/anchor.js';

describe('Responses project knowledge', () => {
  const findings = [
    {
      key: 'marker',
      claim: 'Use the project release marker ALPHA.',
      confidence: 1,
      confidenceLabel: 'verified',
      pinned: true,
      scope: 'project',
    },
  ];
  const request = {
    instructions: 'Preserve these instructions.',
    input: [{ role: 'user', content: 'Find the project release marker.' }],
  };
  const spill = () => '/unused';
  it('retains a frozen prefix after more than 1000 other openings', () => {
    const store = anchorStore();
    const first = compressBody(
      Buffer.from(JSON.stringify(request)),
      spill,
      store,
      findings
    );
    for (let i = 0; i < 1001; i++)
      compressBody(
        Buffer.from(
          JSON.stringify({
            ...request,
            input: [{ role: 'user', content: `Other task ${i}` }],
          })
        ),
        spill,
        store,
        findings
      );
    const later = compressBody(
      Buffer.from(
        JSON.stringify({
          ...request,
          input: [
            ...request.input,
            { role: 'assistant', content: 'Continuing' },
          ],
        })
      ),
      spill,
      store,
      []
    );
    expect(JSON.parse(later.body.toString()).instructions).toBe(
      JSON.parse(first.body.toString()).instructions
    );
    const overflow = compressBody(
      Buffer.from(
        JSON.stringify({
          ...request,
          input: [{ role: 'user', content: 'Overflow task' }],
        })
      ),
      spill,
      store,
      findings
    );
    expect(overflow.summary.injectedChars ?? 0).toBe(0);
  });

  it('separates new tasks sharing the same initial AGENTS message', () => {
    const store = anchorStore();
    const setup = {
      role: 'user',
      content: 'Identical AGENTS and environment setup',
    };
    const encode = (task: string) =>
      Buffer.from(
        JSON.stringify({ input: [setup, { role: 'user', content: task }] })
      );
    const first = compressBody(encode('First task'), spill, store, findings);
    const fresh = [
      { ...findings[0], claim: 'New verified project conclusion BETA.' },
    ];
    const second = compressBody(encode('Second task'), spill, store, fresh);
    expect(JSON.parse(first.body.toString()).instructions).toContain('ALPHA');
    expect(JSON.parse(second.body.toString()).instructions).toContain('BETA');
    const later = Buffer.from(
      JSON.stringify({
        input: [
          setup,
          { role: 'user', content: 'First task' },
          { role: 'assistant', content: 'done' },
          { role: 'user', content: 'Follow-up' },
        ],
      })
    );
    expect(
      JSON.parse(compressBody(later, spill, store, fresh).body.toString())
        .instructions
    ).toBe(JSON.parse(first.body.toString()).instructions);
  });

  it('accepts many CLI setup messages but never joins existing assistant history', () => {
    const input = [
      {
        type: 'additional_tools',
        role: 'developer',
        content: 'Deferred tool inventory',
      },
      ...Array.from({ length: 7 }, () => ({
        role: 'developer',
        content: 'Setup instruction',
      })),
      ...request.input,
    ];
    const first = compressBody(
      Buffer.from(JSON.stringify({ ...request, input })),
      spill,
      anchorStore(),
      findings
    );
    expect(first.summary.injectedChars).toBeGreaterThan(0);
    const prior = Buffer.from(
      JSON.stringify({
        ...request,
        input: [...input, { role: 'assistant', content: 'Prior response' }],
      })
    );
    expect(compressBody(prior, spill, anchorStore(), findings).body).toEqual(
      prior
    );
  });

  it('injects on the small first request and freezes the block as input grows', () => {
    const store = anchorStore();
    const first = compressBody(
      Buffer.from(JSON.stringify(request)),
      spill,
      store,
      findings
    );
    expect(JSON.parse(first.body.toString()).instructions).toContain('ALPHA');
    const next = compressBody(
      Buffer.from(
        JSON.stringify({
          ...request,
          input: [...request.input, { role: 'assistant', content: 'Next' }],
        })
      ),
      spill,
      store,
      []
    );
    expect(JSON.parse(next.body.toString()).instructions).toBe(
      JSON.parse(first.body.toString()).instructions
    );
    expect(first.summary.injectedChars).toBeGreaterThan(0);
    expect(first.summary.afterBytes).toBe(first.body.length);
  });

  it('remembers an empty graph and isolates proxy instances', () => {
    const store = anchorStore();
    const body = Buffer.from(JSON.stringify(request));
    compressBody(body, spill, store, []);
    expect(compressBody(body, spill, store, findings).body).toEqual(body);
    expect(
      JSON.parse(
        compressBody(body, spill, anchorStore(), findings).body.toString()
      ).instructions
    ).toContain('ALPHA');
  });

  it('excludes project claims from shared graphs and leaves server-managed history untouched', () => {
    const body = Buffer.from(JSON.stringify(request));
    expect(
      compressBody(body, spill, anchorStore(), findings, undefined, true).body
    ).toEqual(body);
    const chained = Buffer.from(
      JSON.stringify({ ...request, previous_response_id: 'prior' })
    );
    expect(compressBody(chained, spill, anchorStore(), findings).body).toEqual(
      chained
    );
  });
});
