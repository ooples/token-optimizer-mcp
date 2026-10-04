/**
 * Does the audit catch a recorder that is lying, and refuse to certify one it
 * never examined?
 *
 * Four questions, in the order they can go wrong:
 *   - does a real disagreement get reported, with the right counts on each side
 *   - does an overlap that holds nothing read as "not compared" rather than as
 *     agreement
 *   - does the ledger's completion stamp get moved back to arrival, so a
 *     request both recorders saw is not reported as two different requests
 *   - does body content stay out of the report entirely
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditRecorders,
  renderAudit,
  CAPTURE_FILE,
  NO_MODEL,
} from '../../../src/inspect/audit.js';
import type { AccountingRecord } from '../../../src/proxy/accounting.js';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'audit-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const PATH = '/v1/messages';
/** Far enough apart that the window's slack cannot reach either record. */
const BASE = Date.parse('2026-04-01T12:00:00.000Z');

function body(model: string, filler: number): string {
  return JSON.stringify({ model, prompt: 'x'.repeat(filler) });
}

/** The capture file, written the way `proxy/capture.ts` writes it. */
function capture(
  lines: readonly { at: number; path?: string; body: string }[]
): string {
  writeFileSync(
    join(directory, CAPTURE_FILE),
    lines
      .map((line) =>
        JSON.stringify({
          at: line.at,
          path: line.path ?? PATH,
          body: line.body,
        })
      )
      .join('\n') + '\n'
  );
  return directory;
}

/** A ledger line, stamped at COMPLETION like the proxy stamps it. */
function record(
  arrivedAt: number,
  bytes: number,
  model: string | undefined,
  upstreamMs = 500
): AccountingRecord {
  return {
    ts: new Date(arrivedAt + upstreamMs + 10).toISOString(),
    path: PATH,
    status: 200,
    compressed: true,
    beforeBytes: bytes,
    afterBytes: bytes - 10,
    ...(model === undefined ? {} : { model }),
    usage: {},
    timing: { transformMs: 10, upstreamMs },
  };
}

function ledger(records: readonly AccountingRecord[]): string {
  const path = join(directory, 'ledger.jsonl');
  writeFileSync(
    path,
    records.map((one) => JSON.stringify(one)).join('\n') + '\n'
  );
  return path;
}

