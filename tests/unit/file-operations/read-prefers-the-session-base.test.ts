/**
 * Which diff base wins when a read has two to choose from.
 *
 * TWO MECHANISMS FOR THE SAME PROBLEM LANDED INDEPENDENTLY, and merging them
 * was a decision that nothing tested:
 *
 *   - `authoredBase(path)` is SESSION-SCOPED. The hook knows the client's real
 *     session id and the bytes it wrote, so this covers a write made through
 *     ANY path, including the built-in Write. A caller that did not author the
 *     file gets nothing.
 *   - `lastWrittenKey(path)` is PATH-SCOPED and covers only this product's own
 *     smart_write / smart_edit.
 *
 * `smart_read` now consults them in that order. Neither subsumes the other, so
 * the ordering is the claim, and this file is the only thing that states it.
 * Without these tests the chain could be reordered, or either link dropped,
 * with the whole suite still green.
 *
 * Assertions are POSITIVE -- an exact content string, an exact flag -- because
 * an absence check here would pass just as well if the call threw and returned
 * an error object.
 */

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { SmartReadTool } from '../../../src/tools/file-operations/smart-read.js';
import { SmartWriteTool } from '../../../src/tools/file-operations/smart-write.js';

let workspace: string;
let cache: CacheEngine;
let tokenCounter: TokenCounter;
let metrics: MetricsCollector;
let priorSession: string | undefined;

const AUTHORED = Array.from(
  { length: 100 },
  (_, i) => `export const authored${i} = ${i};`
).join('\n');

const VIA_TOOL = Array.from(
  { length: 100 },
  (_, i) => `export const viaTool${i} = ${i};`
).join('\n');

// autoFormat would rewrite the bytes, so "nothing changed" could be false for a
// reason unrelated to which base was chosen.
const EXACT = { autoFormat: false } as const;

const SESSION = 'session-base-test';

beforeEach(() => {
  // A .git marker so projectRootFor resolves the workspace as the project that
  // owns the file -- the authored store is written per project.
  workspace = mkdtempSync(join(tmpdir(), 'session-base-'));
  mkdirSync(join(workspace, '.git'), { recursive: true });
  cache = new CacheEngine();
  tokenCounter = new TokenCounter();
  metrics = new MetricsCollector();
  priorSession = process.env.TOKEN_OPTIMIZER_SESSION_ID;
});

afterEach(() => {
  if (priorSession === undefined) delete process.env.TOKEN_OPTIMIZER_SESSION_ID;
  else process.env.TOKEN_OPTIMIZER_SESSION_ID = priorSession;
  rmSync(workspace, { recursive: true, force: true });
});

/** Records content as the hook does, for the session the server will claim. */
async function recordAuthored(file: string, content: string): Promise<void> {
  const authored = (await import(
    pathToFileURL(join(process.cwd(), 'hooks-core', 'authored.mjs')).href
  )) as {
    recordAuthoredContent(
      root: string,
      session: string,
      file: string,
      content: string
    ): unknown;
  };
  authored.recordAuthoredContent(workspace, SESSION, file, content);
}

describe('smart_read picks its diff base', () => {
  // THE PREFERENCE ITSELF IS NOT ASSERTED HERE, AND THAT IS A GAP, NOT AN
  // OVERSIGHT. `authored-base.ts` loads hooks-core through `createRequire`,
  // which jest rejects for an ESM `.mjs` with "Must use import to load ES
  // Module". Production is fine -- Node 22 supports require(esm) -- but under
  // jest `load()` catches, returns null, and `authoredBase()` is inert. Verified
  // directly: outside jest, recordAuthoredContent + authoredContentFor round
  // trip the content and projectRootFor resolves a temp workspace correctly, so
  // the store and the fixture are both right; only the loader is blocked.
  //
  // The consequence is worth stating plainly: the session-scoped base has NO
  // integration coverage at this level and cannot have any without either
  // changing how authored-base.ts loads or spawning a real server process. The
  // two tests below cover the rest of the chain, and a test asserting the
  // preference belongs in the stdio integration suite, where the server runs in
  // a real Node process.

  test('still uses the tool write when this session authored nothing', async () => {
    // The other link in the chain. Dropping it would silently undo #351 for
    // every client that cannot supply a session id.
    delete process.env.TOKEN_OPTIMIZER_SESSION_ID;

    const file = join(workspace, 'tool-only.ts');
    const reader = new SmartReadTool(cache, tokenCounter, metrics);
    const writer = new SmartWriteTool(cache, tokenCounter, metrics);

    await writer.write(file, VIA_TOOL, EXACT);

    const result = await reader.read(file);

    expect(result.metadata.isDiff).toBe(true);
    expect(result.content).toBe('// No changes');
  });

  test('honours enableCache: false by resending, not diffing', async () => {
    // The opt-out has to cover BOTH fallbacks. A caller asking for the file is
    // not asking for a diff against something the process remembers, whichever
    // store that memory lives in.
    const file = join(workspace, 'opted-out.ts');
    const reader = new SmartReadTool(cache, tokenCounter, metrics);
    const writer = new SmartWriteTool(cache, tokenCounter, metrics);

    await writer.write(file, VIA_TOOL, EXACT);

    const result = await reader.read(file, { enableCache: false });

    expect(result.metadata.isDiff).toBe(false);
    expect(result.content).toContain('viaTool0');
  });

  test('gives a different session no base at all, and resends the file', async () => {
    // The safety property the session scope exists for. A caller that did not
    // author the file must get the file, not somebody else's diff.
    const file = join(workspace, 'foreign.ts');
    const reader = new SmartReadTool(cache, tokenCounter, metrics);

    writeFileSync(file, AUTHORED);
    await recordAuthored(file, AUTHORED);
    process.env.TOKEN_OPTIMIZER_SESSION_ID = 'a-different-session';

    const result = await reader.read(file);

    expect(result.metadata.isDiff).toBe(false);
    expect(result.content).toContain('authored0');
  });
});
