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
import { record, recordToolOutcome, readMetrics } from '../../hooks-core/metrics.mjs';
import {
  readArchive,
  transcriptDir,
  safeName,
  failedResultsFromTranscript,
} from '../../hooks-core/transcript.mjs';
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

/**
 * FAILED TOOL RESULTS, WHICH ARRIVE ONLY IN THE TRANSCRIPT.
 *
 * Claude Code never fires PostToolUse for a failed tool call -- 2,238 of 2,238
 * live `tool-outcome` events on the measuring machine carry `success: true` --
 * so the two strongest detectors above had NO INPUT AT ALL on the primary
 * client. These fixtures are transcribed from real transcript lines rather than
 * invented: `type: 'assistant'` with a `tool_use` block carrying
 * `input.command`, then `type: 'user'` with a `tool_result` block carrying
 * `is_error: true` and a STRING `content` beginning `Exit code N`. Three
 * consecutive tasks on these plans shipped extractors whose fixtures did not
 * match production, which is the specific mistake these shapes exist to avoid.
 */
const transcriptFile = (lines) => {
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
};

/** An assistant turn issuing a tool call, exactly as Claude Code records one. */
const toolUse = (id, command, at) => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'x' } }],
  },
  timestamp: at,
});

/** The result turn. `content` is a bare string; the error flag is `is_error`. */
const toolResult = (id, content, at) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', content, is_error: true, tool_use_id: id }],
  },
  timestamp: at,
  toolUseResult: `Error: ${content}`,
});

