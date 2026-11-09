import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hoistStableContext,
  hoistContextEnabled,
  ParagraphLedger,
  sessionOf,
  MIN_HOISTED_CHARS,
} from '../../../src/compress/hoist-stable.js';
import type { Block, ProviderRequest } from '../../../src/compress/frontier.js';

/**
 * The layout Claude Code 2.1.319 sends for a main session (live upstream
 * capture through the proxy, 2026-11-08): markers on two system blocks, the
 * sibling marker inside messages[0], and the environment context as a
 * system-role messages[1] -- an array with a marker while it is the last
 * message, a plain string on later requests.
 */
const cc = { type: 'ephemeral', ttl: '1h' };
const STABLE = [
  'SessionStart hook additional context: # Token optimization is active',
  `The following deferred tools are now available via ToolSearch.\n${'Tool\n'.repeat(120)}`,
  `# MCP Server Instructions\n\n${'Use the built-in tools. '.repeat(30)}`,
  `The following skills are available for use with the Skill tool:\n${'- skill: does a thing\n'.repeat(40)}`,
];
const opening = (cwd: string, date = 'Today is 2026-11-09.') =>
  [
    STABLE[0],
    `# Environment\n - Primary working directory: ${cwd}`,
    STABLE[1],
    STABLE[2],
    STABLE[3],
    date,
  ].join('\n\n');

function request(
  session: string | null,
  cwd: string,
  form: 'array' | 'string',
  date?: string,
  project = 'p1'
): ProviderRequest {
  const text = opening(cwd, date);
  return {
    model: 'claude',
    metadata:
      session === null
        ? undefined
        : { user_id: JSON.stringify({ device_id: 'd', session_id: session }) },
    system: [
      { type: 'text', text: 'billing' },
      { type: 'text', text: 'identity', cache_control: cc },
      {
        type: 'text',
        text: `the system prompt; memory for ${project}`,
        cache_control: cc,
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'memory' },
          { type: 'text', text: 'attribution' },
          { type: 'text', text: 'the task' },
        ],
      },
      {
        role: 'system',
        content:
          form === 'array' ? [{ type: 'text', text, cache_control: cc }] : text,
      },
    ],
  } as unknown as ProviderRequest;
}

const systemOf = (r: ProviderRequest) => r.system as Block[];
const openingText = (r: ProviderRequest): string => {
  const c = (r.messages ?? [])[1].content;
  return typeof c === 'string' ? c : ((c as Block[])[0].text ?? '');
};
const markers = (r: ProviderRequest): number =>
  JSON.stringify(r).split('"cache_control"').length - 1;

