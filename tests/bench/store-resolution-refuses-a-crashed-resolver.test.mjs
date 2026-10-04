/**
 * A RESOLVER THAT CRASHED MUST NOT SCORE.
 *
 * `resolve-theirs.py` used to fall back to the unresolved text when their
 * resolver raised. That text carries their markers with no `[unresolved:`
 * suffix on any of them, so `unresolved` came out zero and `redeemed` came out
 * equal to `markers`: a full-marks row for a run that never happened. The row
 * is now written unmeasured, and this pins the gate that reads it -- including
 * the arm that proves the old shape really did sail through.
 */
import { resolutionUsable } from '../../bench/compression/store-resolution.mjs';

const RAW = 'before <<ccr:aaaaaaaa>> middle <<ccr:bbbbbbbb>> after';
const RESOLVED = 'before one middle two after';

describe('resolutionUsable on a resolver that raised', () => {
  it('refuses the row and names the exception', () => {
    const verdict = resolutionUsable({
      text: null,
      markers: 2,
      redeemed: null,
      unresolved: null,
      error: 'RuntimeError: store closed',
      reasons: [],
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.detail).toBe('their resolver raised RuntimeError: store closed');
  });

  it('names the resolver error rather than the null text it also has', () => {
    // Both refusals apply to the row `resolve-theirs.py` now writes. The one
    // that says WHICH exception stopped it is the one worth printing.
    const verdict = resolutionUsable({
      text: null,
      markers: 2,
      unresolved: null,
      error: 'sqlite3.OperationalError: database is locked',
      reasons: [],
    });
    expect(verdict.detail).toBe(
      'their resolver raised sqlite3.OperationalError: database is locked'
    );
  });

  it('control: the shape it used to write scored as a clean sweep', () => {
    // The old error branch kept `text` and computed the counts from it. Drop
    // the `error` field -- the only thing standing between that row and a
    // score -- and the row reads as every marker redeemed.
    const asItWasWritten = { text: RAW, markers: 2, unresolved: 0, reasons: [] };
    expect(asItWasWritten.markers - asItWasWritten.unresolved).toBe(2);
    expect(resolutionUsable(asItWasWritten).usable).toBe(true);
    expect(resolutionUsable(asItWasWritten).detail).toBe('2 of 2 marker(s) redeemed');
  });

  it('control: a row whose resolver ran is still measured', () => {
    const verdict = resolutionUsable({
      text: RESOLVED,
      markers: 2,
      unresolved: 0,
      error: null,
      reasons: [],
    });
    expect(verdict.usable).toBe(true);
    expect(verdict.detail).toBe('2 of 2 marker(s) redeemed');
  });

  it('control: a row with no markers at all is measured, not refused', () => {
    const verdict = resolutionUsable({ text: RESOLVED, markers: 0, unresolved: 0, error: null });
    expect(verdict.usable).toBe(true);
    expect(verdict.detail).toBe('no markers to redeem');
  });
});