describe('a failure that exists only in the transcript', () => {
  it('reads a failed Bash result the way Claude Code actually writes one', () => {
    const path = transcriptFile([
      toolUse('toolu_1', 'npm test', '2026-08-26T10:00:00.000Z'),
      toolResult('toolu_1', 'Exit code 1\nFAIL src/a.test.ts', '2026-08-26T10:00:01.000Z'),
    ]);

    const failures = failedResultsFromTranscript(path);
    expect(failures).toHaveLength(1);
    expect(failures[0].command).toBe('npm test');
    expect(failures[0].exit).toBe(1);
    expect(failures[0].toolCallId).toBe('toolu_1');
    // The exit line is stripped: `exit` carries it structurally, and leaving it
    // in makes every failure claim read "failed with: Exit code 1".
    expect(failures[0].output).toBe('FAIL src/a.test.ts');
  });

  it('refuses every is_error shape where the command never RAN', () => {
    // MEASURED, NOT ASSUMED. Across three real transcripts 214 results carried
    // `is_error: true` and only 83 were a command exiting non-zero. The other
    // 131 are hook denials, protocol errors and human refusals -- and the
    // largest group by far is THIS optimizer's own PreToolUse text. Ingesting
    // those would have the tool derive 0.9-confidence findings from its own
    // advice and serve them back as observations about the project.
    const path = transcriptFile([
      toolUse('a', 'grep -rn foo .', '2026-08-26T10:00:00.000Z'),
      toolResult(
        'a',
        'Recursive shell searches return unbounded output. Call the token-optimizer MCP tool smart_grep instead',
        '2026-08-26T10:00:01.000Z'
      ),
      toolUse('b', 'rm -rf build', '2026-08-26T10:01:00.000Z'),
      toolResult('b', '<tool_use_error>Blocked: rm -rf build</tool_use_error>', '2026-08-26T10:01:01.000Z'),
      toolUse('c', 'git push --force', '2026-08-26T10:02:00.000Z'),
      toolResult(
        'c',
        "The user doesn't want to proceed with this tool use. The tool use was rejected",
        '2026-08-26T10:02:01.000Z'
      ),
    ]);

    expect(failedResultsFromTranscript(path)).toEqual([]);
  });

  it('redacts the failure output, which no capture boundary ever saw', () => {
    // `recordToolOutcome` redacts `output` at its boundary. Transcript text has
    // never passed one -- that boundary never saw it -- and this text is bound
    // for a claim that is injected into model context and exported to markdown.
    const path = transcriptFile([
      toolUse('toolu_1', 'npm publish', '2026-08-26T10:00:00.000Z'),
      toolResult(
        'toolu_1',
        'Exit code 1\nunauthorized: token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
        '2026-08-26T10:00:01.000Z'
      ),
    ]);

    const [failure] = failedResultsFromTranscript(path);
    expect(failure.output).not.toContain('ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(failure.output).toContain('[redacted]');
  });

  it('produces the SAME attempt key as the event for one command', () => {
    // THE JOIN, AND THE ONE THING THAT MAKES PAIRING POSSIBLE AT ALL. An event
    // stores the command truncated to 120 characters; `attemptKey` reads three
    // non-flag tokens off whatever it is handed. A long token cut by that cap
    // yields a DIFFERENT key from the untruncated transcript copy, so the
    // failure would land in a group of its own and never meet a success.
    // Measured on one real session: truncating here made 266 of 266 keys agree
    // where the untruncated text agreed on only 240.
    const long = `node ${'x'.repeat(200)}.mjs --flag`;
    outcome(long, { success: true, at: 2 });
    const stored = readMetrics(dir).find((e) => e.kind === 'tool-outcome').anchor;
    const path = transcriptFile([
      toolUse('toolu_1', long, '2026-08-26T10:00:00.000Z'),
      toolResult('toolu_1', 'Exit code 1\nboom', '2026-08-26T10:00:01.000Z'),
    ]);

    const [failure] = failedResultsFromTranscript(path);
    expect(attemptKey(failure.command)).toBe(attemptKey(stored));
  });

  it('pairs a transcript failure with an event success, which is the whole point', () => {
    withManifest();
    outcome('deploy --retry', { success: true, at: 2000 });
    const path = transcriptFile([
      toolUse('toolu_1', 'deploy', '1970-01-01T00:00:01.000Z'),
      toolResult('toolu_1', 'Exit code 1\nconnection refused by host', '1970-01-01T00:00:01.000Z'),
    ]);

    const candidates = run({ transcriptPath: path }).candidates;
    const command = candidates.find((c) => c.type === 'command');
    const failure = candidates.find((c) => c.type === 'failure');
    expect(command.claim).toContain('`deploy --retry` succeeded in this project where `deploy` failed');
    expect(command.confidence).toBe(CONFIDENCE.command);
    expect(failure.claim).toContain('connection refused by host');
  });

  it('deduplicates one failure reported twice on the CALL ID alone', () => {
    // On the ten clients that DO report failures, the same failure arrives from
    // both sources. `toolCallId` is the SAME STRING in both -- `episodeMeta`
    // reads the transcript's `tool_use_id` into it -- so the event copy wins
    // and the transcript copy is dropped before grouping. Without that, the two
    // copies sit in one run and the second is paired against the first as a
    // failed-then-succeeded story about itself.
    //
    // THE TIMESTAMPS ARE HOURS APART ON PURPOSE. With them equal the text-and-
    // time fallback below ALSO dedupes the pair, so disabling the id check
    // changed nothing and this test passed while asserting nothing about the id.
    // That is the two-mechanisms-in-one-fixture defect this plan has hit on
    // three consecutive tasks.
    // AND THE TWO COPIES SAY DIFFERENT THINGS, which is what makes this
    // observable at all. A duplicated failure never produces a second PAIR --
    // the nearest-preceding-failure rule just overwrites one with the other --
    // so a count assertion alone passes with the deduplication removed. What
    // changes is WHICH copy gets quoted, and the event copy is the one that
    // passed `recordToolOutcome`'s redaction and 4 KB cap.
    withManifest();
    recordToolOutcome(dir, {
      kind: 'tool-outcome',
      surface: 'command',
      anchor: 'deploy',
      toolCallId: 'toolu_1',
      success: false,
      output: 'connection refused by host',
      at: 1000,
    });
    outcome('deploy --retry', { success: true, at: 9_000_000 });
    const path = transcriptFile([
      toolUse('toolu_1', 'deploy', '1970-01-01T02:00:00.000Z'),
      toolResult('toolu_1', 'Exit code 7\nDNS lookup failed', '1970-01-01T02:00:00.000Z'),
    ]);

    const candidates = run({ transcriptPath: path }).candidates;
    const commands = candidates.filter((c) => c.type === 'command');
    expect(commands).toHaveLength(1);
    expect(commands[0].claim).not.toContain('`deploy` succeeded');
    const failures = candidates.filter((c) => c.type === 'failure');
    expect(failures).toHaveLength(1);
    expect(failures[0].claim).toContain('connection refused by host');
    expect(failures[0].claim).not.toContain('DNS lookup failed');
  });

  it('deduplicates on text and time when the client reported no call id', () => {
    // The fallback, isolated the same way: no `toolCallId` on either side, so
    // only identical command text within two seconds can collapse the pair.
    // Nothing re-runs a command that fast, so one text at one instant is one
    // failure recorded twice rather than two failures.
    withManifest();
    outcome('deploy', { success: false, output: 'connection refused by host', at: 1000 });
    outcome('deploy --retry', { success: true, at: 9_000_000 });
    const path = transcriptFile([
      toolUse('toolu_1', 'deploy', '1970-01-01T00:00:01.000Z'),
      toolResult('toolu_1', 'Exit code 1\nconnection refused by host', '1970-01-01T00:00:01.000Z'),
    ]);

    const commands = run({ transcriptPath: path }).candidates.filter((c) => c.type === 'command');
    expect(commands).toHaveLength(1);
    expect(commands[0].claim).not.toContain('`deploy` succeeded');
  });

  it('claims nothing about a command that spans lines, which is a script', () => {
    // THE MEASUREMENT THAT FORCED THIS REFUSAL. Wiring the reader produced four
    // candidates at 0.9 confidence on this session, every one of them quoting a
    // truncated multi-line shell script -- and then 0 of 83 captured command
    // failures across three real transcripts turned out to be single-line and
    // inside the 120-character cap (29 of 30 in one transcript were multi-line).
    // A claim whose subject is a fragment of a program is not a weaker claim, it
    // is not a claim, so this sits beside the identical-text guard rather than
    // taking a lower ceiling.
    //
    // SHORT ON PURPOSE. Both commands are well inside 120 characters, so the
    // length half of the rule cannot be what refuses them -- otherwise removing
    // either half leaves the other and this passes having tested neither.
    withManifest();
    outcome('cd sub\nnpm run ship', { success: true, at: 2000 });
    const path = transcriptFile([
      toolUse('toolu_1', 'cd sub\nnpm run build', '1970-01-01T00:00:01.000Z'),
      toolResult('toolu_1', 'Exit code 1\nSyntaxError: missing )', '1970-01-01T00:00:01.000Z'),
    ]);

    const derived = run({ transcriptPath: path }).candidates;
    expect(derived.filter((c) => c.type === 'command' || c.type === 'failure')).toEqual([]);
  });

  it('claims nothing about a command the 120-char anchor cap already cut', () => {
    // The other half, isolated: one line each, both long enough that the anchor
    // truncation reached them. A reader cannot act on a command whose text stops
    // mid-argument, and a bigger cap would not help -- the whole script is no
    // more actionable than its first 120 characters.
    // THE TWO COMMANDS SHARE AN ATTEMPT KEY ON PURPOSE. Written as
    // `node scripts/build.mjs ...` against `node scripts/ship.mjs ...` they
    // differ in their SECOND token, so they never met in the first place and the
    // refusal under test was never reached -- the test passed on a key mismatch
    // and survived removing the length rule entirely.
    withManifest();
    const long = (reporter) =>
      `npm run build -- --reporter=${reporter} ${'--pad=x '.repeat(20)}`.trim();
    expect(long('json').length).toBeGreaterThan(120);
    expect(attemptKey(long('json'))).toBe(attemptKey(long('verbose')));
    outcome(long('json'), { success: true, at: 2000 });
    const path = transcriptFile([
      toolUse('toolu_1', long('verbose'), '1970-01-01T00:00:01.000Z'),
      toolResult('toolu_1', 'Exit code 1\nENOENT', '1970-01-01T00:00:01.000Z'),
    ]);

    const derived = run({ transcriptPath: path }).candidates;
    expect(derived.filter((c) => c.type === 'command' || c.type === 'failure')).toEqual([]);
  });

  it('claims nothing when the attempt key never reached a command', () => {
    // `attemptKey` spends three non-flag tokens on identity, and the habit here
    // is `cd <absolute path> && <the real command>` -- which spends all three on
    // `cd`, the path and `&&`. This project's own evidence: the single key
    // `cd c:/users/.../token-optimizer-mcp &&` covers 539 DISTINCT command
    // lines, so a pair drawn from that group compares two unrelated commands and
    // is false about both. Both sides here are single-line and well inside 120
    // characters, so `quotable` cannot be what refuses them.
    withManifest();
    const failing = 'cd repo && git merge origin/master';
    const succeeding = 'cd repo && grep -n foo lib.mjs';
    expect(attemptKey(failing)).toBe(attemptKey(succeeding));
    outcome(succeeding, { success: true, at: 2000 });
    const path = transcriptFile([
      toolUse('toolu_1', failing, '1970-01-01T00:00:01.000Z'),
      toolResult('toolu_1', 'Exit code 1\nCONFLICT', '1970-01-01T00:00:01.000Z'),
    ]);

    const derived = run({ transcriptPath: path }).candidates;
    expect(derived.filter((c) => c.type === 'command' || c.type === 'failure')).toEqual([]);
  });

  it('scans a bounded tail, so session end cannot be turned into real work', () => {
    // A transcript is the largest file this project reads -- 45 MB on this
    // machine -- and `archive()` already reads the whole thing at Stop.
    const lines = [];
    for (let i = 0; i < 400; i++) {
      lines.push(toolUse(`old${i}`, `cmd${i} ${'p'.repeat(200)}`, '2026-08-26T09:00:00.000Z'));
      lines.push(toolResult(`old${i}`, 'Exit code 1\nold failure', '2026-08-26T09:00:01.000Z'));
    }
    lines.push(toolUse('recent', 'npm test', '2026-08-26T10:00:00.000Z'));
    lines.push(toolResult('recent', 'Exit code 1\nrecent failure', '2026-08-26T10:00:01.000Z'));
    const path = transcriptFile(lines);

    // `max` is raised beyond anything the file holds so the COUNT cap cannot be
    // what bounds this: only the byte cap can. Left at its default of 50 the
    // count cap alone kept the result under 400 and removing the byte bound
    // changed nothing, which is the test-passes-for-the-wrong-reason shape.
    const bounded = failedResultsFromTranscript(path, { scanBytes: 4096, max: 10_000 });
    expect(bounded.length).toBeGreaterThan(0);
    expect(bounded.length).toBeLessThan(20);
    expect(bounded[bounded.length - 1].output).toBe('recent failure');
    // The whole file, for contrast: the bound is doing the work, not the fixture.
    expect(
      failedResultsFromTranscript(path, { scanBytes: 50_000_000, max: 10_000 }).length
    ).toBeGreaterThan(300);
    // And the count cap holds independently of the byte cap.
    expect(failedResultsFromTranscript(path, { max: 5 })).toHaveLength(5);
  });

  it('says nothing about a failure whose tool call it never saw', () => {
    // The command is recoverable ONLY by joining `tool_use_id` back to the
    // assistant block that issued it, and a bounded tail read routinely cuts
    // that block off. With no command there is no subject for a claim, so the
    // result is dropped -- a placeholder would put "`unknown` failed with: ..."
    // into the graph at 0.9 confidence.
    const path = transcriptFile([
      toolResult('toolu_orphan', 'Exit code 1\nboom', '2026-08-26T10:00:01.000Z'),
    ]);

    expect(failedResultsFromTranscript(path)).toEqual([]);
  });

  it('returns nothing rather than throwing when there is no transcript to read', () => {
    // Session end must cost nothing, and a client that reports no transcript
    // path is the common case rather than an error.
    expect(failedResultsFromTranscript(null)).toEqual([]);
    expect(failedResultsFromTranscript(join(dir, 'missing.jsonl'))).toEqual([]);
    writeFileSync(join(dir, 'junk.jsonl'), 'not json\n{"half":\n');
    expect(failedResultsFromTranscript(join(dir, 'junk.jsonl'))).toEqual([]);
  });
});
