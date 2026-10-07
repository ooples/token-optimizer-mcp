/**
 * CAN AN OPERATOR ADOPT A POSTURE WITHOUT ADOPTING OUR PROXY?
 *
 * A posture is one word that sets eight things, and until now the only way to
 * get those eight things was to run our channel. Someone who runs their agent
 * behind their own launcher -- which is most of the people a posture is for --
 * had no way to read the dials out at all. Four questions follow:
 *
 *   Is what gets printed the same set the proxy would actually run? One
 *   function decides, and the test below compares the printed set against what
 *   `applyPosture` seeds into a clean environment, so a second definition
 *   drifting away from the first fails here rather than at an operator.
 *
 *   Does printing stay printing? Nothing may be bound, nothing read, and the
 *   process environment must come back untouched -- this is a question about a
 *   posture, not a run of the proxy, so the kill switch is not even consulted.
 *
 *   Can a posture's exports carry consent? No: every variable that records
 *   where conversation content goes or what a holdout spends is excluded from
 *   postures, and that exclusion has to survive a new way of emitting them.
 *
 *   Is the output something a shell hands back unchanged? It is meant to be
 *   eval'd, so a value is single-quoted and the quote itself is escaped.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  parseArgs,
  run,
  shellQuote,
  spillFromEnv,
} from '../../../src/proxy/cli.js';
import {
  COMPRESSION_ENV,
  POSTURES,
  applyPosture,
  postureEnv,
} from '../../../src/proxy/posture.js';

const NAMES = Object.keys(POSTURES);

/** Variables that record consent, never a setting. Mirrors posture.test.ts. */
const CONSENT_BEARING: readonly string[] = [
  'TOKEN_OPTIMIZER_PROXY_CAPTURE',
  'TOKEN_OPTIMIZER_PROXY_ACCOUNTING',
  'TOKEN_OPTIMIZER_OUTPUT_HOLDOUT',
  'TOKEN_OPTIMIZER_PROXY_DEFER_HOLDOUT',
];

