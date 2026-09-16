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
