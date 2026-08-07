/**
 * Cache measurement must not invent costs.
 *
 * Every case here was found by auditing this module against the four real Claude Code
 * transcripts on one machine and re-running the module over them. They are regression tests for
 * numbers that were wrong in a specific, quotable direction: a model switch that never happened,
 * a prefix reported as zero, and a three-line changelog priced at 3.75x the entire prefix.
 *
 * The direction matters. Every one of these overstated waste or understated the prefix, and
 * audit.mjs sums the result into a dollar figure a user is expected to act on.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { cacheHealth, modelSwitchCost, readCacheUsage, attributeInvalidation } from '../../hooks-core/cache.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cachefix-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ } });

/** A transcript row in the shape the client actually writes. */
const row = (model, read, written) => JSON.stringify({
  timestamp: new Date(1700000000000).toISOString(),
  message: {
    model,
    usage: {
      cache_read_input_tokens: read,
      cache_creation_input_tokens: written,
      input_tokens: 0,
      output_tokens: 0,
    },
  },
});

/** The placeholder the client appends verbatim: a real usage object, all zeros. */
const synthetic = () => row('<synthetic>', 0, 0);

function transcript(...rows) {
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, rows.join('\n') + '\n');
  return path;
}

describe("the client's <synthetic> placeholder is not a model", () => {
  test('a single-model session reports one model, not two', () => {
    // All four real transcripts on this machine contain these rows; three used exactly one
    // real model and would still have reported two, which cache-tool.ts renders as
    // "2 models used in this session" with an invented re-write cost beside it.
    const turns = readCacheUsage(transcript(row('claude-opus-5', 1000, 500), synthetic()));
    expect(Object.keys(cacheHealth(turns).models)).toEqual(['claude-opus-5']);
  });

  test('modelSwitchCost does not claim a switch that never happened', () => {
    const turns = readCacheUsage(transcript(row('claude-opus-5', 1000, 500), synthetic()));
    expect(modelSwitchCost(turns)?.alreadySwitched).toBe(false);
  });

  test('a genuine two-model session is still reported', () => {
    // The fix must not suppress the real case it exists to distinguish from.
    const turns = readCacheUsage(transcript(row('claude-opus-5', 1000, 500), row('claude-haiku-4-5', 800, 200)));
    expect(Object.keys(cacheHealth(turns).models)).toHaveLength(2);
    expect(modelSwitchCost(turns).alreadySwitched).toBe(true);
  });
});

describe('prefixTokens comes from a turn that carried a prefix', () => {
  test('a session ending on a zero-usage row keeps the real prefix', () => {
    // Reading turns[length - 1] literally reported 0 for a session whose prefix was 600,000+
    // tokens, which zeroed every attribution price downstream.
    const turns = readCacheUsage(transcript(row('claude-opus-5', 600_000, 13_625), synthetic()));
    expect(cacheHealth(turns).prefixTokens).toBe(613_625);
  });

  test('modelSwitchCost is not null for such a session, so its caller cannot crash', () => {
    // cache-tool.ts guards this dereference with models.length > 1, a DIFFERENT condition from
    // the !prefixTokens that returned null -- so the pair produced a live
    // "Cannot read properties of null (reading 'rewriteCost')" and took down cache_audit.
    const turns = readCacheUsage(transcript(
      row('claude-opus-5', 600_000, 13_625), row('claude-haiku-4-5', 400, 100), synthetic(),
    ));
    const cost = modelSwitchCost(turns);
    expect(cost).not.toBeNull();
    expect(cost.rewriteCost).toBeGreaterThan(0);
  });

  test('an all-empty transcript still reports zero rather than throwing', () => {
    const turns = readCacheUsage(transcript(synthetic(), synthetic()));
    expect(cacheHealth(turns).prefixTokens).toBe(0);
  });
});

