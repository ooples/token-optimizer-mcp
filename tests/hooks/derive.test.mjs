/**
 * The zero-cost extractors -- and what they are NOT allowed to claim.
 *
 * The graph on this machine held 2,965 symbol nodes, 904 file nodes, 128 task
 * nodes and ONE finding, because every path to a verdict needed an API key this
 * machine does not have. These detectors need none. That makes them the only
 * finding producer on a default install, which makes their PRECISION the whole
 * question: a graph that fills with junk competes for the injection budget
 * against the findings that are real, and is worse than an empty one.
 *
 * So most of what is tested here is refusal.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record, recordToolOutcome } from '../../hooks-core/metrics.mjs';
import { transcriptDir, safeName } from '../../hooks-core/transcript.mjs';
import { derive, CONFIDENCE, attemptKey } from '../../hooks-core/derive.mjs';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'der-'));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows */
  }
});

/**
 * A command outcome as the boundary really writes it.
 *
 * THROUGH `recordToolOutcome`, NOT `record`. The command text lives in `anchor`
 * (there is no command field), `output` is captured only when the call did not
 * report success, and the redaction and the 4 KB cap happen at that boundary. A
 * fixture that wrote the event by hand would be testing a shape production never
 * produces -- which is how a detector keyed on a field nobody writes passes its
 * own tests and derives nothing in the field.
 */
const outcome = (anchor, { success, output = null, exit = null, at }) =>
  recordToolOutcome(dir, {
    kind: 'tool-outcome',
    surface: 'command',
    anchor,
    success,
    output,
    exit,
    at,
  });

/** A user turn in the local archive, which is where corrections are read from. */
const archiveTurns = (sessionId, turns) => {
  mkdirSync(transcriptDir(dir), { recursive: true });
  writeFileSync(
    join(transcriptDir(dir), `${safeName(sessionId)}.jsonl`),
    turns.map((t) => JSON.stringify(t)).join('\n') + '\n'
  );
};

const run = (options = {}) =>
  derive(dir, { sessionId: 's', projectRoot: dir, ...options });

