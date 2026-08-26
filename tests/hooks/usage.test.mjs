/**
 * Layer 1 -- explicit-reference classification.
 *
 * TWO CORRECTIONS TO THE BRIEF'S TEST SNIPPET, both found by reading the
 * producers rather than trusting the plan:
 *
 *   1. `inject` events carry `findingIds`, not `findingKeys`. All five call
 *      sites in inject.mjs write `findingIds`, and `recordToolOutcome` copies
 *      that field. A test written against `findingKeys` would have passed
 *      against an implementation that read a field production never writes --
 *      a metric with no producer, validated by its own suite.
 *   2. `expand` does not name a finding. `recordExpansion` writes a truncation
 *      capture `ref`, a tool, a shape and a free-text `asked`. None is a graph
 *      key, and all 64 live `expand` events on this machine carry
 *      `sessionId: null`. So the reference channel is `query` alone, and there
 *      is a test below pinning that rather than leaving it implicit.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record, recordToolOutcome } from '../../hooks-core/metrics.mjs';
import {
  classify,
  referenceRate,
  referenceNote,
} from '../../hooks-core/usage.mjs';
import { renderAudit } from '../../hooks-core/audit.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const inject = (over = {}) =>
  record(dir, {
    kind: 'inject',
    anchor: 'a.ts',
    findingIds: ['k1'],
    sessionId: 's',
    at: 1,
    ...over,
  });

const query = (over = {}) =>
  record(dir, {
    kind: 'query',
    operation: 'get',
    key: 'k1',
    sessionId: 's',
    at: 2,
    ...over,
  });

const labelOf = (key = 'k1') =>
  classify(dir).find((row) => row.findingKey === key)?.label;

describe('Layer 1 classification', () => {
  it('labels an injection referenced when a later query names the finding', () => {
    inject();
    query();
    expect(labelOf()).toBe('referenced');
  });

  it('does not count a query that preceded the injection', () => {
    query({ at: 1 });
    inject({ at: 2 });
    expect(labelOf()).not.toBe('referenced');
  });

  it('labels an injection not-referenced when the session went on without asking', () => {
    inject();
    // Activity in the same session after the injection: the opportunity
    // existed and was not taken.
    record(dir, { kind: 'read', anchor: 'b.ts', sessionId: 's', at: 5 });
    expect(labelOf()).toBe('not-referenced');
  });

  it('labels an injection unknown when nothing followed it', () => {
    inject();
    expect(labelOf()).toBe('unknown');
  });

  it('credits a reference from another session, because a session id is not evidence', () => {
    // `wiki_query` takes `sessionId` as an OPTIONAL input the model has to
    // volunteer, so scoping on it made the numerator depend on the model
    // choosing to identify itself. The finding key is the specific part.
    inject({ sessionId: 's' });
    query({ sessionId: 'other', at: 3 });
    expect(labelOf()).toBe('referenced');
  });

  it('credits a query that carries no session id at all', () => {
    inject();
    query({ sessionId: null, at: 3 });
    expect(labelOf()).toBe('referenced');
  });

  it('treats an expand as opportunity but never as a reference', () => {
    // `expand` names a capture ref, not a finding key -- so even an expand
    // whose ref happens to equal the finding key must not count.
    inject();
    record(dir, { kind: 'expand', ref: 'k1', sessionId: 's', at: 4 });
    expect(labelOf()).toBe('not-referenced');
  });

  it('never reads an expand as a reference, even one carrying a key', () => {
    // THE CHANNEL IS `query` ALONE. Widening REFERENCE_KINDS to include
    // `expand` for symmetry with the brief must not silently start crediting
    // expansions -- they name a truncation capture, not a finding.
    inject();
    record(dir, { kind: 'expand', key: 'k1', sessionId: 's', at: 4 });
    expect(labelOf()).toBe('not-referenced');
  });

  it('never reads a capture ref as a finding key', () => {
    // `ref` is a 16-hex digest of captured tool output. Consulting it as a
    // fallback for `key` would attribute a reference to a finding whose key
    // merely collided with a capture id.
    inject();
    record(dir, { kind: 'query', ref: 'k1', sessionId: 's', at: 4 });
    expect(labelOf()).toBe('not-referenced');
  });

  it('returns rows in time order, not in log order', () => {
    // The consumer pairs these rows against Layer 2's per-finding effects, so
    // the order is contract rather than incidental -- and the log is written in
    // WRITE order, which detached workers do not guarantee matches `at`.
    inject({ findingIds: ['late'], at: 90 });
    inject({ findingIds: ['early'], at: 10 });
    expect(classify(dir).map((row) => row.findingKey)).toEqual([
      'early',
      'late',
    ]);
  });

  it('counts each injection of a finding as its own opportunity', () => {
    inject({ at: 1 });
    inject({ at: 10 });
    query({ at: 2 });
    const labels = classify(dir).map((row) => row.label);
    expect(labels).toEqual(['referenced', 'unknown']);
  });

  it('uses the outcome join as opportunity when the log has no session id', () => {
    const injection = record(dir, {
      kind: 'inject',
      anchor: 'a.ts',
      findingIds: ['k1'],
      episodeId: 'e',
      toolCallId: 'tc',
      at: 1,
    });
    recordToolOutcome(dir, {
      episodeId: 'e',
      toolCallId: 'tc',
      anchor: 'a.ts',
      at: 2,
      success: true,
    });
    expect(injection.injectionId).toBeTruthy();
    expect(labelOf()).toBe('not-referenced');
  });

  it('ignores an injection that carried no findings', () => {
    inject({ findingIds: [] });
    expect(classify(dir)).toEqual([]);
  });
});

describe('Layer 1 rate', () => {
  it('excludes unknown from the denominator instead of scoring it a miss', () => {
    inject();
    query();
    record(dir, {
      kind: 'inject',
      anchor: 'b.ts',
      findingIds: ['k2'],
      sessionId: 's2',
      at: 3,
    });
    const rate = referenceRate(dir);
    expect(rate.denominator).toBeLessThan(classify(dir).length);
    expect(rate.unknown).toBe(1);
    expect(rate.rate).toBe(1);
  });

  it('returns a null rate rather than 0 when there is no evidence', () => {
    expect(referenceRate(dir).rate).toBeNull();
  });

  it('returns a null rate when the reference channel never fired at all', () => {
    // A real denominator, and zero references -- but no query event exists in
    // the window, so 0% would be measuring the absence of a producer.
    inject();
    record(dir, { kind: 'read', anchor: 'b.ts', sessionId: 's', at: 5 });
    const rate = referenceRate(dir);
    expect(rate.denominator).toBe(1);
    expect(rate.referenceEvents).toBe(0);
    expect(rate.rate).toBeNull();
  });

  it('reports a real 0 once the channel has fired and named something else', () => {
    inject();
    record(dir, { kind: 'read', anchor: 'b.ts', sessionId: 's', at: 5 });
    query({ key: 'somethingElse', at: 6 });
    const rate = referenceRate(dir);
    expect(rate.referenceEvents).toBe(1);
    expect(rate.rate).toBe(0);
  });

  it('counts a query with no session id as a usable reference event', () => {
    inject();
    query({ sessionId: null, at: 2 });
    const rate = referenceRate(dir);
    expect(rate.referenceEvents).toBe(1);
    expect(rate.referenced).toBe(1);
    // The field that counted the session-less losses is gone, not zeroed: a
    // permanent 0 would read as "the loss was fixed".
    expect(rate).not.toHaveProperty('unscopedReferences');
  });

  it('separates outcomes the join could not attribute from both arms', () => {
    recordToolOutcome(dir, {
      episodeId: 'nothing-injected',
      toolCallId: 'tc',
      anchor: 'z.ts',
      at: 1,
      success: true,
    });
    const rate = referenceRate(dir);
    expect(rate.unattributable).toBe(1);
    // No injection was ever attached to that tool call, so the join did not
    // FAIL -- there was nothing to join to. The two figures must not agree.
    expect(rate.unattributableWithInjectedToolCall).toBe(0);
    expect(rate.denominator).toBe(0);
  });

  it('does not score a whole session a join failure because one call was injected', () => {
    // THE MEASUREMENT-BIAS REGRESSION. `episodeId` IS the session id, so
    // keying the join-failure count on the episode scored every tool call of
    // the session -- 2,559 of them on this repository's real log -- as a
    // failed join, where the true number is zero.
    record(dir, {
      kind: 'inject',
      anchor: 'a.ts',
      findingIds: ['k1'],
      episodeId: 'e',
      toolCallId: 'injected-call',
      sessionId: 's',
      at: 1,
    });
    for (const id of ['other-1', 'other-2', 'other-3']) {
      recordToolOutcome(dir, {
        episodeId: 'e',
        toolCallId: id,
        anchor: 'elsewhere.ts',
        at: 2,
        success: true,
      });
    }
    const rate = referenceRate(dir);
    expect(rate.unattributable).toBe(3);
    expect(rate.unattributableWithInjectedToolCall).toBe(0);
  });

  it('marks an unattributable outcome on an injected tool call as a real join failure', () => {
    record(dir, {
      kind: 'inject',
      anchor: 'a.ts',
      findingIds: ['k1'],
      episodeId: 'e',
      toolCallId: 'tc',
      sessionId: 's',
      at: 1,
    });
    // Same tool call, but a DIFFERENT episode, so recordToolOutcome finds no
    // candidate and reports `none` on a call that did carry findings.
    recordToolOutcome(dir, {
      episodeId: 'elsewhere',
      toolCallId: 'tc',
      anchor: 'a.ts',
      at: 2,
      success: true,
    });
    const rate = referenceRate(dir);
    expect(rate.unattributable).toBe(1);
    expect(rate.unattributableWithInjectedToolCall).toBe(1);
  });
});

describe('Layer 1 disclosure', () => {
  it('says nothing at all when there is nothing to say', () => {
    expect(referenceNote(dir)).toBeNull();
  });

  it('says not measurable rather than 0% when the channel never fired', () => {
    inject();
    record(dir, { kind: 'read', anchor: 'b.ts', sessionId: 's', at: 5 });
    expect(referenceNote(dir)).toContain('not measurable');
  });

  it('quotes the measured rate once there is one', () => {
    inject();
    query();
    expect(referenceNote(dir)).toContain('1/1');
  });

  it('discloses the cross-attribution cost beside the number it qualifies', () => {
    // The caveat has to live where a human meets the figure. A task report is
    // not where someone quoting the number will look.
    inject();
    query();
    expect(referenceNote(dir)).toContain('cross-attribute');
  });

  it('says the denominator can understate when the read was truncated', () => {
    // One oversized record forces `readMetrics` past its byte cap, which is
    // the same truncation that hid both of this repository's real injections.
    record(dir, { kind: 'padding', pad: 'x'.repeat(2_200_000), at: 0 });
    inject();
    query();
    const rate = referenceRate(dir);
    expect(rate.windowed).toBe(true);
    expect(referenceNote(dir)).toContain('can understate');
  });

  it('does not claim a window when the caller supplied its own events', () => {
    const events = [
      { kind: 'inject', findingIds: ['k1'], injectionId: 'i', sessionId: 's', at: 1 },
      { kind: 'query', operation: 'get', key: 'k1', sessionId: 's', at: 2 },
    ];
    expect(referenceRate(dir, { events }).windowed).toBe(false);
  });

  it('reaches the audit report, which is its only production reader', () => {
    // WIRING, not logic. A measurement with no reader is how this project
    // shipped two metrics whose only consumer was their own test suite, so the
    // path from classify() to something a human sees is asserted directly.
    inject();
    query();
    const { text } = renderAudit(dir, []);
    expect(text).toContain('Injected findings referenced later');
  });
});
