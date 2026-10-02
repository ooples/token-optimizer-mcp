/**
 * THE HALF ONLY THE TOOL KNOWS, AND THE LIMITS PUT ON SAYING IT.
 *
 * `measureDisplacedInput` counts the files the caller's arguments name, which
 * reaches nearly every tool in the fleet. It cannot apply a tool's private
 * resolution rule -- the file a tool finds under a directory, the `extends`
 * chain only it walks -- so for those the before is declared by the tool while
 * the after stays measured at the wire.
 *
 * A declaration is the weakest row this store accepts, so every test below is
 * about what it is NOT allowed to do: carry arithmetic, overrule a measurement
 * that disagrees with it, reach a stored row without being re-checked, or merge
 * with rows where both halves were counted by the same counter.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordToolAnalytics } from '../../../src/analytics/record-tool-analytics.js';
import {
  classifySavings,
  declaredInputDisplacement,
  verifiedInputDisplacement,
} from '../../../src/analytics/savings-classification.js';
import {
  DECLARED_BASELINE_KEY,
  displaced,
  liftDeclaredBaseline,
} from '../../../src/tools/shared/savings.js';
import type { AnalyticsEntry } from '../../../src/analytics/analytics-types.js';

let dir: string;
let tracked: AnalyticsEntry[];

function manager() {
  return {
    track: async (entry: AnalyticsEntry) => {
      tracked.push(entry);
    },
    getEntries: async () => [] as AnalyticsEntry[],
  } as never;
}

/** A reply carrying a declaration the way the dispatch delivers one. */
function declaredReply(text: string, declaration: unknown) {
  return {
    content: [{ type: 'text', text }],
    _meta: { tokenOptimizer: { displacedBaseline: declaration } },
  };
}

const REPLY = JSON.stringify({ name: 'app', scripts: 4, deps: 31 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'declared-'));
  tracked = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('what a tool is allowed to declare', () => {
  it('refuses a baseline that was never measured', () => {
    // ZERO IS NOT A MEASUREMENT OF NOTHING. `originalTokenCount: 0` is what
    // published a saving of -11 tokens for a tool that avoided 63% of a file.
    expect(displaced(0, 'resolved-project-file')).toBeNull();
    expect(displaced(-5, 'resolved-project-file')).toBeNull();
    expect(displaced(Number.NaN, 'resolved-project-file')).toBeNull();
  });

  it('names a before and carries no ratio to be wrong about', () => {
    const declaration = displaced(4937, 'resolved-project-file');
    expect(declaration).toEqual({
      baselineTokens: 4937,
      baselineSource: 'resolved-project-file',
    });
    expect(Object.keys(declaration || {}).sort()).toEqual([
      'baselineSource',
      'baselineTokens',
    ]);
  });
});

describe('the declaration leaves the payload', () => {
  it('is taken off the result the caller is charged for', () => {
    const lifted = liftDeclaredBaseline({
      name: 'app',
      [DECLARED_BASELINE_KEY]: displaced(4937, 'resolved-project-file'),
    });
    expect(lifted.payload).toEqual({ name: 'app' });
    expect(lifted.declaration?.baselineTokens).toBe(4937);
    // THE POSITIVE CONTROL: the same object with no reserved key comes back
    // untouched, so the test above is not passing by stripping everything.
    expect(liftDeclaredBaseline({ name: 'app' })).toEqual({
      payload: { name: 'app' },
      declaration: null,
    });
  });

  it('refuses a forged source rather than storing it', () => {
    const lifted = liftDeclaredBaseline({
      [DECLARED_BASELINE_KEY]: {
        baselineTokens: 999999,
        baselineSource: 'trust-me',
      },
    });
    expect(lifted.declaration).toBeNull();
  });

  it('leaves a string reply alone', () => {
    // Half this fleet returns a report string, which has nowhere to put a key.
    expect(liftDeclaredBaseline('# Report')).toEqual({
      payload: '# Report',
      declaration: null,
    });
  });
});