describe('a command that failed and then succeeded', () => {
  it('turns a failed-then-succeeded command into a command and a failure finding', () => {
    outcome('npm run build', { success: false, output: 'TS2345 error', exit: 1, at: 1 });
    outcome('npm run build -- --skipLibCheck', { success: true, output: 'ok', exit: 0, at: 2 });

    const types = run().candidates.map((c) => c.type);
    expect(types).toContain('command');
    expect(types).toContain('failure');
  });

  it('claims only what it observed -- succeeded WHERE, never fixed', () => {
    // THE CAUSAL LIMIT, IN THE CLAIM TEXT. Two ordered outcomes on one attempt
    // do not establish that the second command's difference caused the second
    // outcome; an intervening edit or a flaky run explains the same pair. A
    // claim of "fixes" would assert what no local evidence can support.
    outcome('deploy', { success: false, output: 'connection refused by host', at: 1 });
    outcome('deploy --retry', { success: true, output: 'ok', at: 2 });

    const command = run().candidates.find((c) => c.type === 'command');
    expect(command.claim).toContain('succeeded in this project where');
    expect(command.claim).not.toMatch(/\bfix(es|ed)?\b/i);
    expect(command.evidence).toContain('not proven causal');
  });

  it('derives nothing when the same command text failed and then succeeded', () => {
    // THE COMMONEST SHAPE IN A CODING SESSION, and the one that supports no
    // claim at all: build fails, code is fixed, build passes. "`npm test`
    // succeeded where `npm test` failed" is incoherent, and "`npm test` fails"
    // has just been disproved by the same pair. Both would be junk with a
    // confidence number attached, and a ceiling cannot rescue a claim whose
    // CONTENT is wrong.
    outcome('npm test', { success: false, output: 'FAIL src/a.test.ts', exit: 1, at: 1 });
    outcome('npm test', { success: true, output: 'ok', exit: 0, at: 2 });

    expect(run().candidates).toEqual([]);
  });

  it('classifies failure from `success`, not from an exit code no MCP tool reports', () => {
    // `exit` is null unless the client reported an integer, and MCP tools never
    // do. A detector keyed on `exit !== 0` would be inert for most clients.
    outcome('deploy', { success: false, output: 'connection refused by host', at: 1 });
    outcome('deploy --retry', { success: true, at: 2 });

    const candidates = run().candidates;
    expect(candidates.map((c) => c.type)).toContain('command');
    expect(candidates.every((c) => c.evidence.includes('exit'))).toBe(false);
  });

  it('pairs the NEAREST preceding failure, not the first of the session', () => {
    outcome('deploy', { success: false, output: 'dns failure on first host', at: 1 });
    outcome('deploy --wait', { success: false, output: 'timed out waiting for lock', at: 2 });
    outcome('deploy --retry', { success: true, at: 3 });

    const command = run().candidates.find((c) => c.type === 'command');
    expect(command.claim).toContain('`deploy --wait` failed');
  });

  it('drops the failure finding when the client captured no error text', () => {
    // "`deploy` failed with:" and nothing after the colon is a finding that
    // carries no information and still costs injection budget.
    outcome('deploy', { success: false, output: null, at: 1 });
    outcome('deploy --retry', { success: true, at: 2 });

    expect(run().candidates.map((c) => c.type)).toEqual(['command']);
  });

  it('does not pair two different scripts behind the same runner', () => {
    // `npm run build` and `npm run test` are not the same attempt, and pairing
    // them would produce "`npm run test` succeeded where `npm run build`
    // failed" -- a claim that is simply false.
    outcome('npm run build', { success: false, output: 'TS2345 in src/a.ts', at: 1 });
    outcome('npm run test', { success: true, at: 2 });

    expect(run().candidates).toEqual([]);
  });

  it('caps a code-sensitive transition lower than a command one', () => {
    // A test or build going red-to-green is usually explained by the code
    // changing between the runs, not by the command line.
    outcome('deploy', { success: false, output: 'connection refused by host', at: 1 });
    outcome('deploy --retry', { success: true, at: 2 });
    outcome('npm run build', { success: false, output: 'TS2345 in src/a.ts', at: 3 });
    outcome('npm run build --force', { success: true, at: 4 });

    const byDerivation = new Map(
      run().candidates.map((c) => [c.derivedBy, c.confidence])
    );
    expect(byDerivation.get('command-transition')).toBe(CONFIDENCE.command);
    expect(byDerivation.get('test-transition')).toBe(CONFIDENCE.test);
  });
});

describe('user corrections, without a model', () => {
  it('derives a feedback finding from a correcting turn in the local archive', () => {
    archiveTurns('s', [
      { role: 'user', text: 'add a test for the parser' },
      { role: 'assistant', text: 'done', tools: [] },
      { role: 'user', text: 'no, use npm test rather than npx jest' },
    ]);

    const feedback = run().candidates.filter((c) => c.type === 'feedback');
    expect(feedback.length).toBe(1);
    expect(feedback[0].claim).toBe('no, use npm test rather than npx jest');
    expect(feedback[0].confidence).toBe(CONFIDENCE.correction);
  });

  it('never promotes a guessed correction to human origin', () => {
    // `writeHarvested` grants ORIGIN_HUMAN to a finding carrying a verbatim
    // quote, and the standing layer injects human-origin claims on EVERY turn.
    // The quote here is genuinely verbatim, but whether the turn was a
    // correction at all is a lexical guess, and a guess must not buy always-on
    // injection.
    archiveTurns('s', [{ role: 'user', text: "don't commit straight to master" }]);

    const [feedback] = run().candidates.filter((c) => c.type === 'feedback');
    expect(feedback.origin).toBeUndefined();
    expect(feedback.quote).toBeUndefined();
  });

  it('ignores an ordinary instruction, which is most of a transcript', () => {
    archiveTurns('s', [
      { role: 'user', text: 'please refactor the parser into two functions' },
    ]);

    expect(run().candidates).toEqual([]);
  });
});

