/**
 * The `token-optimizer-inspect` command.
 *
 * WHAT THE EXIT STATUSES MEAN, since a script is the second reader here: 2 is a
 * usage error, 1 is "there was nothing to read" (no proxy, or a ledger that
 * could not be opened), and 0 includes a running proxy that has served nothing
 * yet -- a healthy machine must not read as broken.
 */

import { describe, it, expect } from '@jest/globals';
import {
  inspectJson,
  main,
  parseArguments,
  type MainDependencies,
} from '../../../src/inspect/cli.js';
import type { TransformationWindow } from '../../../src/proxy/supervisor.js';
import type { AccountingRecord } from '../../../src/proxy/accounting.js';
import type { AuditReport } from '../../../src/inspect/audit.js';

function record(over: Partial<AccountingRecord> = {}): AccountingRecord {
  return {
    ts: '2026-10-01T12:34:56.000Z',
    path: '/v1/messages',
    status: 200,
    compressed: true,
    beforeBytes: 400_000,
    afterBytes: 100_000,
    elisions: 12,
    usage: {
      input_tokens: 2413,
      cache_read_input_tokens: 115_002,
      output_tokens: 806,
    },
    ...over,
  };
}

function listener(
  over: Partial<TransformationWindow> = {}
): TransformationWindow {
  return {
    port: 51234,
    upstream: 'https://api.anthropic.com',
    held: 1,
    dropped: 0,
    records: [record()],
    ...over,
  };
}

function harness(over: Partial<MainDependencies> = {}): {
  text: () => string;
  asked: unknown[];
  deps: MainDependencies;
} {
  const out: string[] = [];
  const asked: unknown[] = [];
  return {
    text: () => out.join(''),
    asked,
    deps: {
      write: (chunk) => out.push(chunk),
      live: (options) => {
        asked.push(options);
        return Promise.resolve([listener()]);
      },
      ledger: (path, last) => {
        asked.push({ path, last });
        return Promise.resolve({ records: [record()], skipped: 0 });
      },
      ...over,
    },
  };
}

describe('parsing', () => {
  it('defaults to the live proxy and a short window', () => {
    expect(parseArguments([])).toEqual({
      last: 10,
      port: null,
      ledger: null,
      full: false,
      json: false,
      help: false,
      audit: null,
    });
  });

  it('takes every flag', () => {
    expect(
      parseArguments(['--last', '3', '--port', '51234', '--full', '--json'])
    ).toEqual({
      last: 3,
      port: 51234,
      ledger: null,
      full: true,
      json: true,
      help: false,
      audit: null,
    });
  });

  it('refuses an unknown option by name', () => {
    expect(parseArguments(['--lastest'])).toBe('unknown option --lastest');
  });

  it('refuses a bare positional, which is never a path here', () => {
    expect(parseArguments(['ledger.jsonl'])).toBe(
      'unknown option ledger.jsonl'
    );
  });

  it('refuses a count that is not a positive whole number', () => {
    for (const bad of ['abc', '0', '-3', '']) {
      expect(typeof parseArguments(['--last', bad])).toBe('string');
      expect(String(parseArguments(['--last', bad]))).toContain('--last');
    }
    expect(parseArguments(['--last', '7'])).toMatchObject({ last: 7 });
  });

  it('reads a following flag as a missing value, not as the value', () => {
    expect(parseArguments(['--last', '--json'])).toBe('--last needs a number');
    expect(parseArguments(['--ledger'])).toBe('--ledger needs a path');
  });

  it('refuses --port with --ledger, because a file has no listener', () => {
    expect(
      String(parseArguments(['--ledger', 'x.jsonl', '--port', '1']))
    ).toContain('cannot be combined with --ledger');
  });

  it('allows --ledger with every flag that is about presentation', () => {
    expect(
      parseArguments(['--ledger', 'x.jsonl', '--full', '--json', '--last', '2'])
    ).toEqual({
      last: 2,
      port: null,
      ledger: 'x.jsonl',
      full: true,
      json: true,
      help: false,
      audit: null,
    });
  });
});

