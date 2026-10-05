/**
 * The shaper must be REACHABLE through the shipped entry point.
 *
 * A unit test on output-shaper.ts proves the module works; it proves nothing
 * about whether anything calls it. This package's recurring defect is exactly
 * that gap — a capability that is registered, tested and green while the
 * production call site never names it — so these tests go through
 * `compressBody`, which is what the proxy actually invokes, and assert on the
 * bytes it returns for forwarding.
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventsFile } from '../../../src/telemetry/recorder.js';
import { compressBody } from '../../../src/proxy/server.js';

const PRIOR = {
  telemetry: process.env.TOKEN_OPTIMIZER_TELEMETRY,
  home: process.env.USERPROFILE,
  unixHome: process.env.HOME,
  shaper: process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER,
  holdout: process.env.TOKEN_OPTIMIZER_OUTPUT_HOLDOUT,
};

afterEach(() => {
  // Process-wide, and jest shares a worker between files.
  if (PRIOR.shaper === undefined) delete process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER;
  else process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER = PRIOR.shaper;
  if (PRIOR.holdout === undefined) delete process.env.TOKEN_OPTIMIZER_OUTPUT_HOLDOUT;
  else process.env.TOKEN_OPTIMIZER_OUTPUT_HOLDOUT = PRIOR.holdout;
  if (PRIOR.telemetry === undefined) delete process.env.TOKEN_OPTIMIZER_TELEMETRY;
  else process.env.TOKEN_OPTIMIZER_TELEMETRY = PRIOR.telemetry;
  if (PRIOR.home === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = PRIOR.home;
  if (PRIOR.unixHome === undefined) delete process.env.HOME;
  else process.env.HOME = PRIOR.unixHome;
});

/** A request big enough to clear the proxy's size floor. */
function request(extra: Record<string, unknown> = {}) {
  const filler = 'x'.repeat(40_000);
  return {
    model: 'claude-sonnet-4',
    system: 'You are a coding agent.',
    messages: [
      { role: 'user', content: [{ type: 'tool_result', content: filler }] },
    ],
    ...extra,
  };
}

const forward = (payload: Record<string, unknown>) =>
  JSON.parse(compressBody(Buffer.from(JSON.stringify(payload), 'utf8')).body.toString('utf8')) as Record<
    string,
    unknown
  >;

describe('the shaper is reachable through compressBody', () => {
  it('does nothing when the switch is unset', () => {
    delete process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER;
    const out = forward(request());
    expect(out.system).toBe('You are a coding agent.');
  });

  it('appends the note at the END of the system prompt when enabled', () => {
    process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER = '1';
    const out = forward(request());
    const system = out.system as string;
    // THE CACHE-SAFETY PROPERTY, asserted on the forwarded bytes rather than on
    // the module's return value: the client's prefix must be untouched.
    expect(system.startsWith('You are a coding agent.')).toBe(true);
    expect(system.length).toBeGreaterThan('You are a coding agent.'.length);
  });

  it('clamps the thinking budget on a resumption turn', () => {
    process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER = '1';
    const out = forward(request({ thinking: { type: 'enabled', budget_tokens: 16_000 } }));
    expect((out.thinking as Record<string, unknown>).budget_tokens).toBe(1024);
  });

  it('leaves the budget alone on a turn that carries a real question', () => {
    process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER = '1';
    const payload = request({ thinking: { type: 'enabled', budget_tokens: 16_000 } });
    payload.messages = [{ role: 'user', content: 'why did that fail? '.repeat(3000) }];
    const out = forward(payload);
    expect((out.thinking as Record<string, unknown>).budget_tokens).toBe(16_000);
  });

  it('forwards unshaped for a held-out conversation', () => {
    process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER = '1';
    process.env.TOKEN_OPTIMIZER_OUTPUT_HOLDOUT = '1';
    const out = forward(request());
    expect(out.system).toBe('You are a coding agent.');
  });

  it('emits valid json that still carries the conversation', () => {
    // A re-serialisation bug would show up as a dropped field rather than as a
    // parse error, so the shape is asserted too.
    process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER = '1';
    const out = forward(request());
    expect(out.model).toBe('claude-sonnet-4');
    expect(Array.isArray(out.messages)).toBe(true);
    expect((out.messages as unknown[]).length).toBe(1);
  });
});

/**
 * The arm the shaper took is the one number we cannot recover after the fact.
 *
 * These tests exist for the same reason as the ones above: `record` being tested
 * in isolation says nothing about whether the proxy ever calls it, and an opt-in
 * that collects nothing is worse than no opt-in, because `doctor` will happily
 * report the switch as on. So they go through `compressBody` and read the file
 * off disk -- redirecting HOME first, so a test never writes to the real one.
 */
