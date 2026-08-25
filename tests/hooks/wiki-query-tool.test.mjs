/**
 * wiki_query — and, more importantly, whether anything can CALL it.
 *
 * The in-process cases below are the ordinary contract: get, search, anchor, the
 * missing key, and the `query` metric event that earns the session index its
 * budget. They are necessary and they are not sufficient. This repository's
 * defining defect is correct code nothing calls, and every one of those cases
 * would pass on a tool that no MCP client could reach.
 *
 * So the last block drives the BUILT server over stdio, exactly as a client
 * does: tools/list must advertise wiki_query under the default profile, and
 * tools/call must route it. That is the assertion that would have failed while
 * `wiki_query` was absent from CORE_TOOL_NAMES -- the handler refuses any name
 * outside the advertised set, so the tool was schema-checked, dispatch-wired and
 * still unreachable.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from '@jest/globals';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { putNodeWithEdges, nodeId } from '../../hooks-core/wiki.mjs';
// `readAll` is private to metrics.mjs; `readMetrics` is the exported reader over
// the same bounded log.
import { readMetrics } from '../../hooks-core/metrics.mjs';
import {
  wikiQuery,
  WIKI_QUERY_TOOL_DEFINITION,
} from '../../dist/tools/intelligence/wiki-query.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wq-'));
  putNodeWithEdges(dir, {
    kind: 'file',
    key: join(dir, 'auth.ts'),
    hash: 'abc',
  });
  putNodeWithEdges(
    dir,
    {
      kind: 'finding',
      key: 'retry-cap',
      claim: 'the retry backoff is capped at thirty seconds',
      confidence: 0.9,
    },
    [{ edge: 'derived_from', to: nodeId('file', join(dir, 'auth.ts')) }]
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('wiki_query', () => {
  it('returns a finding by key', async () => {
    const result = await wikiQuery({
      operation: 'get',
      key: 'retry-cap',
      graphDir: dir,
    });
    expect(result.finding.claim).toContain('thirty seconds');
  });

  it('finds a finding by search term', async () => {
    const result = await wikiQuery({
      operation: 'search',
      query: 'retry backoff',
      graphDir: dir,
    });
    expect(result.findings.map((f) => f.key)).toContain('retry-cap');
  });

  it('refuses the anchored retrieval that belongs to wiki_read', async () => {
    // Deliberately NOT supported here. wiki_read already answers "what does the
    // graph know about this file", and two tools with an identical operation
    // cost the model tokens choosing between them. If anchored retrieval ever
    // reappears in this tool, this fails and the duplication is visible.
    const result = await wikiQuery({ operation: 'anchor', graphDir: dir });
    expect(result.found).toBe(false);
    expect(result.note).toMatch(/unknown operation/);
    expect(
      WIKI_QUERY_TOOL_DEFINITION.inputSchema.properties
    ).not.toHaveProperty('anchor');
    expect(
      WIKI_QUERY_TOOL_DEFINITION.inputSchema.properties.operation.enum
    ).not.toContain('anchor');
  });

  it('records a query event, which is what earns the session index its budget', async () => {
    await wikiQuery({ operation: 'get', key: 'retry-cap', graphDir: dir });
    const events = readMetrics(dir).filter((e) => e.kind === 'query');
    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('get');
  });

  it('reports a missing key rather than throwing', async () => {
    const result = await wikiQuery({
      operation: 'get',
      key: 'nope',
      graphDir: dir,
    });
    expect(result.found).toBe(false);
  });

  it('never lets a file snapshot reach the response', async () => {
    // A `snapshot` is a verbatim copy of a file. `putNode` spreads whatever
    // fields it is handed onto the record, so one written inline comes back from
    // `load()` whether or not snapshots were requested -- which is why the guard
    // is at the response boundary and not a comment about how load is called.
    const leaky = mkdtempSync(join(tmpdir(), 'wq-leak-'));
    try {
      putNodeWithEdges(leaky, {
        kind: 'file',
        key: join(leaky, 'secret.ts'),
        hash: 'abc',
        snapshot: 'PRIVATE FILE CONTENTS THAT MUST NOT BE SERVED',
      });
      putNodeWithEdges(
        leaky,
        {
          kind: 'finding',
          key: 'leaky',
          claim: 'a claim carrying a snapshot it should not carry',
          confidence: 0.9,
          snapshot: 'PRIVATE FILE CONTENTS THAT MUST NOT BE SERVED',
        },
        [
          {
            edge: 'derived_from',
            to: nodeId('file', join(leaky, 'secret.ts')),
          },
        ]
      );

      const got = await wikiQuery({
        operation: 'get',
        key: 'leaky',
        graphDir: leaky,
      });
      expect(got.found).toBe(true);
      expect(got.finding).not.toHaveProperty('snapshot');
      // WHAT THIS TEST FOUND, and it is worth stating rather than asserting
      // around: the snapshot does not only escape as a `snapshot` field. When a
      // finding is stale, `staleness.serve` renders the snapshot into `diff`.
      // That one is DELIBERATE and required -- a stale finding must arrive with
      // the change that invalidated it -- and it is bounded to 40 lines by
      // `diffLines`, which a raw snapshot is not. So the invariant is: the only
      // snapshot-derived text a response may carry is that bounded diff.
      const { diff, ...rest } = got.finding;
      expect(JSON.stringify(rest)).not.toContain('PRIVATE FILE CONTENTS');
      expect(String(diff).split('\n').length).toBeLessThanOrEqual(41);

      // The `node` operation returns a raw graph node and its neighbours, which
      // is the widest exposure of the two.
      const node = await wikiQuery({
        operation: 'node',
        nodeId: nodeId('file', join(leaky, 'secret.ts')),
        graphDir: leaky,
      });
      expect(node.found).toBe(true);
      expect(node.node).not.toHaveProperty('snapshot');
      for (const neighbour of node.neighbours)
        expect(neighbour).not.toHaveProperty('snapshot');
      expect(JSON.stringify(node)).not.toContain('PRIVATE FILE CONTENTS');

      const searched = await wikiQuery({
        operation: 'search',
        query: 'claim carrying snapshot',
        graphDir: leaky,
      });
      for (const finding of searched.findings) {
        expect(finding).not.toHaveProperty('snapshot');
        const { diff: served, ...body } = finding;
        expect(JSON.stringify(body)).not.toContain('PRIVATE FILE CONTENTS');
        if (served !== undefined)
          expect(String(served).split('\n').length).toBeLessThanOrEqual(41);
      }
    } finally {
      rmSync(leaky, { recursive: true, force: true });
    }
  });

  it('never serves a stale finding bare', async () => {
    // The anchor was recorded with a hash and never written to disk, so the
    // finding is stale. It must arrive marked, with the evidence state stated.
    const result = await wikiQuery({
      operation: 'get',
      key: 'retry-cap',
      graphDir: dir,
    });
    expect(result.finding.stale).toBe(true);
    expect(result.finding).toHaveProperty('staleReason');
    expect(result.finding).toHaveProperty('staleEvidence');
  });
});

/**
 * The reachability half: the real transport, the real profile gate, the real
 * dispatch switch. Anything asserted above about `wikiQuery` is a claim about a
 * function; only this is a claim about a TOOL.
 */