describe('re-read churn', () => {
  it('reports churn as an observation and never as a finding', () => {
    // It describes OUR OWN reading behaviour, not the code. Filed as a `map` it
    // would take the hottest files in the project as anchors -- the ones that
    // already carry real findings -- and compete with them for the injection
    // budget while saying nothing a future agent could act on.
    for (const at of [1, 2, 3]) {
      record(dir, { kind: 'read', anchor: '/src/hot.ts', sessionId: 's', fp: 'x', tokens: 100, at });
    }

    const { candidates, observations } = run();
    expect(candidates).toEqual([]);
    expect(observations.map((o) => o.kind)).toEqual(['churn']);
    expect(observations[0]).toMatchObject({
      anchor: '/src/hot.ts',
      repeats: 2,
      wasteful: 2,
      confidence: CONFIDENCE.churn,
    });
  });

  it('reports nothing for a file that was re-read because it CHANGED', () => {
    // Re-reading a file you have just edited is correct behaviour. Counting it
    // is how the first version of this measurement turned 213,651 confirmed
    // tokens into a 14.6M headline, and an observation that cannot tell the two
    // apart is the same defect one layer up.
    record(dir, { kind: 'read', anchor: '/src/edited.ts', sessionId: 's', fp: 'a', tokens: 100, at: 1 });
    record(dir, { kind: 'read', anchor: '/src/edited.ts', sessionId: 's', fp: 'b', tokens: 100, at: 2 });
    record(dir, { kind: 'read', anchor: '/src/edited.ts', sessionId: 's', fp: 'c', tokens: 100, at: 3 });

    expect(run().observations).toEqual([]);
  });
});

describe('the contract the caller relies on', () => {
  it('caps confidence per detector so a heuristic cannot outrank an observation', () => {
    expect(CONFIDENCE.command).toBeGreaterThan(CONFIDENCE.test);
    expect(CONFIDENCE.test).toBeGreaterThan(CONFIDENCE.correction);
    expect(CONFIDENCE.correction).toBeGreaterThan(CONFIDENCE.churn);
  });

  it('carries no secret from captured output into a derived claim', () => {
    // END TO END, and honest about WHERE the guarantee comes from: captured
    // output is redacted at the `recordToolOutcome` boundary, so by the time a
    // detector sees it the secret is already gone. Mutating derive's own
    // `redact` away does NOT break this test, which is exactly why the two
    // below exist -- this one would otherwise read as proof of a guard it does
    // not exercise.
    outcome('deploy', { success: false, output: 'API_TOKEN=abcdef123456', at: 1 });
    outcome('deploy --retry', { success: true, output: 'ok', at: 2 });

    const { candidates } = run();
    // The pair must actually have been detected, or this asserts nothing.
    expect(candidates.map((c) => c.type)).toContain('failure');
    expect(JSON.stringify(candidates)).not.toContain('abcdef123456');
  });

  it('redacts a secret in the COMMAND TEXT, which no boundary redacts', () => {
    // `recordToolOutcome` redacts `output`. It does NOT redact `anchor`, and the
    // anchor IS the command -- so a token passed on a command line reaches the
    // claim through a path nothing upstream cleans. A claim is injected into
    // model context and exported to markdown, two more places than the terminal
    // it came from.
    outcome('deploy --key=sk-abcdef1234567890', { success: false, output: 'nope, denied', at: 1 });
    outcome('deploy --retry', { success: true, at: 2 });

    const { candidates } = run();
    expect(candidates.map((c) => c.type)).toContain('command');
    expect(JSON.stringify(candidates)).not.toContain('sk-abcdef1234567890');
  });

  it('redacts a secret a user pasted into a correcting turn', () => {
    // The archive is never transmitted, but a claim derived FROM it is injected
    // and exported. Nothing redacts the archive on the way in.
    archiveTurns('s', [
      { role: 'user', text: 'no, use AWS_SECRET_ACCESS_KEY=abcdef123456 instead' },
    ]);

    const { candidates } = run();
    expect(candidates.map((c) => c.type)).toContain('feedback');
    expect(JSON.stringify(candidates)).not.toContain('abcdef123456');
  });

  it('writes nothing, and stores nothing, on its own', () => {
    // Selection and storage belong to the caller, under a budget.
    outcome('deploy', { success: false, output: 'connection refused by host', at: 1 });
    outcome('deploy --retry', { success: true, at: 2 });

    expect(run().written).toEqual([]);
  });

  it('threads the authoritative session id back untouched', () => {
    // `writeHarvested` needs it to resolve the `answers` edge: `taskForAnchors`
    // returns null without one, so an unverified string produces no edge at all.
    // It is never defaulted from `sessionId`, which would promote any caller's
    // string to trusted.
    expect(run({ authoritativeSessionId: 'hook-payload-id' }).authoritativeSessionId)
      .toBe('hook-payload-id');
    expect(run().authoritativeSessionId).toBeNull();
  });

  it('derives nothing without a project root to anchor to', () => {
    // An unanchored finding cannot be invalidated and is refused downstream, so
    // emitting one would only spend the caller's budget on junk.
    outcome('deploy', { success: false, output: 'connection refused by host', at: 1 });
    outcome('deploy --retry', { success: true, at: 2 });

    expect(derive(dir, { sessionId: 's' }).candidates).toEqual([]);
  });

  it('derives one candidate for a lesson observed twice', () => {
    outcome('deploy', { success: false, output: 'connection refused by host', at: 1 });
    outcome('deploy --retry', { success: true, at: 2 });
    outcome('deploy', { success: false, output: 'connection refused by host', at: 3 });
    outcome('deploy --retry', { success: true, at: 4 });

    expect(run().candidates.filter((c) => c.type === 'command').length).toBe(1);
  });

  it('writes nothing when there is nothing to derive', () => {
    expect(run().candidates).toEqual([]);
  });

  it('never throws, because it runs at session end', () => {
    record(dir, { kind: 'tool-outcome', surface: 'command', anchor: null, success: null, output: null, at: 1 });
    record(dir, { kind: 'read', anchor: null, at: 2 });
    expect(() => run()).not.toThrow();
    expect(() => derive(null, null)).not.toThrow();
    expect(() => derive(dir)).not.toThrow();
  });
});