describe('invalidation is priced per line, and billed once', () => {
  const withFile = (contents) => {
    const project = mkdtempSync(join(tmpdir(), 'cacheproj-'));
    writeFileSync(join(project, 'CLAUDE.md'), contents);
    return project;
  };

  test('three volatile lines in one file never bill more than the prefix', () => {
    // MEASURED before the fix: a three-line changelog priced at 2,301,093 tokens/session
    // against a 613,625-token prefix -- 3.75x the whole prefix -- because every hit was
    // charged the full downstream and audit.mjs sums them.
    const project = withFile('Generated 2025-10-31T09:00\nGenerated 2025-11-01T09:00\nGenerated 2025-12-01T09:00\n');
    try {
      const hits = attributeInvalidation(project, 613_625);
      const total = hits.reduce((sum, h) => sum + (h.costPerSession || 0), 0);
      expect(hits.length).toBeGreaterThan(1);
      expect(total).toBeLessThanOrEqual(Math.round(613_625 * 1.25));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('a later hit in the same file is reported but costs zero, naming what subsumes it', () => {
    // A prefix cache invalidates once, at the earliest difference: fixing the second line
    // while the first still changes saves nothing.
    const project = withFile('Generated 2025-10-31T09:00\nGenerated 2025-11-01T09:00\n');
    try {
      const hits = attributeInvalidation(project, 100_000);
      expect(hits[0].costPerSession).toBeGreaterThan(0);
      expect(hits[1].costPerSession).toBe(0);
      expect(hits[1].subsumedBy).toMatch(/CLAUDE\.md:1/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('a bare changelog date is reported without a fabricated price', () => {
    // "- 2025-10-31: reworked the loader" is byte-identical every session. Pricing it invents
    // a per-session cost and tells the user to delete their changelog.
    const project = withFile('- 2025-10-31: reworked the loader\n- 2024-06-11: initial release\n');
    try {
      const hits = attributeInvalidation(project, 100_000);
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) expect(hit.costPerSession).toBeNull();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('a real timestamp is still priced', () => {
    // The unpriced rule must not disarm the detector it belongs to.
    const project = withFile('Generated 2025-10-31T09:00 by the build\n');
    try {
      expect(attributeInvalidation(project, 100_000)[0].costPerSession).toBeGreaterThan(0);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('the transcript tail is read off disk', () => {
  test('multibyte content near the cut does not lose turns', () => {
    // The old path sliced a BYTE offset out of a UTF-16 string: on a real 147 MB transcript
    // bytes-minus-chars was 140,264, so 3.5% of the requested window was silently discarded.
    const padding = Array.from({ length: 200 }, () => row('claude-opus-5', 1, 1)).join('\n');
    const path = join(dir, 'wide.jsonl');
    writeFileSync(path, `${'é'.repeat(5000)}\n${padding}\n${row('claude-opus-5', 42, 7)}\n`);
    const turns = readCacheUsage(path, { maxBytes: 4096 });
    expect(turns.length).toBeGreaterThan(0);
    const last = turns[turns.length - 1];
    expect(last.read).toBe(42);
    expect(last.written).toBe(7);
  });

  test('a small file is still read whole', () => {
    const turns = readCacheUsage(transcript(row('claude-opus-5', 5, 6)), { maxBytes: 4_000_000 });
    expect(turns).toHaveLength(1);
  });
});

describe('an unpriced hit does not subsume a priced one', () => {
  const withFile = (contents) => {
    const project = mkdtempSync(join(tmpdir(), 'cachemix-'));
    writeFileSync(join(project, 'CLAUDE.md'), contents);
    return project;
  };

  test('a bare date above a real timestamp does not zero the timestamp price', () => {
    // Caught in review of the fix itself. subsumedBy was derived from found[0] rather than the
    // earliest PRICED hit, so an unpriced changelog date at the top of the file zeroed the
    // price of a genuine timestamp below it -- converting a real, fixable cost into a
    // reported zero, which is the same class of error the unpriced rule exists to avoid.
    const project = withFile('- 2024-06-11: initial release\nGenerated 2025-10-31T09:00 by the build\n');
    try {
      const hits = attributeInvalidation(project, 100_000);
      const date = hits.find((h) => h.line === 1);
      const stamp = hits.find((h) => h.line === 2);
      expect(date.costPerSession).toBeNull();
      expect(date.subsumedBy).toBeNull();
      expect(stamp.costPerSession).toBeGreaterThan(0);
      expect(stamp.subsumedBy).toBeNull();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('a second priced hit is still subsumed by the first priced one', () => {
    const project = withFile('- 2024-06-11: initial release\nGenerated 2025-10-31T09:00\nGenerated 2025-11-01T09:00\n');
    try {
      const hits = attributeInvalidation(project, 100_000);
      expect(hits.find((h) => h.line === 2).costPerSession).toBeGreaterThan(0);
      const third = hits.find((h) => h.line === 3);
      expect(third.costPerSession).toBe(0);
      expect(third.subsumedBy).toMatch(/CLAUDE\.md:2/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