describe('auditRecorders', () => {
  it('agrees when both recorders saw the same bodies', async () => {
    const bodies = [body('claude-sol-5', 100), body('claude-sol-5', 250)];
    const dir = capture([
      { at: BASE, body: bodies[0] },
      { at: BASE + 60_000, body: bodies[1] },
    ]);
    const path = ledger([
      record(BASE, Buffer.byteLength(bodies[0]), 'claude-sol-5'),
      record(BASE + 60_000, Buffer.byteLength(bodies[1]), 'claude-sol-5'),
    ]);
    const report = await auditRecorders(dir, path);
    expect(report.capture.compared).toBe(2);
    expect(report.ledger.compared).toBe(2);
    expect(report.bytes).toEqual([]);
    expect(report.models).toEqual([]);
    expect(report.agreed).toBe(true);
  });

  it('reports a byte count the ledger took from the wrong body', async () => {
    const bodies = [body('claude-sol-5', 100), body('claude-sol-5', 250)];
    const dir = capture([
      { at: BASE, body: bodies[0] },
      { at: BASE + 60_000, body: bodies[1] },
    ]);
    // THE CLASSIC DEFECT, not an invented one: the second request's count
    // written against the first, so a total still adds up and only the
    // multiset of values gives it away.
    const wrong = Buffer.byteLength(bodies[1]);
    const path = ledger([
      record(BASE, wrong, 'claude-sol-5'),
      record(BASE + 60_000, wrong, 'claude-sol-5'),
    ]);
    const report = await auditRecorders(dir, path);
    expect(report.agreed).toBe(false);
    expect(report.bytes).toEqual([
      {
        path: PATH,
        value: String(Buffer.byteLength(bodies[0])),
        inCapture: 1,
        inLedger: 0,
      },
      { path: PATH, value: String(wrong), inCapture: 1, inLedger: 2 },
    ]);
    // The attribution was never wrong, and the audit must not say it was.
    expect(report.models).toEqual([]);
  });

  it('reports an attribution the two recorders read differently', async () => {
    const sent = body('claude-sol-5', 100);
    const dir = capture([{ at: BASE, body: sent }]);
    const path = ledger([
      record(BASE, Buffer.byteLength(sent), 'claude-haiku-4-5'),
    ]);
    const report = await auditRecorders(dir, path);
    expect(report.bytes).toEqual([]);
    expect(report.models).toEqual([
      { path: PATH, value: 'claude-haiku-4-5', inCapture: 0, inLedger: 1 },
      { path: PATH, value: 'claude-sol-5', inCapture: 1, inLedger: 0 },
    ]);
    expect(report.agreed).toBe(false);
  });

  it('treats a missing model as a value, not as nothing to compare', async () => {
    const sent = JSON.stringify({ prompt: 'no model field here' });
    const dir = capture([{ at: BASE, body: sent }]);
    const path = ledger([
      record(BASE, Buffer.byteLength(sent), 'claude-sol-5'),
    ]);
    const report = await auditRecorders(dir, path);
    expect(report.models.map((one) => one.value)).toEqual([
      NO_MODEL,
      'claude-sol-5',
    ]);
  });

  it('moves the ledger stamp back to arrival before comparing', async () => {
    const sent = body('claude-sol-5', 400);
    const dir = capture([
      { at: BASE, body: sent },
      { at: BASE + 120_000, body: sent },
    ]);
    // A SLOW UPSTREAM IS THE TEST. Stamped at completion, the second record
    // lands two minutes past the capture's last request and would fall outside
    // the overlap, excluding a request both recorders plainly saw.
    const path = ledger([
      record(BASE, Buffer.byteLength(sent), 'claude-sol-5', 500),
      record(BASE + 120_000, Buffer.byteLength(sent), 'claude-sol-5', 119_000),
    ]);
    const report = await auditRecorders(dir, path);
    expect(report.ledger.compared).toBe(2);
    expect(report.capture.compared).toBe(2);
    expect(report.agreed).toBe(true);
    expect(report.ledger.unaligned).toBe(0);
  });

  it('counts a ledger record whose arrival cannot be recovered', async () => {
    const sent = body('claude-sol-5', 100);
    const dir = capture([{ at: BASE, body: sent }]);
    const stamped = record(BASE, Buffer.byteLength(sent), 'claude-sol-5');
    const { timing: _dropped, ...withoutTiming } = stamped;
    const path = ledger([
      { ...withoutTiming, ts: new Date(BASE).toISOString() },
    ]);
    const report = await auditRecorders(dir, path);
    expect(report.ledger.unaligned).toBe(1);
    // Still compared -- an old ledger is readable, which is why `timing` is
    // optional in the first place.
    expect(report.ledger.compared).toBe(1);
    expect(report.agreed).toBe(true);
  });

  it('excludes the period only one recorder covered, and counts it', async () => {
    const early = body('claude-sol-5', 100);
    const both = body('claude-sol-5', 250);
    // Capture was on for all three; accounting was switched on an hour later.
    const dir = capture([
      { at: BASE, body: early },
      { at: BASE + 3_600_000, body: both },
      { at: BASE + 3_660_000, body: both },
    ]);
    const path = ledger([
      record(BASE + 3_600_000, Buffer.byteLength(both), 'claude-sol-5'),
      record(BASE + 3_660_000, Buffer.byteLength(both), 'claude-sol-5'),
    ]);
    const report = await auditRecorders(dir, path);
    expect(report.capture.total).toBe(3);
    expect(report.capture.compared).toBe(2);
    expect(report.capture.excluded).toBe(1);
    expect(report.ledger.compared).toBe(2);
    expect(report.agreed).toBe(true);
  });

  it('refuses to call an empty overlap an agreement', async () => {
    const sent = body('claude-sol-5', 100);
    const dir = capture([{ at: BASE, body: sent }]);
    // A DAY APART, so the extents do not meet at all.
    const path = ledger([
      record(BASE + 86_400_000, Buffer.byteLength(sent), 'claude-sol-5'),
    ]);
    const report = await auditRecorders(dir, path);
    expect(report.capture.compared).toBe(0);
    expect(report.ledger.compared).toBe(0);
    expect(report.bytes).toEqual([]);
    expect(report.agreed).toBe(false);
  });

  it('refuses when a capture was never written', async () => {
    const sent = body('claude-sol-5', 100);
    const path = ledger([
      record(BASE, Buffer.byteLength(sent), 'claude-sol-5'),
    ]);
    const report = await auditRecorders(directory, path);
    expect(report.capture.missing).toBe(true);
    expect(report.from).toBeNull();
    expect(report.agreed).toBe(false);
  });

  it('refuses when the ledger was never written', async () => {
    const dir = capture([{ at: BASE, body: body('claude-sol-5', 100) }]);
    const report = await auditRecorders(dir, join(directory, 'absent.jsonl'));
    expect(report.ledger.missing).toBe(true);
    expect(report.agreed).toBe(false);
  });

  it('keys a disagreement by path, so two endpoints never cancel out', async () => {
    const sent = body('claude-sol-5', 100);
    const bytes = Buffer.byteLength(sent);
    const dir = capture([
      { at: BASE, path: '/v1/messages', body: sent },
      { at: BASE + 60_000, path: '/v1/complete', body: sent },
    ]);
    // Both counts are right, but one is filed under the wrong endpoint. A
    // tally keyed on the value alone would report agreement.
    const path = ledger([
      { ...record(BASE, bytes, 'claude-sol-5'), path: '/v1/messages' },
      {
        ...record(BASE + 60_000, bytes + 1, 'claude-sol-5'),
        path: '/v1/complete',
      },
    ]);
    const report = await auditRecorders(dir, path);
    expect(report.bytes.map((one) => one.path)).toEqual([
      '/v1/complete',
      '/v1/complete',
    ]);
    expect(report.agreed).toBe(false);
  });
});

