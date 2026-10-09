/**
 * PROSE ELISION MUST NOT TOUCH CONTENT WHOSE LINES ARE THE UNIT OF MEANING.
 *
 * Issue #469, third sub-problem. A session read source through the compression
 * path, got comment lines elided out of the middle of a region, and built
 * exact-text edits from what came back. Every anchor missed, because the lines
 * it was anchored to had been removed from the view and not from the file.
 *
 * A comment block clears the wordiness bar that `looksLikeProse` tests -- a
 * dense run of `//` lines is wordier than most paragraphs -- so the engine
 * claimed it and dropped half its sentences, each of which was a whole line.
 */

import { describe, expect, it } from '@jest/globals';
import { looksLikeProse } from '../../../src/compress/prose.js';

const PARAGRAPHS = [
  'The release waiter polls the registry until the published version resolves or the budget runs out.',
  'npm accepts a publish and then processes it asynchronously, which can take well over an hour.',
  'Raising the budget therefore cannot fix the failure, because no runner-held budget outlasts the queue.',
  'The waiter instead reports a pending publish separately from a broken one, and a scheduled job verifies the window.',
  // Wrapped across lines, as a paragraph in a document or a design note is.
].join('\n');

const COMMENT_BLOCK = `// THE BUNDLED INVENTORY IS ASSERTED ONLY FOR AN ACTUAL PLUGIN INSTALL.
//
// This used to run unconditionally, on the grounds that these entry points ship
// beside an MCP declaration for the same package. That holds for a plugin --
// .mcp.json travels with the hooks -- and not otherwise: the script path wires
// hooks through settings.json without the server, and a user can drop the
// server and keep the hooks, and the benchmark arm removes the mcp block.
process.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES_BUNDLED ??= 'smart_read';`;

describe('prose elision declines line-oriented content', () => {
  it('still claims ordinary prose', () => {
    // THE POSITIVE CONTROL. Without it this file would pass just as happily if
    // the engine had been switched off altogether, which is the regression the
    // guard below could easily have caused.
    expect(looksLikeProse(PARAGRAPHS)).toBe(true);
  });

  it('declines a comment block that reads like prose by word count', () => {
    const lines = COMMENT_BLOCK.split('\n').filter((l) => l.trim());
    const wordy = lines.filter((l) => l.split(/\s+/).length > 8).length;
    // Stated rather than assumed: this fixture really does clear the wordiness
    // bar, so it is the guard and not the bar that declines it.
    expect(wordy / lines.length).toBeGreaterThan(0.5);
    expect(looksLikeProse(COMMENT_BLOCK)).toBe(false);
  });

  it('declines a numbered listing, where a dropped line breaks every number after it', () => {
    const listing = Array.from(
      { length: 12 },
      (_, index) =>
        `${index + 1}|  the adapter records the outcome of this call against the episode it belongs to`
    ).join('\n');
    expect(looksLikeProse(listing)).toBe(false);
  });

  it('declines a bulleted list, where a dropped bullet is a dropped step', () => {
    const steps = [
      '- list the review threads with the paginated GraphQL query and count the unresolved ones',
      '- cancel any in-progress run on the pull request while a thread is still unresolved',
      '- fix each thread in code, then reply and resolve it with the evidence that it is fixed',
      '- push, and only then let the full run proceed to completion',
    ].join('\n');
    expect(looksLikeProse(steps)).toBe(false);
  });

  it('claims prose that merely contains a line or two of structure', () => {
    // THE BOUNDARY. The rule is a majority of lines, not the presence of any,
    // so a passage that quotes one command stays compressible.
    const mixed = [
      'The waiter reports a pending publish separately from a broken one, which is the whole distinction.',
      '- npm run verify:published-launch -- --version 7.4.2 --pending-ok',
      'A pending-tolerant waiter is only safe while something else still verifies the release afterwards.',
      'The scheduled job covers a twenty-four hour window and files an issue when the latest version lags.',
    ].join('\n');
    expect(looksLikeProse(mixed)).toBe(true);
  });
});
