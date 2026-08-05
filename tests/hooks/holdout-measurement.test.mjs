/**
 * The causal measurement, which had never once produced a reading.
 *
 * Measured across 122 real project graphs on one machine before this fix:
 * 6,725 captures, 136 injections, 97 treated, and **zero** holdout samples
 * counted. The net token balance was therefore uncomputable everywhere, which
 * means the question the whole product exists to answer -- does this save more
 * than it costs -- had no evidence of any kind behind it.
 *
 * Two independent causes, both reproduced here:
 *
 * 1. The event window is measured in EVENTS, and injections are a tiny minority
 *    of them. On this repository the log held 44 inject records, 9 of them
 *    holdout, ALL at lines 60-76 of 9,058 -- every one outside the last 5,000.
 *    `report()` said "0 holdout" while the file plainly contained nine.
 *
 * 2. `forCommand` hardcoded `holdout: false`, so 95 of those 136 injections
 *    could never contribute to the comparison at all.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { record, report, readBalance, inHoldout } from '../../hooks-core/metrics.mjs';
import { forCommand } from '../../hooks-core/inject.mjs';
import { putNode, putNodeWithEdges, load } from '../../hooks-core/wiki.mjs';

const NL = String.fromCharCode(10);

// A KNOWN POSITIVE FRACTION, set before anything calls inHoldout().
//
// Another suite sets this to '0' for its own reasons, and jest shares a process
// between suites in a worker -- so without pinning it here, the suite whose
// subject IS the holdout could run with the holdout disabled and still pass by
// finding no withheld command.
process.env.TOKEN_OPTIMIZER_HOLDOUT = '0.1';
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'holdout-'));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows */
  }
});

describe('the balance log survives the event window', () => {
  it('keeps holdout records that the firehose window has long since dropped', () => {
    // Exactly the shape of the real file: a handful of injections at the very
    // beginning, then thousands of ordinary events burying them.
    record(dir, { kind: 'inject', surface: 'file', anchor: '/a.ts', holdout: true, tokens: 0 });
    record(dir, { kind: 'inject', surface: 'file', anchor: '/b.ts', holdout: true, tokens: 0 });
    for (let i = 0; i < 20; i++) {
      record(dir, { kind: 'inject', surface: 'file', anchor: `/t${i}.ts`, holdout: false, tokens: 50 });
    }

    // Bury them under more events than the window admits, writing straight to
    // the firehose so the balance log is not touched.
    const noise =
      Array.from({ length: 6000 }, (_, i) =>
        JSON.stringify({ kind: 'capture', anchor: `/noise${i}.ts`, at: Date.now() })
      ).join(NL) + NL;
    appendFileSync(join(dir, 'metrics.jsonl'), noise);

    const balance = readBalance(dir);
    const holdouts = balance.filter((e) => e.kind === 'inject' && e.holdout);
    expect(holdouts).toHaveLength(2);

    const r = report(dir);
    expect(r.holdouts).toBe(2);
    expect(r.injections).toBe(20);
  }, 60_000);

  it('does not double-count a record present in both logs', () => {
    record(dir, { kind: 'inject', surface: 'file', anchor: '/a.ts', holdout: true, tokens: 0 });
    // Both files legitimately hold this record; the reader must dedupe it.
    expect(existsSync(join(dir, 'balance.jsonl'))).toBe(true);
    const inFirehose = readFileSync(join(dir, 'metrics.jsonl'), 'utf8').split(NL).filter(Boolean);
    const inBalance = readFileSync(join(dir, 'balance.jsonl'), 'utf8').split(NL).filter(Boolean);
    expect(inFirehose).toHaveLength(1);
    expect(inBalance).toHaveLength(1);

    expect(readBalance(dir).filter((e) => e.kind === 'inject')).toHaveLength(1);
  });

  it('still reads a graph written before the split, rather than resetting it to zero', () => {
    // MIGRATION. 122 graphs already exist with their only copy in the firehose.
    // Ignoring those would zero the measurement on every one of them.
    const legacy =
      [
        JSON.stringify({ kind: 'inject', surface: 'file', anchor: '/old.ts', holdout: true, tokens: 0, at: 1 }),
        JSON.stringify({ kind: 'inject', surface: 'file', anchor: '/old2.ts', holdout: false, tokens: 40, at: 2 }),
      ].join(NL) + NL;
    writeFileSync(join(dir, 'metrics.jsonl'), legacy);
    expect(existsSync(join(dir, 'balance.jsonl'))).toBe(false);

    const r = report(dir);
    expect(r.holdouts).toBe(1);
    expect(r.injections).toBe(1);
  });
});