describe('wired at session end', () => {
  it('runs from a real client Stop hook, not just from its own test', () => {
    // THE DEFECT THIS PROJECT HAS SHIPPED TWICE is correct code nothing calls:
    // `forTouch` had 27 passing tests and no production call site, and the
    // semantic harvest before it had the same shape. `derive` is the only
    // finding producer on a machine without a credential, so being reachable is
    // not a lint detail here -- unwired, the graph stays at one finding.
    const workspace = mkdtempSync(join(tmpdir(), 'der-stop-'));
    const wiki = join(workspace, '.wiki');
    mkdirSync(wiki, { recursive: true });
    try {
      writeFileSync(
        join(wiki, 'metrics.jsonl'),
        [
          { kind: 'tool-outcome', surface: 'command', anchor: 'deploy', success: false, output: 'connection refused by host', at: 1 },
          { kind: 'tool-outcome', surface: 'command', anchor: 'deploy --retry', success: true, at: 2 },
        ]
          .map((e) => JSON.stringify(e))
          .join('\n') + '\n'
      );

      const result = spawnSync(
        process.execPath,
        [join(process.cwd(), 'integrations', 'cursor', 'hooks', 'stop.mjs')],
        {
          cwd: workspace,
          env: {
            ...process.env,
            TOKEN_OPTIMIZER_STATE_DIR: join(workspace, '.state'),
            TOKEN_OPTIMIZER_WIKI_DIR: wiki,
            TOKEN_OPTIMIZER_SHARED_DIR: join(workspace, '.shared'),
          },
          input: JSON.stringify({ session_id: 'stop-session', cwd: workspace }),
          encoding: 'utf8',
        }
      );
      expect(result.status).toBe(0);

      const derived = readFileSync(join(wiki, 'metrics.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((e) => e.kind === 'derive');
      expect(derived.length).toBe(1);
      // The count, not the candidates: whether a session's own evidence
      // supports any finding at all is the number that says this is working.
      expect(derived[0].candidates).toBeGreaterThan(0);
    } finally {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        /* windows */
      }
    }
  });
});

describe('what counts as the same attempt', () => {
  it('ignores flags, so a retry pairs with the command it retries', () => {
    expect(attemptKey('deploy --retry')).toBe(attemptKey('deploy'));
    expect(attemptKey('npm run build -- --skipLibCheck')).toBe(attemptKey('npm run build'));
  });

  it('keeps two scripts behind one runner apart', () => {
    expect(attemptKey('npm run build')).not.toBe(attemptKey('npm run test'));
  });
});