describe('hoistStableContext', () => {
  it('moves nothing in the first session, and records what it saw', () => {
    const ledger = new ParagraphLedger();
    const out = hoistStableContext(request('s1', '/a', 'array'), ledger);
    expect(out.hoistedChars).toBe(0);
    expect(systemOf(out.request)).toHaveLength(3);
    // Seven paragraphs (the MCP section is two: heading and body), and the
    // system prompt, which tells the next session it is the same project.
    expect(ledger.size).toBe(8);
  });

  it('never moves a paragraph within the session that first sent it', () => {
    const ledger = new ParagraphLedger();
    hoistStableContext(request('s1', '/a', 'array'), ledger);
    const again = hoistStableContext(request('s1', '/a', 'string'), ledger);
    expect(again.hoistedChars).toBe(0);
  });

  it('moves the paragraphs an earlier session sent, in order, and keeps the rest', () => {
    const ledger = new ParagraphLedger();
    hoistStableContext(request('s1', '/a', 'array'), ledger);
    const out = hoistStableContext(request('s2', '/b', 'array'), ledger);

    const system = systemOf(out.request);
    expect(system).toHaveLength(4);
    // The date did not change between the two sessions, so it moves too.
    const moved = [...STABLE, 'Today is 2026-11-09.'].join('\n\n');
    expect(system[3].text).toBe(moved);
    expect(out.hoistedChars).toBe(moved.length);
    // What changed between sessions stays where it was.
    expect(openingText(out.request)).toBe(
      '# Environment\n - Primary working directory: /b'
    );
    // Nothing is lost: every paragraph is in exactly one of the two places.
    const all = `${system[3].text}\n\n${openingText(out.request)}`;
    for (const p of opening('/b').split('\n\n')) expect(all).toContain(p);
  });

  it('moves the system marker onto the moved text and keeps the marker count', () => {
    const ledger = new ParagraphLedger();
    const first = request('s1', '/a', 'array');
    hoistStableContext(first, ledger);
    const input = request('s2', '/b', 'array');
    const out = hoistStableContext(input, ledger);
    const system = systemOf(out.request);
    expect(system[2].cache_control).toBeUndefined();
    expect(system[3].cache_control).toEqual(cc);
    expect(markers(out.request)).toBe(markers(input));
    // The opening turn keeps its own marker while it is the last message.
    expect(
      ((out.request.messages ?? [])[1].content as Block[])[0].cache_control
    ).toEqual(cc);
    // The input is not mutated.
    expect(systemOf(input)[2].cache_control).toEqual(cc);
  });

  it('in a project not seen before, puts the moved text before its system prompt with a marker of its own', () => {
    const ledger = new ParagraphLedger();
    hoistStableContext(request('s1', '/a', 'array', undefined, 'p1'), ledger);
    const input = request('s2', '/b', 'array', undefined, 'p2');
    const out = hoistStableContext(input, ledger);
    const system = systemOf(out.request);
    expect(system).toHaveLength(4);
    expect(system[2].text).toContain('deferred tools');
    expect(system[2].cache_control).toEqual(cc);
    // The client's own markers stay where they were.
    expect(system[1].cache_control).toEqual(cc);
    expect(system[3].text).toBe('the system prompt; memory for p2');
    expect(system[3].cache_control).toEqual(cc);
    expect(markers(out.request)).toBe(markers(input) + 1);
  });

  it('keeps that placement for the whole session, then switches once the project repeats', () => {
    const ledger = new ParagraphLedger();
    hoistStableContext(request('s1', '/a', 'array', undefined, 'p1'), ledger);
    const first = hoistStableContext(
      request('s2', '/b', 'array', undefined, 'p2'),
      ledger
    );
    const later = hoistStableContext(
      request('s2', '/b', 'string', undefined, 'p2'),
      ledger
    );
    expect(JSON.stringify(later.request.system)).toBe(
      JSON.stringify(first.request.system)
    );
    // The next session in p2 sees a system prompt an earlier session sent.
    const next = hoistStableContext(
      request('s3', '/c', 'array', undefined, 'p2'),
      ledger
    );
    const system = systemOf(next.request);
    expect(system[2].text).toBe('the system prompt; memory for p2');
    expect(system[2].cache_control).toBeUndefined();
    expect(system[3].cache_control).toEqual(cc);
  });

  it('never adds a fifth marker: with four already, the moved text takes the system marker instead', () => {
    const ledger = new ParagraphLedger();
    const full = (s: string, cwd: string, project: string) => {
      const r = request(s, cwd, 'array', undefined, project);
      return {
        ...r,
        tools: [{ name: 'Read', cache_control: cc }],
      } as unknown as ProviderRequest;
    };
    hoistStableContext(full('s1', '/a', 'p1'), ledger);
    const input = full('s2', '/b', 'p2');
    const out = hoistStableContext(input, ledger);
    expect(markers(input)).toBe(4);
    expect(markers(out.request)).toBe(4);
    expect(systemOf(out.request)[3].text).toContain('deferred tools');
  });

  it('gives the same system prompt whether the turn arrives as an array or a string', () => {
    const ledger = new ParagraphLedger();
    hoistStableContext(request('s1', '/a', 'array'), ledger);
    const asArray = hoistStableContext(request('s2', '/b', 'array'), ledger);
    const asString = hoistStableContext(request('s2', '/b', 'string'), ledger);
    expect(JSON.stringify(asString.request.system)).toBe(
      JSON.stringify(asArray.request.system)
    );
    expect(typeof (asString.request.messages ?? [])[1].content).toBe('string');
  });

  it('leaves a paragraph that changed between sessions in place', () => {
    const ledger = new ParagraphLedger();
    hoistStableContext(
      request('s1', '/a', 'array', 'Today is 2026-11-08.'),
      ledger
    );
    const out = hoistStableContext(
      request('s2', '/b', 'array', 'Today is 2026-11-09.'),
      ledger
    );
    expect(systemOf(out.request)[3].text).not.toContain('Today is');
    expect(openingText(out.request)).toContain('Today is 2026-11-09.');
  });

  it('declines without a session id, below the floor, or when nothing would remain', () => {
    const ledger = new ParagraphLedger();
    hoistStableContext(request(null, '/a', 'array'), ledger);
    expect(ledger.size).toBe(0);
    expect(
      hoistStableContext(request(null, '/b', 'array'), ledger).hoistedChars
    ).toBe(0);

    const small = new ParagraphLedger();
    const tiny = (s: string) =>
      ({
        ...request(s, '/a', 'array'),
        messages: [
          { role: 'user', content: 'task' },
          {
            role: 'system',
            content: `short\n\n${'y'.repeat(MIN_HOISTED_CHARS - 10)}\n\ncwd ${s}`,
          },
        ],
      }) as unknown as ProviderRequest;
    hoistStableContext(tiny('s1'), small);
    expect(hoistStableContext(tiny('s2'), small).hoistedChars).toBe(0);

    const whole = new ParagraphLedger();
    const same = (s: string) =>
      ({
        ...request(s, '/a', 'array'),
        messages: [
          { role: 'user', content: 'task' },
          { role: 'system', content: 'z'.repeat(MIN_HOISTED_CHARS * 2) },
        ],
      }) as unknown as ProviderRequest;
    hoistStableContext(same('s1'), whole);
    expect(hoistStableContext(same('s2'), whole).hoistedChars).toBe(0);
  });

  it('only touches a system turn that opens the conversation', () => {
    const ledger = new ParagraphLedger();
    const late = (s: string, cwd: string) => {
      const r = request(s, cwd, 'array');
      const [user, system] = r.messages ?? [];
      return {
        ...r,
        messages: [user, { role: 'assistant', content: 'ok' }, system],
      } as unknown as ProviderRequest;
    };
    hoistStableContext(late('s1', '/a'), ledger);
    expect(hoistStableContext(late('s2', '/b'), ledger).hoistedChars).toBe(0);
  });
});

