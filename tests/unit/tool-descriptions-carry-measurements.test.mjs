/**
 * A MEASURED DESCRIPTION MUST KEEP MATCHING THE MEASUREMENT.
 *
 * The percentages in these tool descriptions were asserted, not measured, for
 * the whole life of the project -- 51 of them, and nothing in the repository
 * could have told you whether any was true. bench/tools now measures fourteen,
 * and the descriptions state what it found. This is what stops them drifting
 * apart again: every figure in a measured tool's description has to be the one
 * in bench/tools/results/per-tool-reduction.json, and a re-record that moves a
 * figure fails here until the description is updated with it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const RECORD = join(
  ROOT,
  'bench',
  'tools',
  'results',
  'per-tool-reduction.json'
);

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });

const SOURCES = walk(join(ROOT, 'src', 'tools')).map((path) => ({
  path,
  text: readFileSync(path, 'utf8'),
}));

/**
 * The description literal sits a line or two after the name in every tool
 * definition, so the window after the name is where a figure has to appear.
 * Deliberately bounded: a figure found anywhere in a 3000-line file would
 * prove nothing about the tool whose name we looked up.
 */
function descriptionOf(tool) {
  for (const source of SOURCES) {
    const at = source.text.indexOf(`name: '${tool}',`);
    if (at < 0) continue;
    const window = source.text.slice(at, at + 1200);
    const match = window.match(/description:\s*\n?\s*'((?:[^'\\]|\\.)*)'/);
    if (match) return match[1];
  }
  return null;
}

const record = JSON.parse(readFileSync(RECORD, 'utf8'));
const measured = Object.entries(record.claims);
const measuredNames = new Set(Object.keys(record.claims));
const DEFINITION =
  /(name:\s*'([a-z0-9_]+)',\s*\n\s*description:\s*\n?\s*')((?:[^'\\]|\\.)*)'/g;

describe('tool descriptions carry the measured figure', () => {
  it('has something to check', () => {
    expect(measured.length).toBeGreaterThanOrEqual(14);
  });

  it.each(measured)('%s states both measured ranges', (tool, claim) => {
    const description = descriptionOf(tool);
    expect(description).not.toBeNull();
    // Positional, not merely present. Several tools measure the same range
    // cold and warm, so a bare containment check passed when the two figures
    // were swapped or one was wrong -- it matched the other one. The label
    // that follows each figure is what ties it to the column it came from.
    expect(description).toContain(`${claim.first.text} first read`);
    expect(description).toContain(`${claim.repeated.text} repeated`);
  });

  // The fixture count drifted without anyone noticing: five descriptions still
  // said "1 fixture" after a second one was added and every figure beside it
  // had moved. A reader uses that number to weigh the range, so it is part of
  // the claim, not decoration.
  it.each(measured)(
    '%s states how many fixtures it was measured over',
    (tool, claim) => {
      const description = descriptionOf(tool);
      expect(description).not.toBeNull();
      const noun = claim.fixtures === 1 ? 'fixture' : 'fixtures';
      expect(description).toContain(`(bench/tools, ${claim.fixtures} ${noun})`);
    }
  );

  it.each(measured)('%s no longer advertises an unmeasured figure', (tool) => {
    const description = descriptionOf(tool);
    // Positive first, and deliberately so: every other assertion here is a
    // negative one, which a description of null satisfies as happily as a
    // correct one. The absence is only evidence once the phrase that replaced
    // the old copy is shown to be present -- a tool whose definition this scan
    // stopped finding now fails here, instead of passing for having no figure
    // left to object to.
    expect(description).toContain(
      'Measured token reduction vs reading the file'
    );
    // The old copy read "83% token reduction", "75-85% token reduction",
    // "86%+ token reduction". None of those phrasings survives a measurement.
    expect(description).not.toMatch(/%\+?\s*token reduction/);
  });

  // A NEW PERCENTAGE MUST DECLARE WHAT IT IS.
  //
  // Fifty-two descriptions carried a figure and fourteen are measured. The
  // other thirty-eight are design targets, which is a fine thing for a
  // description to state and not a fine thing for it to imply. This is what
  // stops a thirty-ninth arriving with a bare number: either the recording
  // backs the figure, or the description says out loud that nothing does.
  it('every percentage is either measured or declared unmeasured', () => {
    const undeclared = [];
    for (const source of SOURCES) {
      for (const match of source.text.matchAll(DEFINITION)) {
        const [, , tool, description] = match;
        if (!/\d+%/.test(description)) continue;
        if (measuredNames.has(tool)) continue;
        if (description.includes('unmeasured design target')) continue;
        undeclared.push(tool);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('the scan sees the descriptions it is meant to police', () => {
    // A scan that matched nothing would pass the case above without reading
    // anything at all, which is the failure mode that matters here.
    let withFigures = 0;
    for (const source of SOURCES) {
      for (const match of source.text.matchAll(DEFINITION)) {
        if (/\d+%/.test(match[3])) withFigures += 1;
      }
    }
    expect(withFigures).toBeGreaterThanOrEqual(52);
  });

  // THE ARMS THAT MUST FAIL. A lookup that answered for anything would pass
  // every case above without reading a single description, and a containment
  // check that matched loosely would pass a description holding some other
  // tool's number. Both are ruled out here.
  it('finds nothing for a tool that does not exist', () => {
    expect(descriptionOf('smart_not_a_real_tool')).toBeNull();
  });

  it('rejects a figure the recording does not contain', () => {
    const description = descriptionOf('smart_read');
    expect(description).not.toBeNull();
    expect(description).not.toContain('80% token reduction');
    expect(description).not.toContain('42-95%');
  });
});
