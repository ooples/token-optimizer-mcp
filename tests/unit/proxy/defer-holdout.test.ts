/**
 * The tool-deferral holdout, which is the only EVIDENCE the saving is real.
 *
 * Deferral does not remove a tool schema from the request. It marks the schema
 * and the provider is the party that declines to place it in the prompt it
 * bills for. Our own count of the deferred bytes is exact arithmetic, and it is
 * arithmetic about a decision somebody else makes: if the beta were silently
 * ignored, every number we print would be unchanged and every one of them would
 * be wrong. The holdout withholds deferral from a random fraction of
 * conversations so the saving can be read off the provider's own prompt counts
 * instead of off our model of them.
 *
 * TWO THINGS HAVE TO HOLD FOR THAT TO WORK, and they are what these tests
 * assert: a control-arm request must come back with its tools untouched AND
 * still carry its arm label, because an arm recorded only when the feature
 * acted is a trial with one arm in it.
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import {
  compressBody,
  deferHoldoutFraction,
  type ProxySummary,
} from '../../../src/proxy/server.js';
import { OUTPUT_ARM } from '../../../src/proxy/output-savings.js';

const HOLDOUT_ENV = 'TOKEN_OPTIMIZER_PROXY_DEFER_HOLDOUT';
const PRIOR = process.env[HOLDOUT_ENV];

afterEach(() => {
  // Process-wide, and jest shares a worker between files.
  if (PRIOR === undefined) delete process.env[HOLDOUT_ENV];
  else process.env[HOLDOUT_ENV] = PRIOR;
});

/**
 * A request with enough verbose tools that deferral has something to take.
 *
 * The filler message is there to clear the proxy's size floor, and the schemas
 * are padded past `SMALL_TOOL_CHARS` so the exemption is not what decides the
 * outcome of any test below.
 */
function request(tools: number): Record<string, unknown> {
  return {
    model: 'claude-sonnet-4',
    system: 'You are a coding agent.',
    messages: [
      {
        role: 'user',
        content: [{ type: 'tool_result', content: 'x'.repeat(40_000) }],
      },
    ],
    tools: Array.from({ length: tools }, (_, i) => ({
      name: `tool_${i}`,
      description: `Does thing number ${i}. ${'detail '.repeat(120)}`,
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'detail '.repeat(60) },
          flag: { type: 'boolean', description: 'detail '.repeat(60) },
        },
        required: ['path'],
      },
    })),
  };
}

function compress(tools: number): {
  summary: Omit<ProxySummary, 'path'>;
  sent: Record<string, unknown>;
} {
  const out = compressBody(Buffer.from(JSON.stringify(request(tools)), 'utf8'));
  return {
    summary: out.summary,
    sent: JSON.parse(out.body.toString('utf8')) as Record<string, unknown>,
  };
}

/** How many of the forwarded tools carry the deferral marker. */
function marked(sent: Record<string, unknown>): number {
  const tools = sent.tools;
  if (!Array.isArray(tools)) return 0;
  return tools.filter(
    (tool) => (tool as { defer_loading?: unknown }).defer_loading === true
  ).length;
}

describe('deferHoldoutFraction', () => {
  it('is zero unless an operator asked for an experiment', () => {
    expect(deferHoldoutFraction({})).toBe(0);
    expect(deferHoldoutFraction({ [HOLDOUT_ENV]: '' })).toBe(0);
    expect(deferHoldoutFraction({ [HOLDOUT_ENV]: '   ' })).toBe(0);
    // POSITIVE CONTROL: the reader does respond to a value, so the zeros above
    // are refusals rather than a function that always returns zero.
    expect(deferHoldoutFraction({ [HOLDOUT_ENV]: '0.1' })).toBeCloseTo(0.1, 12);
  });

  it('refuses a value that is not a fraction rather than guessing one', () => {
    expect(deferHoldoutFraction({ [HOLDOUT_ENV]: 'half' })).toBe(0);
    expect(deferHoldoutFraction({ [HOLDOUT_ENV]: '-0.5' })).toBe(0);
    expect(deferHoldoutFraction({ [HOLDOUT_ENV]: '0' })).toBe(0);
    expect(deferHoldoutFraction({ [HOLDOUT_ENV]: 'NaN' })).toBe(0);
    // CLAMPED, NOT REFUSED, above one: an operator asking to withhold the
    // feature from everyone has asked for something coherent.
    expect(deferHoldoutFraction({ [HOLDOUT_ENV]: '2' })).toBe(1);
    expect(deferHoldoutFraction({ [HOLDOUT_ENV]: '1' })).toBe(1);
    // POSITIVE CONTROL for the clamp: 0.5 is neither refused nor clamped.
    expect(deferHoldoutFraction({ [HOLDOUT_ENV]: '0.5' })).toBeCloseTo(0.5, 12);
  });
});

describe('the holdout is reachable through compressBody', () => {
  it('labels no arm at all when no experiment is running', () => {
    delete process.env[HOLDOUT_ENV];
    const { summary, sent } = compress(30);
    // ABSENT, NOT `Treatment`. Every request is treated when no holdout runs,
    // and labelling them all as a treatment arm would offer the estimator a
    // comparison it has no control group for.
    expect(summary.deferralArm).toBeUndefined();
    // POSITIVE CONTROL: deferral did act, so the missing label is a deliberate
    // absence and not a sign the feature was off.
    expect(summary.deferredTools).toBeGreaterThan(0);
    expect(marked(sent)).toBe(summary.deferredTools);
  });

  it('withholds deferral from the control arm and still labels it', () => {
    process.env[HOLDOUT_ENV] = '1';
    const { summary, sent } = compress(30);
    expect(summary.deferralArm).toBe(OUTPUT_ARM.Control);
    // THE ARM IS NOT A CLAIM THAT SOMETHING HAPPENED. Nothing was deferred,
    // which is the entire point of a control arm, and the label still has to
    // travel with the row or the arm has no rows in it.
    expect(summary.deferredTools ?? 0).toBe(0);
    expect(marked(sent)).toBe(0);
    // POSITIVE CONTROL: the tools are all still on the wire, so the zero above
    // is a withheld treatment rather than a request that had no tools.
    expect(Array.isArray(sent.tools) ? sent.tools.length : 0).toBe(30);
  });

  it('defers and labels the treatment arm', () => {
    // A hundredth of conversations withheld: this key lands in the other 99%.
    process.env[HOLDOUT_ENV] = '0.01';
    const { summary, sent } = compress(30);
    expect(summary.deferralArm).toBe(OUTPUT_ARM.Treatment);
    expect(summary.deferredTools).toBeGreaterThan(0);
    expect(marked(sent)).toBe(summary.deferredTools);
  });
});
