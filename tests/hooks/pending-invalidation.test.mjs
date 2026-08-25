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
 * WHY THE SESSION'S OWN WRITES ARE THE HARD CASE. Lazy staleness compares the
 * anchor's stored hash against disk -- and both hooks call `indexFile` on every
 * file they observe, which re-points that hash at the bytes just written. So a
 * write the agent performed itself is invisible to the lazy check by the time
 * the next retrieval happens, and the finding derived from the OLD content is
 * served clean. That is the gap eager invalidation exists to close, and it is
 * what the last test in the first block measures.
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
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load, nodeId, putNodeWithEdges } from '../../hooks-core/wiki.mjs';
import { indexFile } from '../../hooks-core/staleness.mjs';
import {
  drainInvalidations,
  observedWrite,
  queueInvalidation,
} from '../../hooks-core/pending.mjs';

const ROOT = process.cwd();
const POST_TOOL = join(ROOT, 'plugin', 'hooks', 'post-tool.mjs');
const PRE_TOOL = join(ROOT, 'plugin', 'hooks', 'pretooluse-router.mjs');

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

describe('what is deliberately NOT queued', () => {
  test('a write whose before side cannot be established', () => {
    // Passing an unknown before side as '' would make invalidateOnWrite see
    // every symbol in the file as changed and mark every finding anchored
    // anywhere in it -- the over-marking its own comments call worse than the
    // file-level staleness symbols were introduced to avoid.
    writeFileSync(file, AFTER);
    expect(
      observedWrite(
        { tool_input: { file_path: file, content: AFTER } },
        { tool_response: { filePath: file, type: 'update' } }
      )
    ).toBeNull();
  });

  test('an edit whose new text now appears more than once', () => {
    // Ambiguous: reverting the wrong occurrence fabricates a before side that
    // never existed on disk.
    // `retries = 1;` is now on both lines, so nothing in the payload says which
    // of them this edit produced.
    writeFileSync(file, 'retries = 1;\nretries = 1;\n');
    expect(
      observedWrite(
        {
          tool_input: { file_path: file, old_string: 'retries = 2;', new_string: 'retries = 1;' },
        },
        {}
      )
    ).toBeNull();
  });

  test('a rewrite that changed nothing', () => {
    writeFileSync(file, BEFORE);
    expect(
      observedWrite(
        { tool_input: { file_path: file, old_string: 'x', new_string: 'x' } },
        { tool_response: { originalFile: BEFORE } }
      )
    ).toBeNull();
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
