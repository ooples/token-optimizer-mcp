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
  asResolvedInputFiles,
  DECLARED_BASELINE_KEY,
  DECLARED_TEXT_KEY,
  declaringText,
  displaced,
  liftDeclarations,
  RESOLVED_INPUT_KEY,
  resolvedFiles,
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

/** A reply naming the files it resolved, the way the dispatch delivers them. */
function resolvingReply(text: string, resolved: unknown) {
  return {
    content: [{ type: 'text', text }],
    _meta: { tokenOptimizer: { resolvedInputFiles: resolved } },
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
    const lifted = liftDeclarations({
      name: 'app',
      [DECLARED_BASELINE_KEY]: displaced(4937, 'resolved-project-file'),
    });
    expect(lifted.payload).toEqual({ name: 'app' });
    expect(lifted.declaration?.baselineTokens).toBe(4937);
    // THE POSITIVE CONTROL: the same object with no reserved key comes back
    // untouched, so the test above is not passing by stripping everything.
    expect(liftDeclarations({ name: 'app' })).toEqual({
      payload: { name: 'app' },
      declaration: null,
      resolved: null,
    });
  });

  it('refuses a forged source rather than storing it', () => {
    const lifted = liftDeclarations({
      [DECLARED_BASELINE_KEY]: {
        baselineTokens: 999999,
        baselineSource: 'trust-me',
      },
    });
    expect(lifted.declaration).toBeNull();
  });

  it('leaves a string reply alone', () => {
    // Half this fleet returns a report string, which has nowhere to put a key.
    expect(liftDeclarations('# Report')).toEqual({
      payload: '# Report',
      declaration: null,
      resolved: null,
    });
  });

  it('gives back the same text a declaring report put in', () => {
    /*
     * THE WHOLE POINT OF THE ENVELOPE. A tool like smart_package_json resolves
     * its own input file and returns a human report, so it has a before worth
     * declaring and a string to declare it next to. The envelope is how those
     * travel together -- and the caller has to end up with the string itself,
     * byte for byte, not an object wrapping it, or the report turns into JSON.
     */
    const carried = declaringText(
      '# Report\n  Outdated: 3\n',
      displaced(4937, 'resolved-project-file')
    );
    expect(typeof carried).toBe('object');
    const lifted = liftDeclarations(carried);
    expect(lifted.payload).toBe('# Report\n  Outdated: 3\n');
    expect(lifted.declaration?.baselineTokens).toBe(4937);
    expect(lifted.declaration?.baselineSource).toBe('resolved-project-file');
  });

  it('does not wrap a report that has nothing to declare', () => {
    // THE CONTROL ARM. A tool whose before the recorder can measure from the
    // arguments declares nothing, and must stay exactly as cheap as before:
    // the same string, no envelope, no allocation.
    expect(declaringText('# Report', null)).toBe('# Report');
    expect(declaringText('# Report', displaced(0, 'named-input-files'))).toBe(
      '# Report'
    );
  });

  it('keeps an envelope that carries more than the text', () => {
    /*
     * THE NEGATIVE CONTROL for the unwrap. Only a one-key envelope is a
     * carrier; anything else is a real payload that happens to have the key on
     * it, and silently returning just its text would discard the rest.
     */
    const lifted = liftDeclarations({
      [DECLARED_TEXT_KEY]: '# Report',
      name: 'app',
      [DECLARED_BASELINE_KEY]: displaced(10, 'resolved-project-file'),
    });
    expect(lifted.payload).toEqual({
      [DECLARED_TEXT_KEY]: '# Report',
      name: 'app',
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

/*
 * THE STRONGER OF THE TWO DECLARATIONS, AND WHY IT IS STRONGER.
 *
 * A counted declaration asks to be believed. A tool that can name the files it
 * read asks for nothing: the recorder reads them with the reader and counts
 * them with the counter it already uses on the reply, so the row comes out
 * measured on both sides. It needs no precedence rule either -- the caller's
 * named paths and the tool's resolved ones are one set of files, measured once.
 */
describe('a tool that names the files instead of counting them', () => {
  /** A file big enough that reading it genuinely costs more than the reply. */
  function bigFile(name: string): string {
    const path = join(dir, name);
    writeFileSync(
      path,
      Array.from(
        { length: 120 },
        (_, i) => `export const ${name.replace(/\W/g, '')}${i} = ${i};`
      ).join('\n'),
      'utf8'
    );
    return path;
  }

  it('produces a measured row, not a declared one', async () => {
    const resolved = bigFile('resolved.ts');

    await recordToolAnalytics(
      manager(),
      'smart_package_json',
      resolvingReply(REPLY, resolvedFiles([resolved], 'resolved-project-file')),
      {},
      null,
      // A directory, so the arguments name nothing the recorder can read. This
      // is exactly the call that used to need a counted declaration.
      { projectRoot: dir }
    );

    const entry = tracked[0];
    expect(classifySavings(entry)).toBe('verified-input-displacement');
    expect(verifiedInputDisplacement(entry)).toBe(entry.tokensSaved);
    // THE PART A COUNTED DECLARATION CANNOT HAVE. Bytes and a file count come
    // out of a real read, so the row can be re-derived later; a declared row
    // stores null for the bytes because there was never anything to measure.
    expect(entry.metadata?.baselineBytes).toBeGreaterThan(0);
    expect(entry.metadata?.displacedInputFiles).toBe(1);
    expect(entry.metadata?.resolvedInputSource).toBe('resolved-project-file');
    // And nothing was taken on trust: the declared-count fields stay empty.
    expect(entry.metadata?.declaredBaselineTokens).toBeNull();
    expect(declaredInputDisplacement(entry)).toBe(0);
  });

  it('widens a baseline the arguments only partly name', async () => {
    /*
     * THE CASE THE COUNTED DECLARATION COULD NOT REACH AT ALL. smart_tsconfig
     * is handed one config and reads the whole `extends` chain, so the
     * arguments name a real file and `displaced !== null` -- which is where a
     * counted declaration is dropped, correctly, since a tool's number must
     * not overrule a measurement. Naming the other files is not a competing
     * before; it is the same measurement over more of the input.
     */
    const leaf = bigFile('tsconfig.json');
    const base = bigFile('tsconfig.base.json');

    await recordToolAnalytics(
      manager(),
      'smart_tsconfig',
      resolvingReply(
        REPLY,
        resolvedFiles([base, leaf], 'resolved-config-chain')
      ),
      {},
      null,
      { configPath: leaf }
    );

    const widened = tracked[0];
    expect(classifySavings(widened)).toBe('verified-input-displacement');
    expect(widened.metadata?.displacedInputFiles).toBe(2);
    expect(widened.metadata?.resolvedInputSource).toBe('resolved-config-chain');

    // THE CONTROL ARM: the identical call with nothing declared measures the
    // leaf alone, so the widening is the declaration's doing and not the
    // fixture's.
    tracked = [];
    await recordToolAnalytics(
      manager(),
      'smart_tsconfig',
      resolvingReply(REPLY, null),
      {},
      null,
      { configPath: leaf }
    );
    const leafOnly = tracked[0];
    expect(leafOnly.metadata?.displacedInputFiles).toBe(1);
    expect(leafOnly.metadata?.resolvedInputSource).toBeNull();
    expect(widened.originalTokens).toBeGreaterThan(leafOnly.originalTokens);
  });

  it('drops a widening too large to fit, keeping the measurement it had', async () => {
    /*
     * A DECLARATION MUST NEVER COST THE CALLER A MEASUREMENT IT ALREADY HAD.
     *
     * The union of named and resolved paths is capped, because reading
     * hundreds of files on every call would make the accounting cost more
     * than the work. The first version of this returned null over the cap --
     * so smart_dependencies, whose resolved set is a transitively-walked
     * import graph, would have turned a perfectly measurable one-file call
     * into an unmeasured row by declaring too much.
     *
     * Over the cap the named files are measured on their own instead. The row
     * then understates by whatever the tool resolved, which is the safe
     * direction, and `resolvedInputSource` is left off it so the label can
     * never name a resolution the figure does not include.
     */
    const named = bigFile('entry.ts');
    const graph = Array.from({ length: 24 }, (_, i) => bigFile(`g${i}.ts`));

    await recordToolAnalytics(
      manager(),
      'smart_dependencies',
      resolvingReply(REPLY, resolvedFiles(graph, 'resolved-import-graph')),
      {},
      null,
      { files: [named] }
    );

    const overCap = tracked[0];
    // Measured, not abandoned -- and measured from the one file the arguments
    // named, with the declaration dropped whole.
    expect(classifySavings(overCap)).toBe('verified-input-displacement');
    expect(overCap.metadata?.displacedInputFiles).toBe(1);
    expect(overCap.metadata?.resolvedInputSource).toBeNull();

    // THE CONTROL ARM: one fewer resolved path fits, and then the widening
    // happens and is labelled -- so the drop above is the cap's doing and not
    // the declaration being ignored.
    tracked = [];
    await recordToolAnalytics(
      manager(),
      'smart_dependencies',
      resolvingReply(
        REPLY,
        resolvedFiles(graph.slice(0, 23), 'resolved-import-graph')
      ),
      {},
      null,
      { files: [named] }
    );
    const fits = tracked[0];
    expect(fits.metadata?.displacedInputFiles).toBe(24);
    expect(fits.metadata?.resolvedInputSource).toBe('resolved-import-graph');
    expect(fits.originalTokens).toBeGreaterThan(overCap.originalTokens);
  });

  it('counts a file named twice once', async () => {
    const leaf = bigFile('once.ts');

    await recordToolAnalytics(
      manager(),
      'smart_tsconfig',
      resolvingReply(REPLY, resolvedFiles([leaf], 'resolved-config-chain')),
      {},
      null,
      { configPath: leaf }
    );

    const entry = tracked[0];
    expect(entry.metadata?.displacedInputFiles).toBe(1);
  });
});

describe('what a resolved-path declaration is not allowed to be', () => {
  it('refuses a relative path rather than reading one somewhere else', () => {
    /*
     * The recorder resolves a relative path against ITS working directory,
     * which is not necessarily the tool's -- so a relative declaration either
     * measures nothing or, worse, measures whatever file happens to sit at
     * that name next to the recorder. A tool has already resolved these paths
     * in order to read them.
     */
    expect(resolvedFiles(['package.json'], 'resolved-project-file')).toBeNull();
    expect(
      resolvedFiles(['./a/b.json', '../c.json'], 'resolved-config-chain')
    ).toBeNull();
    // THE POSITIVE CONTROL: the same call with an absolute path is accepted.
    const absolute = join(dir, 'package.json');
    expect(resolvedFiles([absolute], 'resolved-project-file')?.paths).toEqual([
      absolute,
    ]);
  });

  it('refuses an empty list rather than declaring nothing', () => {
    // Same rule as a zero baseline: a declaration that claims nothing has to
    // read as absent, so it cannot be mistaken for a measured nothing.
    expect(resolvedFiles([], 'resolved-config-chain')).toBeNull();
  });

  it('refuses more files than the recorder would read', () => {
    const many = Array.from({ length: 25 }, (_, i) => join(dir, `f${i}.json`));
    expect(resolvedFiles(many, 'resolved-config-chain')).toBeNull();
    // THE CONTROL: one fewer is at the cap and is accepted.
    expect(
      resolvedFiles(many.slice(0, 24), 'resolved-config-chain')
    ).not.toBeNull();
  });

  it('refuses a forged source and a forged shape at the boundary', () => {
    // Re-checked where it arrives, not trusted because it came in on a
    // reserved key: the paths here are about to become file reads.
    expect(
      asResolvedInputFiles({
        paths: [join(dir, 'a.json')],
        baselineSource: 'trust-me',
      })
    ).toBeNull();
    expect(
      asResolvedInputFiles({ baselineSource: 'resolved-project-file' })
    ).toBeNull();
    expect(
      asResolvedInputFiles({
        paths: 'not-an-array',
        baselineSource: 'resolved-project-file',
      })
    ).toBeNull();
    // THE POSITIVE CONTROL: a well-formed one survives the same boundary.
    expect(
      asResolvedInputFiles({
        paths: [join(dir, 'a.json')],
        baselineSource: 'resolved-project-file',
      })?.paths
    ).toEqual([join(dir, 'a.json')]);
  });

  it('travels on its own key and comes off with the text intact', () => {
    const carried = declaringText(
      '# Report\n  Outdated: 3\n',
      resolvedFiles([join(dir, 'package.json')], 'resolved-project-file')
    );
    expect(typeof carried).toBe('object');
    expect(carried).toHaveProperty(RESOLVED_INPUT_KEY);
    // THE CONTROL: it did NOT land on the counted key, which a different
    // branch of the recorder reads.
    expect(carried).not.toHaveProperty(DECLARED_BASELINE_KEY);

    const lifted = liftDeclarations(carried);
    expect(lifted.payload).toBe('# Report\n  Outdated: 3\n');
    expect(lifted.declaration).toBeNull();
    expect(lifted.resolved?.baselineSource).toBe('resolved-project-file');
  });
});
