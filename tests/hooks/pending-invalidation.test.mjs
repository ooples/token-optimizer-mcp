/**
 * EAGER STALENESS, THROUGH THE HOOKS THAT ACTUALLY SHIP.
 *
 * `invalidateOnWrite` had 27 lines of documentation, its own tests, and one
 * reference in shipped code: a COMMENT in the PreToolUse router saying it ran.
 * It did not. staleness.mjs's header describes two invalidation paths and only
 * one of them existed in production.
 *
 * SO THIS SUITE SPAWNS THE REAL ENTRY POINTS. A test that calls
 * `queueInvalidation` and `drainInvalidations` itself proves nothing about the
 * defect being fixed here -- that defect was precisely a correct function with
 * passing tests and no caller, and three tasks on this branch have already
 * shipped code whose tests passed while the product path went unexercised. The
 * assertions that matter drive `plugin/hooks/post-tool.mjs` with a real Claude
 * Code PostToolUse payload and then `plugin/hooks/pretooluse-router.mjs` with a
 * real Read, and check that the finding comes back MARKED.
 *
 * WHY THE SESSION'S OWN WRITES WERE NOT MERELY DEGRADED BUT UNCOVERED. Lazy
 * staleness compares the anchor's stored hash against disk -- and both hooks
 * call `indexFile` on every file they observe, which re-points that hash at the
 * bytes just written (pretooluse-router.mjs twice, adapter.mjs once). So the
 * lazy check compares a refreshed hash against the disk it came from and finds
 * them equal: a write the agent performed ITSELF cannot be detected at all, and
 * the finding derived from the pre-edit content is served CLEAN.
 *
 * So before the eager path was connected, staleness for a file the agent edited
 * did not work AT ALL -- eager was dead code and lazy was defeated by
 * re-indexing. Not "lazy-only, therefore degraded". Blind.
 *
 * TWO GRADES OF EVIDENCE ARE TESTED. A reconstructable edit yields a real diff;
 * a whole-file write yields a hash comparison and no diff, and the ordering that
 * makes that comparison meaningful -- drain before re-index -- is asserted end
 * to end rather than argued from reading the call sites.
 */
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { load, nodeId, putNodeWithEdges } from '../../hooks-core/wiki.mjs';
import { indexFile } from '../../hooks-core/staleness.mjs';
import { forTouch } from '../../hooks-core/inject.mjs';
import {
  drainInvalidations,
  observedWrites,
  queueInvalidation,
} from '../../hooks-core/pending.mjs';

const ROOT = process.cwd();
const POST_TOOL = join(ROOT, 'plugin', 'hooks', 'post-tool.mjs');
const PRE_TOOL = join(ROOT, 'plugin', 'hooks', 'pretooluse-router.mjs');
const SESSION_START = join(ROOT, 'plugin', 'hooks', 'session-start.mjs');

const BEFORE = 'export function parse(x) {\n  return x.trim();\n}\n';
const AFTER = 'export function parse(x) {\n  return JSON.parse(x);\n}\n';
const CLAIM = 'parse() trims its input before returning';

let project;
let wiki;
let stateDir;
let file;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'pending-proj-'));
  // A repository marker, so projectRootFor lands on this tree rather than
  // walking out of the temp directory.
  mkdirSync(join(project, '.git'), { recursive: true });
  wiki = mkdtempSync(join(tmpdir(), 'pending-wiki-'));
  // PER TEST. Injection is once-per-session per finding and session state lives
  // in a fixed directory keyed by session id, so a shared state directory makes
  // the second RUN of a passing assertion see the finding suppressed.
  stateDir = mkdtempSync(join(tmpdir(), 'pending-state-'));

  file = join(project, 'parser.ts');
  writeFileSync(file, BEFORE);
  indexFile(wiki, file, BEFORE);
  putNodeWithEdges(
    wiki,
    {
      kind: 'finding',
      key: 'parse-trims',
      claim: CLAIM,
      type: 'finding',
      confidence: 0.95,
      origin: 'human',
    },
    [{ edge: 'derived_from', to: nodeId('file', file) }]
  );
});

afterEach(() => {
  for (const dir of [project, wiki, stateDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows can hold a handle briefly */
    }
  }
});

/**
 * Drives one shipped hook exactly as Claude Code does.
 *
 * HOLDOUT PINNED OFF: `forTouch` takes part in a 10% measurement holdout, so an
 * unpinned run would fail roughly one time in ten -- and a suite that fails one
 * run in ten teaches people to re-run it rather than read it.
 */