describe('the live proxy', () => {
  it('prints the window and the provenance of the numbers', async () => {
    const { text, deps } = harness();
    expect(await main([], deps)).toBe(0);
    expect(text()).toContain('proxy on port 51234');
    expect(text()).toContain('https://api.anthropic.com');
    expect(text()).toContain('-75.0%');
  });

  it('passes the window size and the port through', async () => {
    const { asked, deps } = harness();
    await main(['--last', '4', '--port', '99'], deps);
    expect(asked).toEqual([{ last: 4, port: 99 }]);
  });

  it('omits the port when none was asked for, rather than sending a default', async () => {
    const { asked, deps } = harness();
    await main([], deps);
    expect(asked).toEqual([{ last: 10 }]);
  });

  it('says no proxy is listening, and how else to look', async () => {
    const { text, deps } = harness({ live: () => Promise.resolve(null) });
    expect(await main([], deps)).toBe(1);
    expect(text()).toContain('no token-optimizer proxy is listening');
    expect(text()).toContain('--ledger');
  });

  it('exits zero for a proxy that is up and has served nothing', async () => {
    const { text, deps } = harness({
      live: () => Promise.resolve([listener({ held: 0, records: [] })]),
    });
    expect(await main([], deps)).toBe(0);
    expect(text()).toContain('has not transformed a request yet');
  });

  it('warns that the window is not the whole story once records were evicted', async () => {
    const { text, deps } = harness({
      live: () => Promise.resolve([listener({ dropped: 40 })]),
    });
    await main([], deps);
    expect(text()).toContain('40 older records already evicted');
  });

  it('separates two listeners rather than interleaving their records', async () => {
    const { text, deps } = harness({
      live: () =>
        Promise.resolve([
          listener({ port: 1, upstream: 'https://api.anthropic.com' }),
          listener({ port: 2, upstream: 'https://api.openai.com' }),
        ]),
    });
    await main([], deps);
    expect(text()).toContain('proxy on port 1');
    expect(text()).toContain('proxy on port 2');
    expect(text().indexOf('api.anthropic.com')).toBeLessThan(
      text().indexOf('api.openai.com')
    );
  });

  it('skips a listener with nothing to show, but keeps the one that has', async () => {
    const { text, deps } = harness({
      live: () =>
        Promise.resolve([
          listener({ port: 1, held: 0, records: [] }),
          listener({ port: 2 }),
        ]),
    });
    await main([], deps);
    expect(text()).not.toContain('proxy on port 1');
    expect(text()).toContain('proxy on port 2');
  });
});

describe('a ledger', () => {
  it('reads the path it was given, with the window it was given', async () => {
    const { asked, deps } = harness();
    expect(await main(['--ledger', 'l.jsonl', '--last', '5'], deps)).toBe(0);
    expect(asked).toEqual([{ path: 'l.jsonl', last: 5 }]);
  });

  it('does not claim a port a file does not have', async () => {
    const { text, deps } = harness();
    await main(['--ledger', 'l.jsonl'], deps);
    expect(text()).not.toContain('proxy on port');
    expect(text()).toContain('-75.0%');
  });

  it('names the path and the reason when it cannot be read', async () => {
    const { text, deps } = harness({
      ledger: () => Promise.reject(new Error('EACCES: permission denied')),
    });
    expect(await main(['--ledger', '/root/l.jsonl'], deps)).toBe(1);
    expect(text()).toContain('/root/l.jsonl');
    expect(text()).toContain('EACCES');
  });

  it('reports the unreadable lines, singular and plural', async () => {
    const one = harness({
      ledger: () => Promise.resolve({ records: [record()], skipped: 1 }),
    });
    await main(['--ledger', 'l.jsonl'], one.deps);
    expect(one.text()).toContain('1 unreadable line skipped');
    const many = harness({
      ledger: () => Promise.resolve({ records: [record()], skipped: 3 }),
    });
    await main(['--ledger', 'l.jsonl'], many.deps);
    expect(many.text()).toContain('3 unreadable lines skipped');
  });

  it('reports the skipped lines even when nothing survived them', async () => {
    const { text, deps } = harness({
      ledger: () => Promise.resolve({ records: [], skipped: 4 }),
    });
    expect(await main(['--ledger', 'l.jsonl'], deps)).toBe(0);
    expect(text()).toContain('the ledger holds no transformation records');
    expect(text()).toContain('4 unreadable lines skipped');
  });
});

