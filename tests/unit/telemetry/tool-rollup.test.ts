/**
 * The tool rollup carries a name from the request into a property key, and
 * that is the part worth testing hardest.
 *
 * Every other field here is a count, and a wrong count is caught by the
 * hand-computed totals below. The name is different in kind: it is the only
 * caller-supplied value anywhere in the payload, it reaches the event as a KEY
 * -- the one position `sanitiseProperties` does not police -- and a leak there
 * would look exactly like a correct event. So the refusal path is asserted
 * three ways: a name the server never advertised, a name carrying characters a
 * tool name cannot have, and a name arriving once the window is already full
 * of distinct tools. In all three the call must still be counted, because a
 * guard that silently drops calls would make the totals lie instead.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  noteToolCall,
  flushToolRollup,
  pendingToolCounts,
  resetToolRollup,
  TOOL_ROLLUP_EVERY,
  MAX_TOOL_KEYS,
} from '../../../src/telemetry/tool-rollup.js';
import { eventsFile } from '../../../src/telemetry/recorder.js';

let home: string;
const optedIn = (): NodeJS.ProcessEnv =>
  ({
    TOKEN_OPTIMIZER_TELEMETRY: '1',
    USERPROFILE: home,
    HOME: home,
  }) as NodeJS.ProcessEnv;
const optedOut = (): NodeJS.ProcessEnv =>
  ({ USERPROFILE: home, HOME: home }) as NodeJS.ProcessEnv;

const written = (env: NodeJS.ProcessEnv): Record<string, unknown>[] => {
  const at = eventsFile(env);
  if (!existsSync(at)) return [];
  return readFileSync(at, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

const props = (
  env: NodeJS.ProcessEnv,
  index = 0
): Record<string, number | boolean> =>
  written(env)[index]?.properties as Record<string, number | boolean>;

/** `n` successful calls of one advertised tool, each taking 1ms. */
const run = (
  name: string,
  n: number,
  env: NodeJS.ProcessEnv,
  ok = true,
  advertised = true
): void => {
  for (let i = 0; i < n; i += 1) noteToolCall(name, 1, ok, advertised, env);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'to-toolrollup-'));
  resetToolRollup();
});

afterEach(() => {
  resetToolRollup();
  rmSync(home, { recursive: true, force: true });
});

describe('the window', () => {
  it('writes nothing until it is full, and then exactly one event', () => {
    const env = optedIn();
    run('smart_read', TOOL_ROLLUP_EVERY - 1, env);
    expect(written(env)).toHaveLength(0);

    const emitted = noteToolCall('smart_read', 1, true, true, env);
    expect(emitted).not.toBeNull();
    expect(written(env)).toHaveLength(1);
    expect(written(env)[0].event_type).toBe('mcp_tool_rollup');
  });

  it('counts each tool under its own key, and the totals across all of them', () => {
    const env = optedIn();
    run('smart_read', 120, env);
    run('smart_grep', 70, env);
    run('smart_glob', 9, env);
    // The 200th call is the emit, and it is a failure so both the shared
    // `failed` total and this tool's own error key have to move.
    noteToolCall('smart_glob', 5, false, true, env);

    const p = props(env);
    expect(p.calls).toBe(TOOL_ROLLUP_EVERY);
    expect(p.t_smart_read).toBe(120);
    expect(p.t_smart_grep).toBe(70);
    expect(p.t_smart_glob).toBe(10);
    expect(p.failed).toBe(1);
    expect(p.e_smart_glob).toBe(1);
    // 199 calls of 1ms plus the 5ms failure.
    expect(p.ms_total).toBe(TOOL_ROLLUP_EVERY - 1 + 5);
  });

  it('omits an error key for a tool that never failed', () => {
    const env = optedIn();
    run('smart_read', TOOL_ROLLUP_EVERY, env);
    const p = props(env);
    expect(p.t_smart_read).toBe(TOOL_ROLLUP_EVERY);
    expect('e_smart_read' in p).toBe(false);
    expect(p.failed).toBe(0);
  });

  it('starts the next window from zero', () => {
    const env = optedIn();
    run('smart_read', TOOL_ROLLUP_EVERY, env);
    run('smart_grep', TOOL_ROLLUP_EVERY, env);

    // The SECOND event is the one that would expose counts carried over.
    const p = props(env, 1);
    expect(p.calls).toBe(TOOL_ROLLUP_EVERY);
    expect(p.t_smart_grep).toBe(TOOL_ROLLUP_EVERY);
    expect('t_smart_read' in p).toBe(false);
  });
});

describe('what may become a property key', () => {
  it('refuses a name the server did not advertise, and still counts the call', () => {
    const env = optedIn();
    noteToolCall('exfiltrate_me', 1, true, false, env);
    const p = pendingToolCounts();
    expect(p.calls).toBe(1);
    expect(p.t_unknown).toBe(1);
    expect('t_exfiltrate_me' in p).toBe(false);
  });

  it('refuses a name that is not a lower-case ascii identifier', () => {
    const env = optedIn();
    // Every one of these is passed as advertised, which cannot happen through
    // the server; the point is that the module does not rely on that.
    const hostile = [
      'Smart_Read',
      'smart-read',
      'smart read',
      '../../etc/passwd',
      'a'.repeat(64),
      '',
      '1tool',
    ];
    for (const name of hostile) noteToolCall(name, 1, true, true, env);

    const p = pendingToolCounts();
    expect(p.calls).toBe(hostile.length);
    expect(p.t_unknown).toBe(hostile.length);
    expect(Object.keys(p).filter((k) => k.startsWith('t_'))).toEqual([
      't_unknown',
    ]);
  });

  it('stops minting keys past the cap without losing the calls', () => {
    const env = optedIn();
    for (let i = 0; i < MAX_TOOL_KEYS; i += 1) run('tool_' + i, 1, env);
    // Every name so far is distinct and the cap is now reached, so the next
    // new name has nowhere to go but `unknown` -- while a name already in the
    // window keeps its own key.
    run('one_more', 3, env);
    run('tool_0', 2, env);

    const p = pendingToolCounts();
    expect(p.calls).toBe(MAX_TOOL_KEYS + 5);
    expect(p.t_unknown).toBe(3);
    expect(p.t_tool_0).toBe(3);
    expect(
      Object.keys(p).filter((k) => k.startsWith('t_')).length
    ).toBe(MAX_TOOL_KEYS + 1);
  });
});

describe('the shutdown rollup', () => {
  it('writes what is pending and marks it final', () => {
    const env = optedIn();
    run('smart_read', 3, env, false);
    expect(written(env)).toHaveLength(0);

    expect(flushToolRollup(env)).not.toBeNull();
    const p = props(env);
    expect(p.final).toBe(true);
    expect(p.calls).toBe(3);
    expect(p.e_smart_read).toBe(3);
  });

  it('writes nothing when nothing was counted', () => {
    const env = optedIn();
    expect(flushToolRollup(env)).toBeNull();
    expect(written(env)).toHaveLength(0);
  });

  it('marks a window rollup as not final', () => {
    const env = optedIn();
    run('smart_read', TOOL_ROLLUP_EVERY, env);
    expect(props(env).final).toBe(false);
  });
});

describe('consent', () => {
  it('writes nothing at all when the user has not opted in', () => {
    const env = optedOut();
    run('smart_read', TOOL_ROLLUP_EVERY, env);
    expect(flushToolRollup(env)).toBeNull();
    expect(written(env)).toHaveLength(0);
  });

  it('still counts locally, so a report has something to show', () => {
    const env = optedOut();
    run('smart_read', 5, env);
    expect(pendingToolCounts().calls).toBe(5);
  });
});