function hook(entry, payload, { session, arm } = {}) {
  const result = spawnSync(process.execPath, [entry], {
    input: JSON.stringify({ cwd: project, session_id: session, ...payload }),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_WIKI_DIR: wiki,
      TOKEN_OPTIMIZER_SHARED_DIR: wiki,
      TOKEN_OPTIMIZER_STATE_DIR: stateDir,
      TOKEN_OPTIMIZER_HOLDOUT: '0',
      ...(arm ? { TOKEN_OPTIMIZER_EXPERIMENT_ARM: arm } : {}),
    },
    timeout: 30_000,
  });
  expect(result.status).toBe(0);
  let parsed = {};
  try {
    parsed = JSON.parse(result.stdout || '{}');
  } catch {
    throw new Error(
      `hook did not emit JSON: ${result.stdout}\n${result.stderr}`
    );
  }
  return parsed.hookSpecificOutput?.additionalContext ?? '';
}

/** The PostToolUse payload Claude Code sends after a completed Edit. */
const editPayload = (response = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Edit',
  tool_input: {
    file_path: file,
    old_string: 'return x.trim();',
    new_string: 'return JSON.parse(x);',
  },
  tool_response: {
    filePath: file,
    oldString: 'return x.trim();',
    newString: 'return JSON.parse(x);',
    userModified: false,
    ...response,
  },
});

const readPayload = () => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: { file_path: file },
});

/** A whole-file write: the after side is on disk, the before side is nowhere. */
const writePayload = () => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Write',
  tool_input: { file_path: file, content: AFTER },
  tool_response: { filePath: file, type: 'update' },
});

/** An apply_patch program, which names its targets and carries no file_path. */
const PATCH = () =>
  ['*** Begin Patch', `*** Update File: ${file}`, '-a', '+b', '*** End Patch'].join('\n');

const finding = () => load(wiki).nodes.get(nodeId('finding', 'parse-trims'));

describe('a write the hooks observed', () => {
  test('marks the dependent finding, driven through the real PostToolUse hook', () => {
    // The edit has landed: this is the state the hook is invoked in.
    writeFileSync(file, AFTER);

    hook(POST_TOOL, editPayload({ originalFile: BEFORE }), {
      session: 'eager-original',
    });

    const marked = finding();
    expect(marked.stale).toBe(true);
    // MARKED WITH EVIDENCE, which is the invariant staleness.mjs opens with: a
    // stale finding is served, marked, and accompanied by the diff.
    expect(marked.diff).toContain('JSON.parse');
  });

  test('reconstructs the before side when the host sends no original file', () => {
    // Not every client puts the pre-edit file in its response. An edit is a
    // known substitution, so reverting new_string to old_string in the text on
    // disk reproduces the before side exactly.
    writeFileSync(file, AFTER);

    hook(POST_TOOL, editPayload(), { session: 'eager-reconstructed' });

    expect(finding().stale).toBe(true);
  });

  test('is served MARKED on the next read, not as current', () => {
    // THE ASSERTION THIS WHOLE TASK EXISTS FOR. Without the eager path the
    // sequence below serves the claim clean: the post-tool capture re-indexes
    // the anchor, so by this read the stored hash agrees with disk and lazy
    // staleness has nothing left to notice.
    writeFileSync(file, AFTER);
    hook(POST_TOOL, editPayload({ originalFile: BEFORE }), {
      session: 'eager-serve',
    });

    // A different session, because once-per-session-per-finding would suppress
    // a second delivery inside the same one.
    const context = hook(PRE_TOOL, readPayload(), {
      session: 'eager-serve-read',
    });

    expect(context).toContain(CLAIM);
    expect(context).toContain('STALE');
    expect(context).toContain('JSON.parse');
  });
});