describe('the command path takes part in the holdout', () => {
  const seed = (graphDir, trigger) => {
    const anchor = join(graphDir, 'subject.ts');
    writeFileSync(anchor, 'export const subject = 1;' + NL);
    const fid = putNode(graphDir, { kind: 'file', key: anchor, hash: 'h' });
    putNodeWithEdges(
      graphDir,
      {
        kind: 'finding',
        key: 'f-' + trigger,
        claim: 'Use npm test, not npx jest, for this project.',
        type: 'command',
        trigger,
        confidence: 0.95,
      },
      [{ edge: 'derived_from', to: fid }]
    );
  };

  it('records a surface, so the report can keep commands out of the file balance', () => {
    seed(dir, 'jest');
    forCommand(dir, load(dir), 'npx jest tests/', { sessionId: 's1' });
    const rec = readBalance(dir).find((e) => e.kind === 'inject');
    expect(rec).toBeDefined();
    expect(rec.surface).toBe('command');
  });

  it('withholds the text on a command that lands in the holdout arm', () => {
    // Find a command the stratifier actually withholds, rather than asserting a
    // rate: the arm is deterministic in (key, epoch), so one exists.
    let held = null;
    for (let i = 0; i < 400 && !held; i++) {
      const cmd = `npx jest suite-${i}`;
      if (inHoldout(cmd.trim().replace(/\s+/g, ' ').slice(0, 120).toLowerCase())) held = cmd;
    }
    expect(held).not.toBeNull();

    seed(dir, 'jest');
    const out = forCommand(dir, load(dir), held, { sessionId: 's1' });

    // Withheld means withheld: the subject must not receive the text, or the
    // arm records an experience that never happened.
    expect(out).toBeNull();

    const rec = readBalance(dir).find((e) => e.kind === 'inject');
    expect(rec.holdout).toBe(true);
    expect(rec.tokens).toBe(0);
  });

  it('serves and charges tokens on a command in the treated arm', () => {
    let treated = null;
    for (let i = 0; i < 400 && !treated; i++) {
      const cmd = `npx jest case-${i}`;
      if (!inHoldout(cmd.trim().replace(/\s+/g, ' ').slice(0, 120).toLowerCase())) treated = cmd;
    }
    expect(treated).not.toBeNull();

    seed(dir, 'jest');
    const out = forCommand(dir, load(dir), treated, { sessionId: 's1' });
    expect(out).toContain('npm test');

    const rec = readBalance(dir).find((e) => e.kind === 'inject');
    expect(rec.holdout).toBe(false);
    expect(rec.tokens).toBeGreaterThan(0);
  });

  it('is counted separately, because no read event can be joined to a command', () => {
    // A command's anchor is the command text. Mixing these into the file-read
    // balance would pull BOTH arm means toward zero in proportion to how many
    // commands ran, diluting a real saving with records that cannot show one.
    record(dir, { kind: 'inject', surface: 'command', anchor: 'npx jest', holdout: false, tokens: 30 });
    record(dir, { kind: 'inject', surface: 'command', anchor: 'git fetch', holdout: true, tokens: 0 });
    record(dir, { kind: 'inject', surface: 'file', anchor: '/a.ts', holdout: false, tokens: 20 });

    const r = report(dir);
    expect(r.injections).toBe(1); // file surface only
    expect(r.commandInjections).toBe(2);
    expect(r.commandHoldouts).toBe(1);
  });
});