/** Run the CLI and keep what it wrote, without letting it reach a terminal. */
async function capture(
  argv: readonly string[]
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const stdout = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      out += String(chunk);
      return true;
    });
  const stderr = jest
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      err += String(chunk);
      return true;
    });
  try {
    const code = await run(argv);
    return { code, out, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

/** The exports, parsed back into the mapping a shell would end up with. */
function parseExports(out: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of out.split('\n')) {
    if (line === '') continue;
    const match = /^export ([A-Z0-9_]+)='(.*)'$/.exec(line);
    if (match === null) throw new Error(`not an export line: ${line}`);
    values[match[1]] = match[2].split("'\''").join("'");
  }
  return values;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('--print-env prints the set the proxy would run', () => {
  it('prints exactly what applyPosture seeds, for every posture', async () => {
    const union = new Set<string>();
    for (const name of NAMES) {
      const { code, out } = await capture(['--posture', name, '--print-env']);
      expect(code).toBe(0);
      // THE COMPARISON IS AGAINST THE SEEDING PATH, not against a second list
      // written here: an empty environment means every variable is seedable,
      // so what landed in it IS what this posture sets.
      const seeded: NodeJS.ProcessEnv = {};
      applyPosture(name, seeded);
      expect(parseExports(out)).toEqual(seeded);
      // EVERY POSTURE SETS AT LEAST THE CHANNEL'S PRESET, so an empty print is
      // a bug rather than a posture that happens to mean nothing -- but the
      // count is per posture, and the leanest one sets only that. The breadth
      // claim belongs to the union, below.
      expect(Object.keys(seeded)).toContain(COMPRESSION_ENV);
      for (const key of Object.keys(seeded)) union.add(key);
    }
    expect(union.size).toBeGreaterThan(3);
  });

  it('sorts the exports, so two releases can be diffed', async () => {
    const { out } = await capture(['--posture', NAMES[0], '--print-env']);
    const keys = Object.keys(parseExports(out));
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('emits the same set as a JSON object under --json', async () => {
    const shell = await capture(['--posture', NAMES[0], '--print-env']);
    const json = await capture([
      '--posture',
      NAMES[0],
      '--print-env',
      '--json',
    ]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toEqual(parseExports(shell.out));
  });

  it('names no variable that records consent, under either format', async () => {
    for (const name of NAMES) {
      const printed = postureEnv(name);
      expect(printed).not.toBeNull();
      const keys = Object.keys(printed ?? {});
      for (const consent of CONSENT_BEARING) {
        expect(keys).not.toContain(consent);
      }
      const { out } = await capture(['--posture', name, '--print-env']);
      for (const consent of CONSENT_BEARING) expect(out).not.toContain(consent);
    }
  });
});

describe('printing is not running', () => {
  it('leaves this process environment untouched', async () => {
    const before = JSON.stringify(process.env);
    await capture(['--posture', NAMES[0], '--print-env']);
    expect(JSON.stringify(process.env)).toBe(before);
  });

  it('prints even when the kill switch is on, because it starts nothing', async () => {
    const previous = process.env.TOKEN_OPTIMIZER_MODE;
    process.env.TOKEN_OPTIMIZER_MODE = 'off';
    try {
      const { code, out } = await capture([
        '--posture',
        NAMES[0],
        '--print-env',
      ]);
      expect(code).toBe(0);
      expect(out).toContain('export ');
    } finally {
      if (previous === undefined) delete process.env.TOKEN_OPTIMIZER_MODE;
      else process.env.TOKEN_OPTIMIZER_MODE = previous;
    }
  });

  it('writes the exports to stdout and nothing else with them', async () => {
    const { out, err } = await capture(['--posture', NAMES[0], '--print-env']);
    expect(err).toBe('');
    for (const line of out.split('\n').slice(0, -1)) {
      expect(line.startsWith('export TOKEN_OPTIMIZER_')).toBe(true);
    }
  });
});

describe('a flag that names nothing is a typo', () => {
  it('refuses --print-env without a posture', () => {
    expect(() => parseArgs(['--print-env'])).toThrow(
      '--print-env needs --posture NAME'
    );
  });

  it('refuses --json on its own, which would otherwise start a proxy', () => {
    expect(() => parseArgs(['--json'])).toThrow(
      '--json only applies to --print-env'
    );
  });

  it('refuses an unknown posture name, and lists the known ones', async () => {
    const { code, out, err } = await capture([
      '--posture',
      'no-such-posture',
      '--print-env',
    ]);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toContain("no posture named 'no-such-posture'");
    for (const name of NAMES) expect(err).toContain(name);
  });

  it('offers the flag in its own usage text', async () => {
    const { code, err } = await capture(['--help']);
    expect(code).toBe(0);
    expect(err).toContain('--print-env');
  });
});

describe('the exports survive a shell', () => {
  // A POSITIVE CONTROL FOR THE QUOTING. No posture we ship carries a quote, a
  // dollar or a backtick today, so a test that only looked at real postures
  // would pass with no quoting at all -- and would keep passing right up to
  // the release that added such a value and silently mis-exported it.
  it.each([
    ['plain', "'plain'"],
    ['a b', "'a b'"],
    ['$HOME', "'$HOME'"],
    ['`id`', "'`id`'"],
    ["it's", "'it'\\''s'"],
  ])('quotes %s so a shell hands it back unchanged', (value, expected) => {
    expect(shellQuote(value)).toBe(expected);
  });

  it('never uses double quotes, which a shell would still expand', () => {
    for (const name of NAMES) {
      for (const value of Object.values(postureEnv(name) ?? {})) {
        expect(shellQuote(value).startsWith("'")).toBe(true);
      }
    }
  });
});

/**
 * SPILL IS SETTABLE BY ENVIRONMENT, because the flag alone could not reach the
 * proxy that matters.
 *
 * A client's base URL points at the SUPERVISED proxy, and a flag can only be
 * given to one started by hand. So withholding was unreachable exactly where
 * real traffic flows, and measuring the fetch rate would have meant repointing
 * every client at an ad-hoc port that dies with its shell.
 */
describe('spill from the environment', () => {
  it('is off when nothing is set', () => {
    expect(spillFromEnv({})).toBe(false);
  });

  it('is off for every value an operator would use to mean off', () => {
    // `no` IS THE ONE THAT CAUGHT IT: the deny-list version returned true for
    // anything it did not list, so `no` enabled withholding.
    for (const value of [
      '',
      '0',
      'false',
      'off',
      ' OFF ',
      'False',
      'no',
      'n',
      'disabled',
      'nope',
    ])
      expect(spillFromEnv({ TOKEN_OPTIMIZER_PROXY_SPILL: value })).toBe(false);
  });

  it('is on when asked for', () => {
    for (const value of ['1', 'true', 'yes', 'on'])
      expect(spillFromEnv({ TOKEN_OPTIMIZER_PROXY_SPILL: value })).toBe(true);
  });
});