describe('the queue defers the graph load rather than paying for it', () => {
  test('survives the write hook and is applied by the next graph read', () => {
    writeFileSync(file, AFTER);
    // The `optimizer` arm has routing on and retrieval off, so nothing in this
    // process reads the graph -- which is exactly the shape the queue exists
    // for: the write hook records what it saw and does not load a megabyte of
    // JSONL on the return path of the call.
    hook(POST_TOOL, editPayload({ originalFile: BEFORE }), {
      session: 'deferred',
      arm: 'optimizer',
    });

    expect(existsSync(join(wiki, 'pending-invalidation.jsonl'))).toBe(true);
    expect(finding().stale).toBeUndefined();

    const context = hook(PRE_TOOL, readPayload(), { session: 'deferred-read' });

    expect(context).toContain('STALE');
    expect(finding().stale).toBe(true);
    // Drained means drained: a record left behind would be re-applied on every
    // tool call for the rest of the session.
    expect(existsSync(join(wiki, 'pending-invalidation.jsonl'))).toBe(false);
  });

  test('a read queues nothing, so the hot path pays a field check and stops', () => {
    hook(
      POST_TOOL,
      { hook_event_name: 'PostToolUse', ...readPayload() },
      { session: 'read-only' }
    );

    expect(existsSync(join(wiki, 'pending-invalidation.jsonl'))).toBe(false);
    expect(finding().stale).toBeUndefined();
  });
});

describe('the grade of evidence a payload can actually support', () => {
  test('a whole-file write yields a path-only record, never a fabricated before', () => {
    // Passing an unknown before side as '' would make invalidateOnWrite see
    // every symbol in the file as changed and mark every finding anchored
    // anywhere in it -- and the eager mark is a stored flag nothing clears.
    writeFileSync(file, AFTER);
    expect(
      observedWrites(
        { tool_name: 'Write', tool_input: { file_path: file, content: AFTER } },
        { tool_response: { filePath: file, type: 'update' } }
      )
    ).toEqual([{ path: file }]);
  });

  test('an edit whose new text now appears more than once falls back to hashes', () => {
    // Ambiguous: reverting the wrong occurrence fabricates a before side that
    // never existed on disk. The path is still worth queueing.
    writeFileSync(file, 'retries = 1;\nretries = 1;\n');
    expect(
      observedWrites(
        {
          tool_name: 'Edit',
          tool_input: { file_path: file, old_string: 'retries = 2;', new_string: 'retries = 1;' },
        },
        {}
      )
    ).toEqual([{ path: file }]);
  });

  test('a rewrite that changed nothing yields no record at all', () => {
    writeFileSync(file, BEFORE);
    expect(
      observedWrites(
        { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'x', new_string: 'x' } },
        { tool_response: { originalFile: BEFORE } }
      )
    ).toEqual([]);
  });

  test('a read yields nothing, however readable the file is', () => {
    expect(
      observedWrites({ tool_name: 'Read', tool_input: { file_path: file } }, {})
    ).toEqual([]);
  });

  test('a patch program with no file_path still yields its targets', () => {
    // Codex and code-mode clients carry the whole patch as program text. The
    // hash grade needs only the path, so those clients are covered too.
    expect(
      observedWrites(
        {
          tool_name: 'Edit',
          tool_input: { command: PATCH() },
        },
        {}
      )
    ).toEqual([{ path: file }]);
  });
});

describe('a whole-file write, which has no before side anywhere', () => {
  test('the anchor is still PRE-write when the drain runs -- verified, not reasoned', () => {
    // THE ORDERING THIS GRADE DEPENDS ON, asserted end to end rather than
    // argued from reading the call sites. If `indexFile` ran before the drain,
    // the stored hash would already agree with disk and nothing below would be
    // marked -- which is exactly how the lazy path fails on the session's own
    // writes.
    //
    // 1. a read, which refreshes the anchor to the PRE-write bytes
    hook(PRE_TOOL, readPayload(), { session: 'order' });
    // 2. the write lands
    writeFileSync(file, AFTER);
    // 3. the write hook, with a payload that carries no before side at all
    hook(POST_TOOL, writePayload(), { session: 'order' });

    const marked = finding();
    expect(marked.stale).toBe(true);
    expect(marked.staleReason).toMatch(/content hash changed/);
    // NO DIFF, and that is honest rather than a shortfall: none is derivable.
    expect(marked.diff).toBe('');
  });

  test('is served as changed-with-no-diff, distinguishable from a real diff', () => {
    hook(PRE_TOOL, readPayload(), { session: 'order-serve' });
    writeFileSync(file, AFTER);
    hook(POST_TOOL, writePayload(), { session: 'order-serve' });

    const context = hook(PRE_TOOL, readPayload(), {
      session: 'order-serve-read',
    });

    expect(context).toContain(CLAIM);
    // The reader can tell "changed, diff unknown" from "changed, here it is".
    expect(context).toContain('no diff could be rebuilt');
    expect(context).toContain('content hash changed');
    expect(context).not.toContain('What changed:');
  });

  test('marks nothing when the bytes did not actually change', () => {
    // The negative control. A path-only record is a QUESTION, not an
    // assertion -- if the hash still matches, the finding stays clean. Without
    // this, coverage would have been bought with false-stale, and the eager
    // mark is permanent until the finding is re-recorded.
    hook(PRE_TOOL, readPayload(), { session: 'unchanged' });
    hook(POST_TOOL, writePayload(), { session: 'unchanged' });

    expect(finding().stale).toBeUndefined();
    const context = hook(PRE_TOOL, readPayload(), { session: 'unchanged-read' });
    expect(context).toContain(CLAIM);
    expect(context).not.toContain('recorded earlier');
  });
});