describe('ParagraphLedger persistence', () => {
  it('survives a restart and stores hashes, not text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoist-'));
    const file = join(dir, 'proxy-paragraphs.json');
    const before = new ParagraphLedger(file);
    hoistStableContext(request('s1', '/a', 'array'), before);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('deferred tools');
    expect(raw).not.toContain('s1');

    const after = new ParagraphLedger(file);
    expect(
      hoistStableContext(request('s2', '/b', 'array'), after).hoistedChars
    ).toBeGreaterThan(0);
  });

  it('treats an unreadable file as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoist-'));
    const file = join(dir, 'proxy-paragraphs.json');
    writeFileSync(file, '{not json');
    const ledger = new ParagraphLedger(file);
    expect(ledger.size).toBe(0);
    expect(
      hoistStableContext(request('s1', '/a', 'array'), ledger).hoistedChars
    ).toBe(0);
  });

  it('forgets the oldest paragraphs past its bound', () => {
    const ledger = new ParagraphLedger(null, 3);
    ledger.seenElsewhere('a', 's1');
    ledger.seenElsewhere('b', 's1');
    ledger.seenElsewhere('c', 's1');
    ledger.seenElsewhere('d', 's1');
    expect(ledger.size).toBe(3);
    expect(ledger.seenElsewhere('a', 's2')).toBe(false);
    expect(ledger.seenElsewhere('d', 's2')).toBe(true);
  });
});

describe('sessionOf and the switch', () => {
  it('reads the session id Claude Code puts in metadata.user_id', () => {
    expect(sessionOf(request('abc', '/a', 'array'))).toBe('abc');
    expect(
      sessionOf({
        metadata: { user_id: 'not json' },
      } as unknown as ProviderRequest)
    ).toBeUndefined();
  });

  it('is on unless switched off', () => {
    expect(hoistContextEnabled({})).toBe(true);
    for (const off of ['0', 'false', 'no', 'OFF'])
      expect(
        hoistContextEnabled({ TOKEN_OPTIMIZER_PROXY_HOIST_CONTEXT: off })
      ).toBe(false);
  });
});
