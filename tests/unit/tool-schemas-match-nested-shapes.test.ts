import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  acceptedOptionFields,
  interfaceFields,
  isUnsendable,
  nestedShape,
} from './helpers/schema-source.js';

/**
 * A declared option must also declare the SHAPE it accepts.
 *
 * THIS CLOSES THE HOLE THAT LET BAD WORK THROUGH TWICE. The sibling test compares
 * option NAMES: every field of an Options interface must appear in inputSchema. That
 * check passed while four nested declarations were wrong, because the names were all
 * present and only the structure inside them was incomplete:
 *
 *   - alert_manager `dataSource` omitted `connection.tool`, `transform` and `cache`,
 *     and did not require `connection`. An mcp-tool source therefore could not be
 *     configured through the published contract at all.
 *   - log_dashboard `logSources` omitted `name`, `enabled` and `config.parser`, and
 *     required only id and type -- so it accepted source objects the tool itself
 *     rejects. A schema loose enough to produce invalid input.
 *
 * tsc cannot catch either: a JSON-Schema literal is just an object, so a missing
 * nested key is not a type error. Review caught them, which is not a system.
 *
 * What this asserts, for every option whose type is an interface declared in the same
 * file: every field of that interface appears in the schema's nested `properties`, and
 * every NON-OPTIONAL field appears in its `required`. Types from other modules are
 * skipped because they cannot be resolved from source text -- a real limit, stated
 * rather than hidden.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, 'src', 'tools');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
      out.push(full);
  }
  return out;
}

/** `Foo` and `Foo[]` and `Array<Foo>` all name the element interface `Foo`. */
function namedType(type: string): string | null {
  const cleaned = type.replace(/\s*\|\s*undefined/g, '').trim();
  const m =
    /^([A-Z]\w*)\[\]$/.exec(cleaned) ??
    /^Array<([A-Z]\w*)>$/.exec(cleaned) ??
    /^([A-Z]\w*)$/.exec(cleaned);
  return m ? m[1] : null;
}

interface Mismatch {
  file: string;
  option: string;
  shape: string;
  missingProperties: string[];
  missingRequired: string[];
}

function audit(): { mismatches: Mismatch[]; checked: number } {
  const mismatches: Mismatch[] = [];
  let checked = 0;

  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('_TOOL_DEFINITION')) continue;

    const relative = file
      .replace(ROOT, '')
      .replace(/\\/g, '/')
      .replace(/^\//, '');
    for (const { name: option, type } of acceptedOptionFields(text)) {
      const shapeName = namedType(type);
      if (!shapeName) continue;

      const fields = interfaceFields(text, shapeName);
      if (!fields.length) continue; // defined elsewhere; cannot resolve from source

      const declared = nestedShape(text, option);
      if (!declared) continue; // declares no nested shape at all; the name check covers it

      checked++;
      const sendable = fields.filter((f) => !isUnsendable(f.type));
      const missingProperties = sendable
        .filter((f) => !declared.properties.includes(f.name))
        .map((f) => f.name);
      const missingRequired = sendable
        .filter((f) => !f.optional && !declared.required.includes(f.name))
        .map((f) => f.name);

      if (missingProperties.length || missingRequired.length) {
        mismatches.push({
          file: relative,
          option,
          shape: shapeName,
          missingProperties,
          missingRequired,
        });
      }
    }
  }

  return { mismatches, checked };
}

describe('a declared option declares its shape too', () => {
  const { mismatches, checked } = audit();

  it('has no nested shape that omits a field of its interface', () => {
    const report = mismatches
      .map(
        (m) =>
          `${m.file} ${m.option} (${m.shape}): missing properties [${m.missingProperties.join(', ')}] missing required [${m.missingRequired.join(', ')}]`
      )
      .join('\n');

    expect(report).toBe('');
  });

  it('actually resolved some shapes, so it cannot pass by checking nothing', () => {
    // Every branch above bails out on something it cannot resolve. Without this, a
    // parser regression would empty the audit and turn the file green.
    expect(checked).toBeGreaterThan(0);
  });

  it('reaches through an array to the element shape', () => {
    // `logSources` is an array; its fields live under `items.properties`, which is
    // exactly where a name-only check cannot see and where two omissions hid.
    const text = readFileSync(
      join(SRC, 'dashboard-monitoring', 'log-dashboard.ts'),
      'utf8'
    );
    const shape = nestedShape(text, 'logSources');

    expect(shape?.isArray).toBe(true);
    expect(shape?.properties).toContain('config');
    expect(shape?.required).toContain('enabled');
  });

  it('reads a plain object shape and its required list', () => {
    const text = readFileSync(
      join(SRC, 'dashboard-monitoring', 'alert-manager.ts'),
      'utf8'
    );
    const shape = nestedShape(text, 'dataSource');

    expect(shape?.isArray).toBe(false);
    expect(shape?.properties).toEqual(
      expect.arrayContaining(['id', 'type', 'connection', 'transform', 'cache'])
    );
    expect(shape?.required).toContain('connection');
  });
});
