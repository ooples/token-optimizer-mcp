import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  acceptedOptionFields,
  interfaceFields,
  isUnsendable,
  nestedShape,
  shapeGaps,
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

      // Null means the schema does not declare the option at all, which is the
      // name-check's finding. A DECLARED option with no nested shape is not
      // skipped -- that was the hole, and it now reports every field.
      const gaps = shapeGaps(text, option, fields);
      if (!gaps) continue;

      checked++;
      const { missingProperties, missingRequired } = gaps;

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

  it('does not mistake a nested array property for an array-typed option', () => {
    // `condition` is an OBJECT whose fields include two arrays (`groupBy`,
    // `filters`). Deciding array-ness by searching the whole block for
    // `type: 'array'` matched those nested properties, so the parser reached
    // into `groupBy.items` -- `{ type: 'string' }`, which has no `properties` --
    // and reported the option as declaring no shape at all. Combined with the
    // stricter rule above, that would have condemned five CORRECT schemas and
    // invited "fixing" them. Array-ness must come from the option's own `type`.
    const text = readFileSync(
      join(SRC, 'dashboard-monitoring', 'alert-manager.ts'),
      'utf8'
    );
    const shape = nestedShape(text, 'condition');

    expect(shape?.isArray).toBe(false);
    expect(shape?.properties).toEqual(
      expect.arrayContaining([
        'metric',
        'aggregation',
        'percentile',
        'groupBy',
        'filters',
      ])
    );
  });

  it('reads through a block comment rather than treating it as source', () => {
    // `//` comments were skipped and `/* */` were not, so a block comment that
    // happens to contain `type: 'array'` or a `required:` list was read as
    // declaration. The scanners already learned this lesson once -- an
    // apostrophe in a `//` comment opened a string that swallowed eleven
    // properties -- and half-applying it leaves the same class of defect.
    const text = `
export interface Cfg {
  host: string;
  ports?: number[];
}
export interface ThingOptions {
  cfg: Cfg;
}
const X_TOOL_DEFINITION = {
  inputSchema: {
    properties: {
      cfg: {
        /* Historically this was type: 'array' with required: ['legacy'].
           It is an object now. */
        type: 'object',
        properties: {
          host: { type: 'string' },
          ports: { type: 'array', items: { type: 'number' } },
        },
        required: ['host'],
      },
    },
  },
};`;

    const shape = nestedShape(text, 'cfg');

    expect(shape?.isArray).toBe(false);
    expect(shape?.required).toEqual(['host']);
    expect(shapeGaps(text, 'cfg', interfaceFields(text, 'Cfg'))).toEqual({
      missingProperties: [],
      missingRequired: [],
    });
  });

  it('flags an object option that declares NO nested properties at all', () => {
    // THE HOLE THIS CLOSES. The audit used to `continue` whenever a property
    // declared no nested shape, on the reasoning that the sibling name-check
    // covered it. It does not: the name-check only confirms the NAME exists, so
    // `request: { type: 'object' }` satisfied both tests while declaring none of
    // its fields and none of its requirements. A schema that accepts anything is
    // not a contract, and this file's whole purpose is to notice that.
    const text = `
export interface Req {
  url: string;
  method?: string;
}
export interface ThingOptions {
  request: Req;
}
const X_TOOL_DEFINITION = {
  inputSchema: {
    properties: {
      request: { type: 'object', description: 'shapeless' },
    },
  },
};`;

    expect(shapeGaps(text, 'request', interfaceFields(text, 'Req'))).toEqual({
      missingProperties: ['url', 'method'],
      missingRequired: ['url'],
    });
  });

  it('stays silent about an option the schema never declares', () => {
    // That case belongs to the name-check, which reports it with the right
    // message. Reporting it here too would make one defect fail two tests and
    // read as two defects.
    const text = `
export interface Req {
  url: string;
}
export interface ThingOptions {
  request: Req;
}
const X_TOOL_DEFINITION = {
  inputSchema: {
    properties: {
      somethingElse: { type: 'string' },
    },
  },
};`;

    expect(shapeGaps(text, 'request', interfaceFields(text, 'Req'))).toBeNull();
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
