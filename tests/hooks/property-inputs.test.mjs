/**
 * Generated inputs, because hand-picked ones come from the same assumptions
 * that produced the bug.
 *
 * Two defects in recent work were exactly this shape. A test passed
 * `'\bnpx\s+jest\b'` in single quotes, which JavaScript resolves to a BACKSPACE
 * followed by `npxs+jest` -- so the assertion went green against a pattern
 * nobody wrote. Another asserted a filename did not contain `..`, when the real
 * invariant was containment and `a.._..b` satisfies one while failing the other.
 * In both cases the author chose the input, and the input agreed with him.
 *
 * So these state INVARIANTS and let fast-check hunt for counterexamples: what
 * must be true for every input, including the ones nobody would think to write.
 * When it finds one it shrinks it to the smallest failing case and prints it,
 * which is the part that makes the failure actionable rather than mysterious.
 */
import { describe, it, expect } from '@jest/globals';
import fc from 'fast-check';
import { canonicalPath } from '../../hooks-core/paths.mjs';
import { canonicalKey, nodeId, contentHash, load, findingsFor } from '../../hooks-core/wiki.mjs';
import { extractSymbols, extractImports, symbolKey, languageOf } from '../../hooks-core/symbols.mjs';
import { normalizePayload, touchedFiles } from '../../hooks-core/decide.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Strings chosen to break parsers, mixed in with generated ones.
 *
 * Every entry is a real failure mode from this codebase or its neighbours, not
 * a generic fuzz list: control characters (the backspace that mangled a regex),
 * traversal, UNC and drive-relative paths, mixed separators, and the empty and
 * whitespace cases that so often take a different branch.
 */
const NASTY = [
  '',
  ' ',
  '\t\n',
  '..',
  '../..',
  '..\\..\\',
  './/.//..',
  'a\u0008b', // backspace, the character that silently mangled a trigger
  'a\u0000b', // NUL
  '\uFEFFleading-bom',
  'C:',
  'C:\\',
  'C:/',
  '\\\\server\\share\\file.ts',
  '//server/share/file.ts',
  '/',
  '//',
  'a'.repeat(2000),
  '\u{1F600}emoji.ts',
  'file with spaces.ts',
  "quote'and\"quote.ts",
  'semi;colon|pipe&amp.ts',
  '.hidden',
  'trailing/',
  'trailing\\',
];

// fast-check v4 folded the unicode generators into string({ unit }); the v3
// name fc.fullUnicodeString no longer exists.
const anyString = () =>
  fc.oneof(fc.string(), fc.constantFrom(...NASTY), fc.string({ unit: 'binary' }));

describe('canonicalPath', () => {
  it('never throws, whatever it is handed', () => {
    fc.assert(
      fc.property(anyString(), (s) => {
        canonicalPath(s);
      }),
      { numRuns: 500 }
    );
  });

  it('reaches its fixed point on every shape the generators found', () => {
    // FOUR COUNTEREXAMPLES, FOUND ONE AFTER ANOTHER. Each was fixed on its own
    // and the next run produced a new one, which is what moved the invariant
    // into the structure -- canonicalPath now iterates a single pass to a fixed
    // point instead of trying to make that pass idempotent by hand. These stay
    // pinned because they document why the loop exists.
    const CASES = [
      // A segment ending in whitespace before a separator re-exposed the
      // whitespace the leading trim had already handled.
      "! /",
      "a /",
      // A one-character quote: startsWith and endsWith match the SAME character,
      // so slice(1, -1) turned it into the empty string.
      "\"",
      "\"/",
      // Collapsing produced something that LOOKED quoted, so the next pass
      // unquoted it.
      "'.'!'/",
      // The root directory collapsed to the empty string and could not return.
      "/",
      "/ \\",
      ". / ",
    ];
    for (const c of CASES) {
      const once = canonicalPath(c);
      expect(canonicalPath(once)).toBe(once);
    }

    // And the fixed point is the RIGHT value, not merely a stable one: an
    // idempotent function that maps the root to the empty string would satisfy
    // the property above and still be wrong.
    expect(canonicalPath('/')).toBe('/');
    expect(canonicalPath("\"")).toBe("\"");
    expect(canonicalPath('x /y')).toBe('x /y');
    expect(canonicalPath('C:/ x')).toBe('C:/ x');
  });

  it('reaches its fixed point on a Git Bash path carrying a dot segment', () => {
    // THE COUNTEREXAMPLE THE GENERATED INPUTS FOUND, pinned so it cannot come
    // back. MSYS translation used to run BEFORE `.` and `..` were collapsed, so
    // `/./c/Users/me/x` was not MSYS-shaped on the way in: the first pass only
    // dropped the dot and returned `/c/Users/me/x`, which IS MSYS-shaped, so a
    // second pass returned `C:/Users/me/x`.
    //
    // The same file therefore held two identities depending on how many times
    // its path had been round-tripped -- two graph nodes, findings anchored
    // under one invisible from the other. That is exactly the fragmentation
    // canonicalPath exists to end, and it survived every hand-written example
    // because nobody thinks to write this path down.
    expect(canonicalPath('/./c/Users/me/x')).toBe('C:/Users/me/x');
    expect(canonicalPath(canonicalPath('/./c/Users/me/x'))).toBe('C:/Users/me/x');

    // The shape the property actually generated, which is the same defect.
    expect(canonicalPath(canonicalPath('/./A/!'))).toBe(canonicalPath('/./A/!'));

    // Ordinary spellings are unchanged by the reordering.
    expect(canonicalPath('/c/Users/me/x')).toBe('C:/Users/me/x');
    expect(canonicalPath('C:/Users/me/x')).toBe('C:/Users/me/x');
    expect(canonicalPath('/c/./x')).toBe('C:/x');
    expect(canonicalPath('//server/share/f')).toBe('//server/share/f');
  });

  it('is idempotent -- canonicalising twice equals canonicalising once', () => {
    // The property that matters for identity: if it were not idempotent, the
    // same file could occupy two nodes depending on how many times a path had
    // been round-tripped.
    fc.assert(
      fc.property(anyString(), (s) => {
        const once = canonicalPath(s);
        expect(canonicalPath(once)).toBe(once);
      }),
      { numRuns: 500 }
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(anyString(), (s) => {
        expect(canonicalPath(s)).toBe(canonicalPath(s));
      }),
      { numRuns: 300 }
    );
  });
});