describe('the audit keeps body content out of its findings', () => {
  // THE WHOLE REASON THIS NEEDS A PIN. A capture directory is conversation
  // content in plaintext: prompts, pasted files, tool output. The audit reads
  // every byte of it and must carry nothing out but a length and the model id
  // the ledger already records.
  const SECRET = 'the-user-pasted-this-into-their-prompt';

  it('emits no prompt text, in either rendering, even when they disagree', async () => {
    const sent = JSON.stringify({ model: 'claude-sol-5', prompt: SECRET });
    const dir = capture([{ at: BASE, body: sent }]);
    const path = ledger([
      // A disagreement, so the findings are populated rather than empty.
      record(BASE, Buffer.byteLength(sent) + 99, 'claude-sol-5'),
    ]);
    const report = await auditRecorders(dir, path);
    // Two findings for one wrong count: the value one side has and the other
    // does not, from each side.
    expect(report.bytes).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(renderAudit(report).join('\n')).not.toContain(SECRET);
    // The positive control: the secret really was in the file the audit read,
    // so the assertions above are about the report and not about an empty read.
    expect(readFileSync(join(dir, CAPTURE_FILE), 'utf8')).toContain(SECRET);
  });
});

describe('renderAudit', () => {
  it('names the extent before the verdict', async () => {
    const sent = body('claude-sol-5', 100);
    const dir = capture([
      { at: BASE, body: sent },
      { at: BASE + 60_000, body: sent },
    ]);
    const path = ledger([
      record(BASE, Buffer.byteLength(sent), 'claude-sol-5'),
      record(BASE + 60_000, Buffer.byteLength(sent), 'claude-sol-5'),
    ]);
    const lines = renderAudit(await auditRecorders(dir, path));
    const text = lines.join('\n');
    expect(text).toContain('capture: 2 records');
    expect(text).toContain('window: ');
    expect(lines[lines.length - 1]).toContain('agreed:');
  });

  it('says nothing was compared rather than printing a verdict', async () => {
    const sent = body('claude-sol-5', 100);
    const path = ledger([
      record(BASE, Buffer.byteLength(sent), 'claude-sol-5'),
    ]);
    const text = renderAudit(await auditRecorders(directory, path)).join('\n');
    expect(text).toContain('capture: not there');
    expect(text).toContain('nothing was compared');
    expect(text).toContain('TOKEN_OPTIMIZER_PROXY_CAPTURE');
    expect(text).not.toContain('agreed:');
  });

  it('prints each disagreement with the count from both sides', async () => {
    const sent = body('claude-sol-5', 100);
    const dir = capture([
      { at: BASE, body: sent },
      { at: BASE + 60_000, body: sent },
    ]);
    const path = ledger([
      record(BASE, Buffer.byteLength(sent), 'claude-sol-5'),
      record(BASE + 60_000, 4, 'claude-sol-5'),
    ]);
    const text = renderAudit(await auditRecorders(dir, path)).join('\n');
    expect(text).toContain('body bytes the two recorders count differently');
    expect(text).toContain(`${PATH} 4: 0 captured, 1 in the ledger`);
    expect(text).toContain('disagreed: 2 byte counts and 0 model ids differ');
  });
});