describe('SessionStart drains before it advertises anything', () => {
  test('a queue left by the last session is applied before the index is built', () => {
    // The worst moment to be wrong: the session index is the first thing a
    // session sees and nothing follows it that could qualify the claim.
    writeFileSync(file, AFTER);
    hook(POST_TOOL, editPayload({ originalFile: BEFORE }), {
      session: 'ss-write',
      arm: 'optimizer',
    });
    expect(finding().stale).toBeUndefined();

    hook(SESSION_START, { hook_event_name: 'SessionStart' }, {
      session: 'ss-start',
    });

    expect(finding().stale).toBe(true);
  });
});

describe('the in-process drain memo, which no spawned hook can exercise', () => {
  // WHY THESE CALL forTouch DIRECTLY. The memo is per PROCESS: it exists so a
  // SECOND caller inside one hook invocation does not serve from a graph copy
  // parsed before the drain. A spawned hook is one caller by construction, so
  // the hazard is invisible from outside the process. forTouch is still the real
  // product function the routers call -- what is skipped here is the spawn, not
  // the code under test. The end-to-end proofs live in the blocks above.
  //
  // The holdout is pinned off per call: forTouch takes part in a 10% withheld
  // arm, which would otherwise fail this roughly one run in ten.
  const PRIOR = process.env.TOKEN_OPTIMIZER_HOLDOUT;
  beforeEach(() => {
    process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
  });
  afterEach(() => {
    if (PRIOR === undefined) delete process.env.TOKEN_OPTIMIZER_HOLDOUT;
    else process.env.TOKEN_OPTIMIZER_HOLDOUT = PRIOR;
  });

  // ONE GRAPH OBJECT, SHARED, which is the whole point: SessionStart parses the
  // graph once and hands the SAME object to standingRules and then sessionIndex.
  // Handing each caller a fresh load would hide the hazard entirely, because a
  // fresh load is already post-drain.
  const touch = (dir, graph) =>
    forTouch(dir, graph, file, {
      sessionId: `memo-${Math.random()}`,
      alreadyInjected: new Set(),
    }) || '';

  test('two spellings of one directory share the memo', () => {
    // A raw-string key would make these two directories, so the second caller
    // would find an empty queue, mark nothing, and serve from the pre-drain copy
    // it was handed -- the exact bug the memo exists to prevent.
    const parsedBeforeAnyDrain = load(wiki);
    queueInvalidation(wiki, { path: file, before: BEFORE, after: AFTER });
    writeFileSync(file, AFTER);

    const first = touch(wiki, parsedBeforeAnyDrain);
    expect(first).toContain(CLAIM);
    expect(first).toContain('STALE');

    // The same directory, spelled three other ways: a trailing separator, a
    // redundant `..` segment, and forward slashes where the platform uses
    // backslashes. Each is handed the SAME pre-drain graph as the first caller.
    for (const spelling of [
      `${wiki}${sep}`,
      `${wiki}${sep}sub${sep}..`,
      wiki.split(sep).join('/'),
    ]) {
      const again = touch(spelling, parsedBeforeAnyDrain);
      expect(again).toContain(CLAIM);
      // Re-read because the memo was found, not served from the stale copy.
      expect(again).toContain('STALE');
    }
  });

  test('a queue arriving after an empty drain is still applied', () => {
    // Memoising the NEGATIVE result would defer this invalidation to a future
    // session. Nothing enforces that queueing precedes injection except the
    // current shape of one hook branch.
    const clean = touch(wiki, load(wiki));
    expect(clean).toContain(CLAIM);
    expect(clean).not.toContain('STALE');
    expect(finding().stale).toBeUndefined();

    queueInvalidation(wiki, { path: file, before: BEFORE, after: AFTER });
    writeFileSync(file, AFTER);

    const marked = touch(wiki, load(wiki));
    expect(marked).toContain('STALE');
    // The drain RAN, rather than being skipped by a remembered negative.
    expect(finding().stale).toBe(true);
  });
});