describe('node identity', () => {
  it('canonicalKey is idempotent for file keys, so one file is never two nodes', () => {
    fc.assert(
      fc.property(anyString(), (s) => {
        const once = canonicalKey('file', s);
        expect(canonicalKey('file', once)).toBe(once);
      }),
      { numRuns: 400 }
    );
  });

  it('nodeId is stable and shaped, whatever the key', () => {
    fc.assert(
      fc.property(fc.constantFrom('file', 'symbol', 'task', 'finding'), anyString(), (kind, key) => {
        const id = nodeId(kind, key);
        expect(id).toBe(nodeId(kind, key));
        // `kind:16hex` -- anything else means a key escaped into the id.
        expect(id).toMatch(/^(file|symbol|task|finding):[0-9a-f]{16}$/);
      }),
      { numRuns: 400 }
    );
  });

  it('paths that differ only in spelling collapse to one id', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{1,8}$/), (name) => {
        const a = nodeId('file', `C:\\repo\\${name}.ts`);
        const b = nodeId('file', `C:/repo/${name}.ts`);
        expect(a).toBe(b);
      }),
      { numRuns: 100 }
    );
  });
});

describe('symbol extraction', () => {
  it('never throws on arbitrary text in any recognised language', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('a.ts', 'a.py', 'a.go', 'a.rs', 'a.cs', 'a.rb', 'a.php', 'a.sh', 'a.unknown'),
        fc.string({ maxLength: 4000 }),
        (path, text) => {
          extractSymbols(path, text);
          extractImports(path, text);
        }
      ),
      { numRuns: 400 }
    );
  });

  it('produces spans that are ordered and inside the file', () => {
    // A span that runs past the end, or backwards, would make staleness compare
    // the wrong region -- reporting a function stale because of an edit
    // somewhere else entirely.
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 40 }), { maxLength: 60 }), (lines) => {
        const text = lines.join('\n');
        const total = text.split('\n').length;
        for (const s of extractSymbols('a.ts', text)) {
          expect(s.line).toBeGreaterThanOrEqual(1);
          expect(s.endLine).toBeGreaterThanOrEqual(s.line);
          expect(s.endLine).toBeLessThanOrEqual(total);
        }
      }),
      { numRuns: 300 }
    );
  });

  it('never emits a symbol name containing a path separator', () => {
    // symbolKey joins path and name with '#', so a separator in the name would
    // make the key ambiguous with a path.
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (text) => {
        for (const s of extractSymbols('a.ts', text)) {
          expect(s.name).not.toMatch(/[\\/]/);
          expect(symbolKey('a.ts', s.name)).toContain('#');
        }
      }),
      { numRuns: 300 }
    );
  });

  it('only ever returns RELATIVE import specifiers', () => {
    // A bare specifier names a package, not a file in this project, so an edge
    // pointing at it would be a lie.
    fc.assert(
      fc.property(fc.string({ maxLength: 3000 }), (text) => {
        for (const spec of extractImports('a.ts', text)) {
          expect(spec).toMatch(/^\.\.?[\\/]/);
        }
      }),
      { numRuns: 300 }
    );
  });

  it('languageOf never throws and returns null or a known family', () => {
    fc.assert(
      fc.property(anyString(), (s) => {
        const fam = languageOf(s);
        expect(fam === null || typeof fam === 'string').toBe(true);
      }),
      { numRuns: 300 }
    );
  });
});