describe('usage and json', () => {
  it('prints usage for --help and asks nothing', async () => {
    const { text, asked, deps } = harness();
    expect(await main(['--help'], deps)).toBe(0);
    expect(asked).toEqual([]);
    expect(text()).toContain('--ledger <path>');
    expect(text()).toContain('TOKEN_OPTIMIZER_PROXY_ACCOUNTING');
  });

  it('names the command that answers the money question', async () => {
    // DISCOVERABILITY, NOT DECORATION. `token-optimizer-savings` has shipped as
    // a registered bin that no user-facing output ever mentioned, so the only
    // way to reach it was to already know it existed.
    const { text, deps } = harness();
    expect(await main(['--help'], deps)).toBe(0);
    expect(text()).toContain('token-optimizer-savings');
    // Positive control: the pointer has to sit in the usage this command
    // prints, not in some other stream the harness also captures.
    expect(text()).toContain('usage: token-optimizer-inspect');
  });

  it('prints the refusal above the usage, and exits 2', async () => {
    const { text, deps } = harness();
    expect(await main(['--nope'], deps)).toBe(2);
    expect(text().startsWith('unknown option --nope')).toBe(true);
  });

  it('emits parseable json carrying the records and the totals', async () => {
    const { text, deps } = harness();
    expect(await main(['--json'], deps)).toBe(0);
    const parsed = JSON.parse(text());
    expect(parsed.source).toBe('proxy');
    expect(parsed.totals.requests).toBe(1);
    expect(parsed.windows[0].records[0].path).toBe('/v1/messages');
  });

  it('names the ledger as the source, so a consumer knows what it read', async () => {
    const { text, deps } = harness();
    await main(['--ledger', 'l.jsonl', '--json'], deps);
    expect(JSON.parse(text()).source).toBe('ledger');
  });

  it('computes the totals across every window, not per window', () => {
    const json = inspectJson(
      'proxy',
      [
        listener({ records: [record({ beforeBytes: 1000, afterBytes: 250 })] }),
        listener({
          records: [
            record({ compressed: false, beforeBytes: 1000, afterBytes: 1000 }),
          ],
        }),
      ],
      0
    );
    expect(json.totals).toMatchObject({
      requests: 2,
      compressed: 1,
      beforeBytes: 2000,
    });
  });

  it('omits the skipped count when nothing was skipped', () => {
    expect(inspectJson('proxy', [listener()], 0)).not.toHaveProperty('skipped');
    expect(inspectJson('proxy', [listener()], 2)).toHaveProperty('skipped', 2);
  });
});

/**
 * `--audit` is the one flag here that asks whether the records are RIGHT rather
 * than how to show them, so it has its own rendering and its own exit status --
 * and both have to be wrong-way-round-proof: a script that gates on this
 * command must see a non-zero status when the two recorders disagree, and when
 * nothing was compared at all.
 */
function report(over: Partial<AuditReport> = {}): AuditReport {
  const side = {
    total: 2,
    skipped: 0,
    missing: false,
    compared: 2,
    excluded: 0,
    unaligned: 0,
  };
  return {
    capture: side,
    ledger: side,
    from: '2026-10-01T12:00:00.000Z',
    to: '2026-10-01T12:30:00.000Z',
    bytes: [],
    models: [],
    agreed: true,
    ...over,
  };
}