describe('the drain runs on a hook path, so it cannot throw or repeat', () => {
  test('draining twice does not re-apply', () => {
    queueInvalidation(wiki, { path: file, before: BEFORE, after: AFTER });
    expect(drainInvalidations(wiki, load(wiki))).toBeGreaterThan(0);
    expect(drainInvalidations(wiki, load(wiki))).toBe(0);
  });

  test('a malformed record is skipped rather than thrown on', () => {
    queueInvalidation(wiki, { path: null, before: null, after: null });
    writeFileSync(join(wiki, 'pending-invalidation.jsonl'), 'not json\n{"path":\n');
    expect(() => drainInvalidations(wiki, load(wiki))).not.toThrow();
    expect(existsSync(join(wiki, 'pending-invalidation.jsonl'))).toBe(false);
  });

  test('a queue that does not exist is not an error', () => {
    expect(drainInvalidations(wiki, load(wiki))).toBe(0);
  });
});

/**
 * A RECORD QUEUED WHILE THE DRAIN IS RUNNING MUST SURVIVE IT.
 *
 * The drain used to `readFileSync` the queue and then `rmSync` the SAME path. A
 * post-tool hook appending between those two points had its record deleted
 * having never been read -- and parallel tool calls inside one assistant turn are
 * the ordinary way that happens, not an exotic race.
 *
 * AND A LOST RECORD IS PERMANENT, not degraded. The comment justifying the
 * unconditional clear priced it as "a single missed eager mark that the lazy path
 * still has a chance at". This suite's own header is the refutation: the lazy
 * path compares the anchor's stored hash against disk, `indexFile` re-points that
 * hash at the bytes the session just wrote, so for the session's own writes lazy
 * is blind rather than late. Nothing else was ever going to catch it.
 *
 * THE INTERLEAVING IS DETERMINISTIC, not timed. `drainInvalidations` hands the
 * caller's graph to `invalidateOnWrite`, so a graph whose `nodes` accessor queues
 * a second record places that append exactly mid-drain, every run.
 */
describe('a concurrently queued record is not deleted unread', () => {
  const queueFile = () => join(wiki, 'pending-invalidation.jsonl');

  /** A graph that appends a second write to the queue the moment the drain reads it. */
  const graphThatQueuesMidDrain = (onFirstAccess) => {
    const graph = load(wiki);
    let fired = false;
    return {
      get nodes() {
        if (!fired) {
          fired = true;
          onFirstAccess();
        }
        return graph.nodes;
      },
      get edges() {
        return graph.edges;
      },
    };
  };

  test('the record appended mid-drain is still there for the next drain', () => {
    const second = join(project, 'other.ts');
    writeFileSync(second, BEFORE);
    indexFile(wiki, second, BEFORE);
    putNodeWithEdges(
      wiki,
      { kind: 'finding', key: 'other-trims', claim: CLAIM, type: 'finding', confidence: 0.9 },
      [{ edge: 'derived_from', to: nodeId('file', second) }]
    );

    queueInvalidation(wiki, { path: file, before: BEFORE, after: AFTER });
    const graph = graphThatQueuesMidDrain(() => {
      writeFileSync(second, AFTER);
      queueInvalidation(wiki, { path: second, before: BEFORE, after: AFTER });
    });

    expect(drainInvalidations(wiki, graph)).toBeGreaterThan(0);
    // The first drain took a CLAIM, so the concurrent append landed on a fresh
    // queue rather than inside the file that was about to be deleted.
    expect(existsSync(queueFile())).toBe(true);

    // And it is applied, which is the point: the mark exists rather than being
    // left to a lazy path that cannot see this write at all.
    expect(drainInvalidations(wiki, load(wiki))).toBeGreaterThan(0);
    expect(load(wiki).nodes.get(nodeId('finding', 'other-trims')).stale).toBe(true);
  });

  test('the claim file is not left behind for the next drain to re-apply', () => {
    queueInvalidation(wiki, { path: file, before: BEFORE, after: AFTER });
    expect(drainInvalidations(wiki, load(wiki))).toBeGreaterThan(0);
    // Nothing to re-apply, and no queue: the claim was deleted, not the queue.
    expect(existsSync(queueFile())).toBe(false);
    expect(drainInvalidations(wiki, load(wiki))).toBe(0);
  });
});
