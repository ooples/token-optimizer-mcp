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
import { readArchive, transcriptDir, safeName } from '../../hooks-core/transcript.mjs';
import { load, putNode, putEdge, nodeId } from '../../hooks-core/wiki.mjs';
import { indexFile } from '../../hooks-core/staleness.mjs';
import { canonicalPath } from '../../hooks-core/paths.mjs';
import { ORIGIN_HARVESTED, ORIGIN_HUMAN } from '../../hooks-core/curate.mjs';
import { derive, CONFIDENCE, attemptKey, projectAnchor } from '../../hooks-core/derive.mjs';

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

/**
 * A project marker, so the derived anchor RESOLVES.
 *
 * Without one the anchor falls back to the project root, `indexFile` cannot read
 * a directory, and `writeHarvested` correctly refuses every candidate -- which
 * means a storage test written against a bare temp directory asserts `written`
 * is empty and passes whether storage works or not.
 */
const withManifest = () => {
  const manifest = join(dir, 'package.json');
  writeFileSync(manifest, '{"name":"fixture"}');
  return manifest;
};

/** One failed-then-succeeded pair, which yields a command and a failure. */
const onePair = () => {
  outcome('deploy', { success: false, output: 'connection refused by host', at: 1 });
  outcome('deploy --retry', { success: true, at: 2 });
};

const storedFindings = () =>
  [...load(dir).nodes.values()].filter((node) => node.kind === 'finding');

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