describe('an audit', () => {
  it('compares the directory it was given against the ledger it was given', async () => {
    const { asked, deps } = harness({
      audit: (captureDir, ledgerPath) => {
        asked.push({ captureDir, ledgerPath });
        return Promise.resolve(report());
      },
    });
    expect(await main(['--audit', 'cap', '--ledger', 'l.jsonl'], deps)).toBe(0);
    expect(asked).toEqual([{ captureDir: 'cap', ledgerPath: 'l.jsonl' }]);
  });

  it('takes the ledger the proxy itself writes when none is named', async () => {
    const { asked, deps } = harness({
      env: { TOKEN_OPTIMIZER_PROXY_ACCOUNTING: '/var/ledger.jsonl' },
      audit: (captureDir, ledgerPath) => {
        asked.push({ captureDir, ledgerPath });
        return Promise.resolve(report());
      },
    });
    expect(await main(['--audit', 'cap'], deps)).toBe(0);
    expect(asked).toEqual([
      { captureDir: 'cap', ledgerPath: '/var/ledger.jsonl' },
    ]);
  });

  it('refuses without a ledger, naming both ways to supply one', async () => {
    const { text, deps } = harness({ env: {} });
    expect(await main(['--audit', 'cap'], deps)).toBe(2);
    expect(text()).toContain('--audit needs a ledger');
    expect(text()).toContain('--ledger <path>');
    expect(text()).toContain('TOKEN_OPTIMIZER_PROXY_ACCOUNTING');
  });

  it('exits non-zero on a disagreement', async () => {
    const { text, deps } = harness({
      audit: () =>
        Promise.resolve(
          report({
            agreed: false,
            bytes: [
              { path: '/v1/messages', value: '400', inCapture: 2, inLedger: 1 },
            ],
          })
        ),
    });
    expect(await main(['--audit', 'cap', '--ledger', 'l.jsonl'], deps)).toBe(1);
    expect(text()).toContain('2 captured, 1 in the ledger');
  });

  it('exits non-zero when nothing was compared, which is not a pass', async () => {
    const { text, deps } = harness({
      audit: () =>
        Promise.resolve(
          report({
            agreed: false,
            capture: {
              total: 0,
              skipped: 0,
              missing: true,
              compared: 0,
              excluded: 0,
              unaligned: 0,
            },
            from: null,
            to: null,
          })
        ),
    });
    expect(await main(['--audit', 'cap', '--ledger', 'l.jsonl'], deps)).toBe(1);
    expect(text()).toContain('nothing was compared');
  });

  it('emits the report itself under --json', async () => {
    const { text, deps } = harness({ audit: () => Promise.resolve(report()) });
    expect(
      await main(['--audit', 'cap', '--ledger', 'l.jsonl', '--json'], deps)
    ).toBe(0);
    expect(JSON.parse(text())).toEqual(report());
  });

  it('asks neither the proxy nor the ledger reader', async () => {
    // THE BRANCH HAS TO BE A BRANCH. Falling through would print the
    // per-request table under a flag that asked a different question.
    const { asked, deps } = harness({ audit: () => Promise.resolve(report()) });
    await main(['--audit', 'cap', '--ledger', 'l.jsonl'], deps);
    expect(asked).toEqual([]);
  });

  it('names both paths when the audit itself cannot run', async () => {
    const { text, deps } = harness({
      audit: () => Promise.reject(new Error('EACCES: permission denied')),
    });
    expect(await main(['--audit', '/cap', '--ledger', '/l.jsonl'], deps)).toBe(
      1
    );
    expect(text()).toContain('/cap');
    expect(text()).toContain('/l.jsonl');
    expect(text()).toContain('EACCES');
  });

  it('refuses a live listener, which cannot hold the capture it would need', async () => {
    expect(parseArguments(['--audit', 'cap', '--port', '51234'])).toBe(
      '--port names a live listener, so it cannot be combined with --audit'
    );
  });

  it('asks for a directory, not a path, when the value is missing', () => {
    expect(parseArguments(['--audit'])).toBe('--audit needs a directory');
    expect(parseArguments(['--audit', '--json'])).toBe(
      '--audit needs a directory'
    );
    expect(parseArguments(['--ledger'])).toBe('--ledger needs a path');
  });

  it('offers the flag in --help, with both variables it needs', async () => {
    const { text, deps } = harness();
    expect(await main(['--help'], deps)).toBe(0);
    expect(text()).toContain('--audit <dir>');
    expect(text()).toContain('TOKEN_OPTIMIZER_PROXY_CAPTURE');
  });
});
