/**
 * The whole product claim, in one test.
 *
 * Capture -> derive -> store -> retrieve -> deliver, ACROSS SESSIONS. Each half
 * of this has been verified separately at some point and the chain has never
 * been asserted end to end, which is how the graph came to hold 2,965 symbols
 * and ONE finding while every layer looked healthy.
 *
 * THE FAILURE ARRIVES FROM THE TRANSCRIPT, NOT FROM AN EVENT, because that is
 * the only place it exists on the primary client. Claude Code never fires
 * PostToolUse for a failed tool call -- every one of 1,210 `tool-outcome`
 * records on the development machine carries `success: true`, with `exit` null.
 * A fixture that records the failure as an event would pass while the shipped
 * client learned nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { record } from '../../hooks-core/metrics.mjs';
import { derive } from '../../hooks-core/derive.mjs';
import { load } from '../../hooks-core/wiki.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const ROUTER = join(REPO, 'plugin', 'hooks', 'pretooluse-router.mjs');

const FAILED = 'npx jest tests/foo.test.mjs';
const WORKED = 'npm test -- tests/foo.test.mjs';

let root;
let wiki;
let proj;
let transcript;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roundtrip-'));
  wiki = join(root, 'wiki');
  proj = join(root, 'proj');
  mkdirSync(join(proj, '.git'), { recursive: true });
  mkdirSync(wiki, { recursive: true });
  // A real anchor: writeHarvested resolves anchors through indexFile, and a
  // directory resolves to nothing, so the claim needs a FILE to hang on.
  writeFileSync(join(proj, 'package.json'), '{"name":"roundtrip"}\n');

  const now = Date.now();
  const iso = (t) => new Date(t).toISOString();
  transcript = join(root, 'transcript.jsonl');
  writeFileSync(
    transcript,
    [
      {
        type: 'assistant',
        timestamp: iso(now),
        message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: FAILED } }] },
      },
      {
        type: 'user',
        timestamp: iso(now + 1000),
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              is_error: true,
              content: 'Exit code 1\nSyntaxError: Cannot use import statement outside a module',
            },
          ],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  );

  // Only the SUCCESS is an event -- exactly what the client records.
  record(wiki, {
    kind: 'tool-outcome',
    surface: 'command',
    anchor: WORKED,
    success: true,
    at: now + 40_000,
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A LATER, DIFFERENT session about to run the command that failed before. */
const askRouter = (command, mode) => {
  const result = spawnSync(process.execPath, [ROUTER], {
    input: JSON.stringify({
      session_id: `later-${Math.random()}`,
      cwd: proj,
      tool_name: 'Bash',
      tool_input: { command },
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_MODE: mode,
      TOKEN_OPTIMIZER_WIKI_DIR: wiki,
      TOKEN_OPTIMIZER_SHARED_DIR: wiki,
      TOKEN_OPTIMIZER_MCP_CAPABILITIES: 'smart_read,smart_grep',
    },
  });
  // A CRASH MUST NOT BE READABLE AS SILENCE. The catch below used to swallow
  // everything, so a router that threw, printed a stack trace, or emitted
  // malformed JSON returned the same empty string as a clean allow -- and every
  // `not.toContain` in this file would have passed on a router that never ran.
  // The router expresses a refusal in JSON and always exits 0 (policy.mjs:736,
  // 767, 829), so a non-zero status is a genuine failure in every mode.
  if (result.error) throw result.error;
  expect(result.status).toBe(0);
  const stdout = (result.stdout || '').trim();
  // An allow may legitimately write nothing at all; that is the only empty
  // output accepted, and only after the status check above.
  if (!stdout) return '';
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `router emitted non-JSON: ${stdout.slice(0, 400)}
--- stderr ---
${result.stderr}`
    );
  }
  const out = parsed.hookSpecificOutput || {};
  return (out.additionalContext || '') + (out.permissionDecisionReason || '');
};

describe('a lesson learned in one session reaches the next', () => {
  it('derives and STORES the finding from a transcript failure', () => {
    const result = derive(wiki, { sessionId: 'first', projectRoot: proj, transcriptPath: transcript });
    expect(result.candidates.length).toBeGreaterThan(0);
    // Storing is the half that was silently failing: 937 real derive runs
    // produced 8 candidates and wrote zero.
    expect(result.written.length).toBeGreaterThan(0);

    const findings = [...load(wiki).nodes.values()].filter((n) => n.kind === 'finding' && !n.retired);
    expect(findings).toHaveLength(1);
    expect(findings[0].claim).toContain(WORKED);
    expect(findings[0].trigger).toBeTruthy();
  });

  it.each(['assist', 'advise', 'enforce'])(
    'warns a later session under %s, before the command runs',
    (mode) => {
      derive(wiki, { sessionId: 'first', projectRoot: proj, transcriptPath: transcript });
      const said = askRouter(FAILED, mode);
      expect(said).toContain('known from previous sessions');
      expect(said).toContain(WORKED);
    }
  );

  it('says nothing about an unrelated command', () => {
    // The cost of speaking is paid on every call; a finding that fires on
    // everything is worse than one that fires on nothing.
    derive(wiki, { sessionId: 'first', projectRoot: proj, transcriptPath: transcript });
    // The same router, same graph, same mode DOES speak for the command the
    // finding is about -- so the silence below is selectivity, not a dead path.
    expect(askRouter(FAILED, 'assist')).toContain('known from previous sessions');
    expect(askRouter('ls -la', 'assist')).not.toContain('known from previous sessions');
  });
});