describe('hook payloads', () => {
  /** Arbitrary JSON-ish objects, because payloads come from another process. */
  const anyPayload = () =>
    fc.record(
      {
        tool_name: fc.oneof(fc.string(), fc.constantFrom('Read', 'Bash', 'Edit', 'Write')),
        session_id: anyString(),
        cwd: anyString(),
        tool_input: fc.oneof(
          fc.constant(undefined),
          fc.constant(null),
          fc.record(
            {
              file_path: anyString(),
              command: anyString(),
              path: anyString(),
            },
            { requiredKeys: [] }
          )
        ),
      },
      { requiredKeys: [] }
    );

  it('normalizePayload never throws on a malformed payload', () => {
    // The hook is fed by another process. A payload that crashes the router
    // costs the user their tool call.
    fc.assert(
      fc.property(anyPayload(), (p) => {
        normalizePayload(p);
      }),
      { numRuns: 500 }
    );
  });

  it('touchedFiles never throws and always returns an array of entries with paths', () => {
    fc.assert(
      fc.property(anyPayload(), (p) => {
        const out = touchedFiles(normalizePayload(p));
        expect(Array.isArray(out)).toBe(true);
        for (const t of out) expect(typeof t.path).toBe('string');
      }),
      { numRuns: 400 }
    );
  });
});

describe('the graph parser', () => {
  let dir;

  it('survives arbitrary bytes in the log rather than losing the whole graph', () => {
    // A partially written final line is the normal consequence of a process
    // being killed mid-append, so one bad line must never make the accumulated
    // graph unreadable.
    fc.assert(
      fc.property(fc.array(anyString(), { maxLength: 40 }), (lines) => {
        dir = mkdtempSync(join(tmpdir(), 'prop-graph-'));
        try {
          writeFileSync(join(dir, 'graph.jsonl'), lines.join('\n'));
          const graph = load(dir);
          expect(graph.nodes instanceof Map).toBe(true);
          expect(Array.isArray(graph.edges)).toBe(true);
          // And retrieval over whatever survived must not throw either.
          findingsFor(graph, nodeId('file', 'x.ts'));
        } finally {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* windows */
          }
        }
      }),
      { numRuns: 120 }
    );
  });

  it('contentHash returns null for anything unreadable instead of throwing', () => {
    fc.assert(
      fc.property(anyString(), (s) => {
        const h = contentHash(s);
        expect(h === null || /^[0-9a-f]{16}$/.test(h)).toBe(true);
      }),
      { numRuns: 200 }
    );
  });
});

describe('the containment invariant', () => {
  /**
   * The sanitiser the product applies to any untrusted name before it becomes
   * part of a path -- session ids in policy.statePath, and the marker and
   * archive names in the Stop hook. Mirrored here so the PROPERTY is tested
   * rather than a particular caller.
   */
  const sanitise = (raw) => {
    const safe = String(raw || 'default').replace(/[^A-Za-z0-9._-]/g, '');
    return (/^[.]*$/.test(safe) ? 'default' : safe).slice(0, 64);
  };

  it('no sanitised name can escape its directory, whatever it started as', () => {
    // THE FIRST VERSION OF THIS PROPERTY WAS WRONG, and fast-check said so in
    // 58 runs with the counterexample "..". Containment is not a property of
    // join -- join(root, '..') resolves to the parent and is supposed to. It is
    // a property of the SANITISER, which is the thing that actually defends the
    // boundary. Asserting it of join would have pinned a guarantee the code was
    // never making.
    const root = canonicalPath(mkdtempSync(join(tmpdir(), 'contain-')));
    const prefix = root.endsWith('/') ? root : `${root}/`;

    fc.assert(
      fc.property(anyString(), (raw) => {
        const full = canonicalPath(join(root, sanitise(raw)));
        expect(full === root || full.startsWith(prefix)).toBe(true);
      }),
      { numRuns: 500 }
    );

    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* windows can hold a handle briefly */
    }
  });

  it('and raw join genuinely does escape, which is why sanitising is required', () => {
    // Stated explicitly so nobody later "simplifies" the sanitiser away on the
    // assumption that join was safe all along.
    const root = canonicalPath(mkdtempSync(join(tmpdir(), 'escape-')));
    const prefix = root.endsWith('/') ? root : `${root}/`;
    const escaped = canonicalPath(join(root, '..'));
    expect(escaped === root || escaped.startsWith(prefix)).toBe(false);

    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* windows */
    }
  });
});