describe('the shaper arm reaches the recorder', () => {
  let home: string;

  const runWithHome = (extra: Record<string, string>) => {
    home = mkdtempSync(join(tmpdir(), 'wiring-telemetry-'));
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    for (const [k, v] of Object.entries(extra)) process.env[k] = v;
    forward(request());
    const at = eventsFile(process.env);
    const lines = existsSync(at)
      ? readFileSync(at, 'utf8')
          .trim()
          .split('\n')
          .filter((l) => l.length > 0)
      : [];
    rmSync(home, { recursive: true, force: true });
    return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  };

  it('records the arm when the user opted in', () => {
    const events = runWithHome({
      TOKEN_OPTIMIZER_OUTPUT_SHAPER: '1',
      TOKEN_OPTIMIZER_TELEMETRY: '1',
    });
    const arms = events.filter((e) => e.event_type === 'output_shaper_arm');
    expect(arms).toHaveLength(1);
    const props = arms[0].properties as Record<string, unknown>;
    expect(props.holdout).toBe(false);
    expect(props.shaped).toBe(true);
    expect(arms[0].library_version).not.toBe('unknown');
  });

  it('marks the holdout arm as held out rather than skipping the event', () => {
    const events = runWithHome({
      TOKEN_OPTIMIZER_OUTPUT_SHAPER: '1',
      TOKEN_OPTIMIZER_OUTPUT_HOLDOUT: '1',
      TOKEN_OPTIMIZER_TELEMETRY: '1',
    });
    // THE HOLDOUT ARM IS THE POINT. Dropping its event would leave only the
    // treated arm on record, which is a comparison with one side missing.
    const arms = events.filter((e) => e.event_type === 'output_shaper_arm');
    expect(arms).toHaveLength(1);
    const props = arms[0].properties as Record<string, unknown>;
    expect(props.holdout).toBe(true);
    expect(props.shaped).toBe(false);
  });

  it('writes nothing at all when the user did not opt in', () => {
    const events = runWithHome({ TOKEN_OPTIMIZER_OUTPUT_SHAPER: '1' });
    expect(events).toHaveLength(0);
  });
});

describe('the arm reaches the ledger row, not just the telemetry', () => {
  /**
   * WHY THIS IS A SEPARATE SEAM FROM THE RECORDER ABOVE. The telemetry event
   * counts arms; it carries no token count, so it can say how often the
   * holdout fired and never what the two arms emitted. The measured output
   * tier is a difference between the arms' output tokens, and only the
   * per-request ledger row holds both. A label in the wrong place is a
   * capability that is registered, tested and green while the measurement it
   * exists for has no data.
   */
  const summaryFor = (payload: Record<string, unknown>) =>
    compressBody(Buffer.from(JSON.stringify(payload), 'utf8')).summary;

  it('labels the treated arm when an experiment is running', () => {
    process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER = '1';
    // A hair above zero: nobody lands in the control arm, so every request
    // this test sends is a treated one.
    process.env.TOKEN_OPTIMIZER_OUTPUT_HOLDOUT = '0.0000001';
    expect(summaryFor(request()).outputArm).toBe('treatment');
  });

  it('labels the arm it actually withheld shaping from', () => {
    process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER = '1';
    process.env.TOKEN_OPTIMIZER_OUTPUT_HOLDOUT = '1';
    const { body, summary } = compressBody(
      Buffer.from(JSON.stringify(request()), 'utf8')
    );
    expect(summary.outputArm).toBe('control');
    // AND THE LABEL AGREES WITH THE BYTES, which is the whole point of reading
    // the shaper's own decision rather than hashing again: a row labelled a
    // control must have gone upstream unshaped.
    const out = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    expect(out.system).toBe('You are a coding agent.');
  });

  it('carries no arm at all when no experiment was configured', () => {
    process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER = '1';
    delete process.env.TOKEN_OPTIMIZER_OUTPUT_HOLDOUT;
    const summary = summaryFor(request());
    // Not 'treatment': a trial that was never started must not read as one
    // whose control arm came back empty.
    expect(summary.outputArm).toBeUndefined();
    // POSITIVE CONTROL that the row was built and the shaper did run, so the
    // absent arm above is the refusal and not a dead code path.
    expect(summary.beforeBytes).toBeGreaterThan(0);
  });

  it('carries no arm when the shaper itself is off', () => {
    delete process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER;
    process.env.TOKEN_OPTIMIZER_OUTPUT_HOLDOUT = '0.5';
    const summary = summaryFor(request());
    // A fraction set with the shaper off withholds nothing from anything, so
    // there are no arms to label -- and labelling them would invite a
    // comparison between two groups that were treated identically.
    expect(summary.outputArm).toBeUndefined();
    expect(summary.beforeBytes).toBeGreaterThan(0);
  });
});
