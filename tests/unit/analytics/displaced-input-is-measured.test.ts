/**
 * THE SAVING THE PRODUCT CLAIMS, MEASURED FOR THE FIRST TIME.
 *
 * Until this contract the stored analytics could only ever prove one thing:
 * that the disclosure layer trimmed a payload the tool had already built. The
 * headline claim -- that a tool answers in 300 tokens where reading the file
 * costs 4,937 -- had no measurement at all, because the only party that knew
 * the baseline was the tool, and across the fourteen benched tools every
 * self-reported figure was wrong: smart_dependencies declared a baseline of 0
 * and a saving of -11 tokens on a call that really avoided 63%, and
 * smart_package_json printed -92% where the wire said -20.9%.
 *
 * So the recorder reads the input itself. These tests hold it to that, and the
 * last three are the controls: a tool's own number must not be able to move
 * the result, and a call whose input cannot be read must record no saving
 * rather than a flattering zero baseline.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureDisplacedInput } from '../../../src/analytics/displaced-input.js';
import { recordToolAnalytics } from '../../../src/analytics/record-tool-analytics.js';
import {
  classifySavings,
  verifiedInputDisplacement,
  verifiedTransportDelta,
} from '../../../src/analytics/savings-classification.js';
import type { AnalyticsEntry } from '../../../src/analytics/analytics-types.js';

/** A file big enough that summarising it is a real saving. */
const FILE_TEXT = Array.from(
  { length: 200 },
  (_, i) => `export const setting${i} = { enabled: true, retries: ${i} };`
).join('\n');

let dir: string;
let file: string;
let tracked: AnalyticsEntry[];

/** The one method the recorder uses, and the entries it produced. */
function manager() {
  return {
    track: async (entry: AnalyticsEntry) => {
      tracked.push(entry);
    },
    getEntries: async () => [] as AnalyticsEntry[],
  } as never;
}

function reply(text: string) {
  return { content: [{ type: 'text', text }] };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'displaced-'));
  file = join(dir, 'settings.ts');
  writeFileSync(file, FILE_TEXT, 'utf8');
  tracked = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('what reading it yourself would have cost', () => {
  it('counts the file the arguments name', async () => {
    const measured = await measureDisplacedInput({ filePath: file });
    expect(measured).not.toBeNull();
    expect(measured?.files).toBe(1);
    expect(measured?.bytes).toBe(Buffer.byteLength(FILE_TEXT, 'utf8'));
    expect(measured?.tokens).toBeGreaterThan(500);
  });

  it('counts a file named twice exactly once', async () => {
    /*
     * Two arguments pointing at one file is a double baseline, and a doubled
     * baseline is a doubled saving -- the exact shape of over-claim this
     * module exists to replace.
     */
    const once = await measureDisplacedInput({ filePath: file });
    const twice = await measureDisplacedInput({
      filePath: file,
      path: file,
    });
    expect(twice?.tokens).toBe(once?.tokens);
    expect(twice?.files).toBe(1);
  });

  it('refuses rather than returning a zero baseline', async () => {
    // A MISSING BASELINE MUST READ AS MISSING. `originalTokenCount: 0` is what
    // produced a reported saving of -11 tokens for a tool saving 63%.
    expect(
      await measureDisplacedInput({ filePath: join(dir, 'absent.ts') })
    ).toBeNull();
    expect(await measureDisplacedInput({ filePath: dir })).toBeNull();
    expect(await measureDisplacedInput({ content: FILE_TEXT })).toBeNull();
    expect(await measureDisplacedInput(null)).toBeNull();
  });

  it('does not read an argument that merely looks like a path', async () => {
    // `pattern` and `query` are not on the list, however path-shaped a value.
    expect(await measureDisplacedInput({ pattern: file })).toBeNull();
    expect(await measureDisplacedInput({ query: file })).toBeNull();
  });
});

describe('the row the recorder stores', () => {
  it('credits the file read that did not happen', async () => {
    await recordToolAnalytics(
      manager(),
      'smart_read',
      reply(JSON.stringify({ summary: 'two hundred settings, all enabled' })),
      {},
      null,
      { filePath: file }
    );

    expect(tracked).toHaveLength(1);
    const entry = tracked[0];
    expect(classifySavings(entry)).toBe('verified-input-displacement');
    expect(entry.savingsMeasured).toBe(true);
    expect(entry.originalTokens).toBeGreaterThan(entry.optimizedTokens);
    expect(entry.tokensSaved).toBe(
      entry.originalTokens - entry.optimizedTokens
    );
    expect(verifiedInputDisplacement(entry)).toBe(entry.tokensSaved);
    expect(entry.metadata?.displacedInputFiles).toBe(1);
  });

  it('does not count it as transport the proxy avoided', async () => {
    /*
     * The two kinds of avoided tokens have one `after` and two different
     * `before`s, so they are not additive. Keeping them in separate accessors
     * is what stops a dashboard summing the same reply twice.
     */
    await recordToolAnalytics(
      manager(),
      'smart_read',
      reply(JSON.stringify({ summary: 'two hundred settings' })),
      {},
      null,
      { filePath: file }
    );
    expect(verifiedTransportDelta(tracked[0])).toBe(0);
  });
});

describe('the controls', () => {
  it('ignores the figure the tool states about itself', async () => {
    /*
     * Both calls return the same text and displace the same file, so both must
     * record the same saving -- including the one whose payload swears it saved
     * nothing and cost eleven tokens more than it displaced, which is the real
     * shape of what smart_dependencies reports today.
     */
    const honest = { summary: 'two hundred settings' };
    const liar = {
      summary: 'two hundred settings',
      metadata: { originalTokenCount: 0, tokenCount: 11, tokensSaved: -11 },
    };

    const args = { filePath: file };
    await recordToolAnalytics(
      manager(),
      'a',
      reply(JSON.stringify(honest)),
      {},
      null,
      args
    );
    const first = tracked[0];
    tracked = [];
    await recordToolAnalytics(
      manager(),
      'a',
      reply(JSON.stringify(liar)),
      {},
      null,
      args
    );
    const second = tracked[0];

    expect(second.originalTokens).toBe(first.originalTokens);
    expect(second.tokensSaved).toBeGreaterThan(0);
    expect(classifySavings(second)).toBe('verified-input-displacement');
    // And the tool's own claim is dropped rather than stored as the audit
    // trail of an unmeasured row, because this row is measured.
    expect(second.metadata?.reportedToolSavings).toBeNull();
  });

  it('records no saving when the reply costs more than the file', async () => {
    const tiny = join(dir, 'tiny.env');
    writeFileSync(tiny, 'PORT=3000\n', 'utf8');
    await recordToolAnalytics(
      manager(),
      'smart_env',
      reply(JSON.stringify({ parsed: { columns: ['key'], rows: [['PORT']] } })),
      {},
      null,
      { filePath: tiny }
    );
    const entry = tracked[0];
    expect(entry.tokensSaved).toBe(0);
    expect(classifySavings(entry)).toBe('observed-return-only');
  });

  it('records no saving when no file was named', async () => {
    await recordToolAnalytics(
      manager(),
      'cache_audit',
      reply(JSON.stringify({ entries: 4 })),
      {},
      null,
      null
    );
    expect(tracked[0].tokensSaved).toBe(0);
    expect(classifySavings(tracked[0])).toBe('observed-return-only');
  });
});