describe('wiki_query over the MCP transport a client actually uses', () => {
  const SERVER = join(process.cwd(), 'dist', 'server', 'index.js');
  let server;
  let stdoutBuffer = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map();

  function call(method, params, timeoutMs = 60_000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `timed out waiting for ${method} (id ${id}); stderr: ${stderr.slice(-800)}`
            )
          ),
        timeoutMs
      );
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      server.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
      );
    });
  }

  beforeAll(async () => {
    expect(existsSync(SERVER)).toBe(true);
    server = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TOKEN_OPTIMIZER_MODE: 'off' },
    });
    server.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    server.stdout.on('data', (chunk) => {
      stdoutBuffer += String(chunk);
      let index = stdoutBuffer.indexOf('\n');
      while (index !== -1) {
        const line = stdoutBuffer.slice(0, index).trim();
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (line) {
          let message = null;
          try {
            message = JSON.parse(line);
          } catch {
            message = null;
          }
          const resolver =
            message && typeof message.id === 'number'
              ? pending.get(message.id)
              : undefined;
          if (resolver) {
            pending.delete(message.id);
            resolver(message.result ?? message.error);
          }
        }
        index = stdoutBuffer.indexOf('\n');
      }
    });

    await call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wiki-query-reachability', version: '0.0.0' },
    });
    server.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
    );
  }, 120_000);

  afterAll(() => {
    if (server && !server.killed) server.kill();
  });

  it('advertises wiki_query in tools/list under the DEFAULT profile', async () => {
    const result = await call('tools/list', {});
    const names = (result?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain('wiki_query');
  }, 120_000);

  it('publishes every option the implementation accepts', async () => {
    const result = await call('tools/list', {});
    const tool = (result?.tools ?? []).find((t) => t.name === 'wiki_query');
    expect(tool).toBeDefined();
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(
      [
        'graphDir',
        'key',
        'limit',
        'nodeId',
        'operation',
        'projectRoot',
        'query',
        'sessionId',
        'type',
      ].sort()
    );
  }, 120_000);

  it('routes tools/call to the tool, and the call lands a query event in THAT project graph', async () => {
    const result = await call('tools/call', {
      name: 'wiki_query',
      arguments: { operation: 'get', key: 'retry-cap', graphDir: dir },
    });
    const text = result?.content?.[0]?.text;
    expect(typeof text).toBe('string');
    const payload = JSON.parse(text);
    expect(payload.found).toBe(true);
    expect(payload.finding.claim).toContain('thirty seconds');

    // The event must be in the graph directory the CALL named, not in whichever
    // directory the server process happens to be running from.
    const events = readMetrics(dir).filter((e) => e.kind === 'query');
    expect(events.map((e) => e.operation)).toContain('get');
    expect(events.map((e) => e.key)).toContain('retry-cap');
  }, 120_000);
});