describe('storage, under a budget', () => {
  it('stores what it derives, and reports the keys', () => {
    withManifest();
    onePair();

    const { candidates, written } = run();
    expect(candidates.map((c) => c.type).sort()).toEqual(['command', 'failure']);
    expect(written).toHaveLength(2);
    expect(storedFindings().map((f) => f.type).sort()).toEqual(['command', 'failure']);
  });

  it('stamps harvested origin and never human, because these are machine guesses', () => {
    // `curate.mjs` states the reason in its own header: a hand-written assertion
    // and a machine guess look identical three months later, which quietly
    // destroys a reader's ability to calibrate trust. The standing-rules layer
    // selects on human origin to inject on EVERY turn, so this is not a
    // labelling detail.
    withManifest();
    onePair();
    run();

    const stored = storedFindings();
    expect(stored.length).toBeGreaterThan(0);
    for (const finding of stored) {
      expect(finding.origin).toBe(ORIGIN_HARVESTED);
      expect(finding.origin).not.toBe(ORIGIN_HUMAN);
      expect(finding.quote).toBeUndefined();
    }
  });

  it('the budget bounds one session, so a long afternoon cannot fill the graph', () => {
    // THE RISK THIS CLOSES. `selectForConsolidation` had no caller, so nothing
    // bounded what a session added -- and everything stored competes for the
    // 500-token per-command injection budget of every session afterwards,
    // forever. 120 pairs is an ordinary long day of failing commands.
    withManifest();
    for (let i = 0; i < 120; i += 1) {
      outcome(`cmd${i} alpha`, { success: false, output: `error number ${i} happened here`, at: i * 2 + 1 });
      outcome(`cmd${i} alpha --fix`, { success: true, at: i * 2 + 2 });
    }

    const { candidates, written, selectedTokens } = run();
    expect(candidates.length).toBeGreaterThan(100);
    expect(written.length).toBeGreaterThan(0);
    expect(written.length).toBeLessThan(candidates.length);
    expect(selectedTokens).toBeLessThanOrEqual(1000);
  });

  it('admits dead ends on the floor when the budget is too small for ranking', () => {
    // Cheap to find is not cheap to find AGAIN: a negative result exists nowhere
    // else, not in the code and not in the commit log. Ranking alone would drop
    // it, so `failure` is admitted before scoring -- which is visible only when
    // the budget is tight enough that ranking would otherwise have decided.
    withManifest();
    for (let i = 0; i < 40; i += 1) {
      outcome(`cmd${i} alpha`, { success: false, output: `error number ${i} happened here`, at: i * 2 + 1 });
      outcome(`cmd${i} alpha --fix`, { success: true, at: i * 2 + 2 });
    }

    const previous = process.env.TOKEN_OPTIMIZER_DERIVE_BUDGET;
    process.env.TOKEN_OPTIMIZER_DERIVE_BUDGET = '60';
    try {
      run();
    } finally {
      if (previous === undefined) delete process.env.TOKEN_OPTIMIZER_DERIVE_BUDGET;
      else process.env.TOKEN_OPTIMIZER_DERIVE_BUDGET = previous;
    }

    const types = storedFindings().map((f) => f.type);
    expect(types.length).toBeGreaterThan(0);
    // Every survivor is a dead end: the floor spent the budget before ranking
    // ever ran, which is the design's stated ordering rather than an accident.
    expect([...new Set(types)]).toEqual(['failure']);
  });

  it('refuses a candidate whose anchor cannot be indexed, rather than weakening the rule', () => {
    // No manifest, so the anchor falls back to the project ROOT -- and
    // `indexFile` returns null for a directory, so nothing can ever be checked
    // against it. An un-indexable anchor is an un-invalidatable claim, and
    // `writeHarvested` refuses it. Deriving the candidate and storing none of it
    // is the correct outcome, which is why the count and the storage are both
    // asserted: `written` being empty proves nothing on its own.
    onePair();

    const { candidates, written } = run();
    expect(candidates.length).toBeGreaterThan(0);
    expect(written).toEqual([]);
    expect(storedFindings()).toEqual([]);
  });

  it('anchors to the file that declares the project commands, not to the directory', () => {
    const manifest = withManifest();
    onePair();

    expect(projectAnchor(dir)).toBe(manifest);
    expect(run().candidates[0].anchors).toEqual([manifest]);
  });

  it('picks the same .NET anchor on every host, so one finding is not two nodes', () => {
    // readdir order is not stable across hosts, and an anchor that varies by host
    // splits one claim into two graph nodes that can never merge.
    writeFileSync(join(dir, 'Zed.sln'), '');
    writeFileSync(join(dir, 'Alpha.sln'), '');
    expect(projectAnchor(dir)).toBe(join(dir, 'Alpha.sln'));
  });

  it('a second session deriving the same lesson enriches one node instead of adding another', () => {
    // THE BLOAT PATH THIS SETTLES. The commonest real case is the same command
    // failing and being fixed the same way twice -- a graph that files one
    // finding per session about one fact grows without bound and spends the
    // injection budget saying the same thing N times. `writeHarvested`
    // fingerprints the claim and returns the EXISTING key, so the second session
    // adds edges and no node.
    withManifest();
    onePair();

    const first = derive(dir, { sessionId: 's1', projectRoot: dir });
    const second = derive(dir, { sessionId: 's2', projectRoot: dir });

    expect(first.written.length).toBeGreaterThan(0);
    expect(second.written).toEqual(first.written);
    expect(storedFindings()).toHaveLength(first.written.length);
  });

  it('makes the `answers` edge fire on a default install, given an authoritative id', () => {
    // The edge is DECLARED in EDGE_KINDS and its only other producer is
    // credential-gated, so it fired nowhere on a machine without an API key.
    // `taskForAnchors` needs an id from a channel the caller does not control
    // AND a session task that covered every anchor -- both, not either.
    const manifest = withManifest();
    onePair();
    indexFile(dir, manifest);
    putEdge(
      dir,
      putNode(dir, { kind: 'task', key: 'hook-payload-id' }),
      'derived_from',
      nodeId('file', canonicalPath(manifest))
    );

    run({ authoritativeSessionId: 'hook-payload-id' });
    expect(load(dir).edges.filter((e) => e.edge === 'answers').length).toBeGreaterThan(0);
  });

  it('writes no `answers` edge from a session id nothing cross-checked', () => {
    // An unverified string must not buy provenance. `sessionId` alone is a
    // model-typed argument everywhere except a hook payload.
    const manifest = withManifest();
    onePair();
    indexFile(dir, manifest);
    putEdge(
      dir,
      putNode(dir, { kind: 'task', key: 's' }),
      'derived_from',
      nodeId('file', canonicalPath(manifest))
    );

    run();
    expect(load(dir).edges.filter((e) => e.edge === 'answers')).toEqual([]);
  });

  it('finishes the session when the storage step itself throws', () => {
    // FAULT INJECTED WHERE IT ACTUALLY LANDS, not somewhere harmless. The first
    // version of this passed a number as the project root, which merely failed
    // to resolve -- nothing threw, so deleting the try/catch around storage did
    // not fail the test. An anchor whose `String()` throws raises inside
    // `selectForConsolidation`, which is the storage step, and storage is the
    // last thing a finished session does: a graph write that fails must not turn
    // a completed session into a hook error.
    withManifest();
    onePair();
    const hostile = {
      toString() {
        throw new Error('anchor cannot be stringified');
      },
    };
    let result;
    expect(() => {
      result = derive(dir, { sessionId: 's', projectRoot: hostile });
    }).not.toThrow();
    expect(result.written).toEqual([]);
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

/**
 * The Claude Code Stop path, end to end, asserted on STORAGE.
 *
 * A CANDIDATE COUNT IS NOT A FINDING. The test above proves `derive` is reached
 * from a generated client entry and records a count; it deliberately does not
 * prove anything landed, and its own workspace has no project marker, so the
 * anchor falls back to the directory, `indexFile` returns null, and nothing is
 * stored. That is exactly the failure mode Task 4 found by measuring: healthy
 * counts, empty graph. So this asserts the node in the graph.
 *
 * AND IT USES CLAUDE CODE'S OWN ENTRY. Claude Code is the client most users are
 * on, and its Stop hook is a separate file from the generated ones -- so a
 * regression that unregisters or rewrites it is invisible to a test that spawns
 * cursor's. That is not hypothetical here: #300 replaced `stop-harvest.mjs` with
 * `stop.mjs` in `hooks.json` and the archive call inside the old entry was lost
 * with it, silently, for every Claude Code user.
 */
describe('through the Claude Code Stop hook', () => {
  const stopHook = (workspace, wiki, payload) =>
    spawnSync(
      process.execPath,
      [join(process.cwd(), 'plugin', 'hooks', 'stop.mjs')],
      {
        cwd: workspace,
        env: {
          ...process.env,
          TOKEN_OPTIMIZER_STATE_DIR: join(workspace, '.state'),
          TOKEN_OPTIMIZER_WIKI_DIR: wiki,
          TOKEN_OPTIMIZER_SHARED_DIR: join(workspace, '.shared'),
        },
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 60_000,
      }
    );

  /**
   * A workspace shaped like a real project, because every discipline in the
   * pipeline is a real check: a VCS root (`writeHarvested` refuses an anchor
   * with no ancestor), and a manifest (`projectAnchor` needs a FILE).
   */
  const project = () => {
    const workspace = mkdtempSync(join(tmpdir(), 'der-cc-'));
    mkdirSync(join(workspace, '.git'), { recursive: true });
    writeFileSync(join(workspace, 'package.json'), '{"name":"fixture"}');
    const wiki = join(workspace, '.wiki');
    mkdirSync(wiki, { recursive: true });
    return { workspace, wiki };
  };

  const evidence = (wiki) =>
    writeFileSync(
      join(wiki, 'metrics.jsonl'),
      [
        { kind: 'tool-outcome', surface: 'command', anchor: 'deploy', success: false, output: 'connection refused by host', at: 1 },
        { kind: 'tool-outcome', surface: 'command', anchor: 'deploy --retry', success: true, at: 2 },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n'
    );

  it('leaves findings in the graph, not just a count in the log', () => {
    const { workspace, wiki } = project();
    try {
      evidence(wiki);

      const result = stopHook(workspace, wiki, {
        session_id: 'cc-session',
        cwd: workspace,
      });
      expect(result.status).toBe(0);

      const findings = [...load(wiki).nodes.values()].filter(
        (node) => node.kind === 'finding'
      );
      expect(findings.length).toBeGreaterThan(0);
      // Anchored to the manifest, which is what makes them invalidatable --
      // and what distinguishes a stored finding from one refused for having an
      // anchor nothing can ever re-check.
      expect(
        load(wiki).edges.some(
          (edge) =>
            edge.edge === 'derived_from' &&
            edge.to === nodeId('file', canonicalPath(join(workspace, 'package.json')))
        )
      ).toBe(true);
    } finally {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        /* windows */
      }
    }
  });

  it('archives the session transcript, which #300 stopped doing', () => {
    // THE ARCHIVE IS WHAT SURVIVES THE SESSION. `derive`'s correction detector
    // reads it first and falls back to the live transcript; `lessons.mjs` can
    // verify a verbatim quote against nothing else, and that verification is
    // the only route to a human-origin finding. Losing it failed silently,
    // because an empty archive and an unarchived session are the same value.
    const { workspace, wiki } = project();
    const transcript = join(workspace, 'session.jsonl');
    try {
      writeFileSync(
        transcript,
        [
          { type: 'user', message: { role: 'user', content: 'add a test for the parser' } },
          { type: 'user', message: { role: 'user', content: 'no, use npm test rather than npx jest' } },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n') + '\n'
      );

      const result = stopHook(workspace, wiki, {
        session_id: 'cc-archive',
        cwd: workspace,
        transcript_path: transcript,
      });
      expect(result.status).toBe(0);

      const archived = readArchive(wiki, 'cc-archive');
      expect(archived.map((turn) => turn.text)).toContain(
        'no, use npm test rather than npx jest'
      );
      // And the archive is immediately useful: the correction detector reads it
      // in the same hook run, so the turn becomes a finding without a model.
      const feedback = [...load(wiki).nodes.values()].filter(
        (node) => node.kind === 'finding' && node.type === 'feedback'
      );
      expect(feedback.length).toBeGreaterThan(0);
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