describe('the row a declaration produces', () => {
  it('credits it under its own class, never the measured one', async () => {
    await recordToolAnalytics(
      manager(),
      'smart_package_json',
      declaredReply(REPLY, displaced(4937, 'resolved-project-file')),
      {},
      null,
      // A directory, which is why the recorder has nothing of its own: there
      // is no general rule that turns a directory into a file to count.
      { projectRoot: dir }
    );

    const entry = tracked[0];
    expect(entry.originalTokens).toBe(4937);
    expect(entry.tokensSaved).toBe(4937 - entry.optimizedTokens);
    expect(classifySavings(entry)).toBe('declared-input-displacement');
    expect(declaredInputDisplacement(entry)).toBe(entry.tokensSaved);
    // KEPT OUT OF THE MEASURED TOTAL. The two have different evidence behind
    // them, so a reader sees which one a figure came from.
    expect(verifiedInputDisplacement(entry)).toBe(0);
    expect(entry.metadata?.declaredBaselineSource).toBe(
      'resolved-project-file'
    );
    // No byte figure, because a tool declares tokens and nothing else.
    expect(entry.metadata?.baselineBytes).toBeNull();
  });

  it('is refused when the named input could be read instead', async () => {
    /*
     * THE CONTROL THAT MATTERS MOST. A tool that over-declares must not be
     * able to beat a measurement: here the arguments name a real file, so the
     * recorder counts it and the declaration -- far larger -- is dropped.
     */
    const file = join(dir, 'settings.ts');
    const text = Array.from(
      { length: 200 },
      (_, i) => `export const setting${i} = { retries: ${i} };`
    ).join('\n');
    writeFileSync(file, text, 'utf8');

    await recordToolAnalytics(
      manager(),
      'smart_read',
      declaredReply(REPLY, displaced(99999, 'named-input-files')),
      {},
      null,
      { filePath: file }
    );

    const entry = tracked[0];
    expect(classifySavings(entry)).toBe('verified-input-displacement');
    expect(entry.originalTokens).toBeLessThan(5000);
    expect(declaredInputDisplacement(entry)).toBe(0);
    expect(entry.metadata?.declaredBaselineTokens).toBeNull();
  });
});

describe('the declaration never overrules a measurement', () => {
  it('loses to the file it named, rather than replacing it', async () => {
    /*
     * The measurement disagreeing with the declaration is still the answer.
     * `!displacementMeasured` would be too weak a guard here: the file WAS
     * read, it simply did not come out ahead of the reply.
     */
    const tiny = join(dir, 'tiny.env');
    writeFileSync(tiny, 'PORT=3000\n', 'utf8');
    await recordToolAnalytics(
      manager(),
      'smart_env',
      declaredReply(REPLY, displaced(99999, 'named-input-files')),
      {},
      null,
      { filePath: tiny }
    );
    expect(tracked[0].tokensSaved).toBe(0);
    expect(classifySavings(tracked[0])).toBe('observed-return-only');
  });

  it('records no saving when the declaration is smaller than the reply', async () => {
    await recordToolAnalytics(
      manager(),
      'smart_package_json',
      declaredReply(REPLY, displaced(3, 'resolved-project-file')),
      {},
      null,
      { projectRoot: dir }
    );
    expect(tracked[0].tokensSaved).toBe(0);
    expect(classifySavings(tracked[0])).toBe('observed-return-only');
  });

  it('keeps the tool claim as an audit trail when nothing was credited', async () => {
    await recordToolAnalytics(
      manager(),
      'smart_package_json',
      declaredReply(
        // A before and an after of the tool's own, which is two of the three
        // the extractor needs to read a claim back out.
        JSON.stringify({
          name: 'app',
          originalTokenCount: 8100,
          optimizedTokens: 200,
        }),
        displaced(3, 'resolved-project-file')
      ),
      {},
      null,
      { projectRoot: dir }
    );
    expect(tracked[0].metadata?.reportedToolSavings).not.toBeNull();
  });
});
