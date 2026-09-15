import { test, expect } from '@jest/globals';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture } from '../../../bench/live/codex-fixtures.mjs';
import { workflow } from '../../../bench/live/codex-workflows.mjs';

const run = promisify(execFile);
test.each([
  'truncated',
  'complete',
  'missing',
  'mcp-valid',
  'mcp-skipped',
  'mcp-missing',
  'mcp-no-diff',
])('adversarial report checks initial exposure: %s', async (mode) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-exposure-'));
  const artifacts = join(directory, 'refresh-1-proxy'),
    work = join(artifacts, 'workspace');
  await mkdir(work, { recursive: true });
  const f = workflow('refresh', 7);
  for (const [name, content] of Object.entries(f.files))
    await writeFile(join(work, name), content);
  await writeFile(
    join(work, 'before.json'),
    JSON.stringify({
      disabledCount: 1,
      disabledRoutes: [`route-${f.previous}`],
    })
  );
  await run(process.execPath, ['refresh.mjs'], { cwd: work });
  await writeFile(
    join(work, 'answer.json'),
    JSON.stringify({
      disabledRoute: `route-${f.marker}`,
      baseLimit: 101,
      effectiveLimit: 7,
    })
  );
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      tasks: ['refresh'],
      arms: ['proxy'],
      reps: 1,
      readMode: mode.startsWith('mcp-') ? 'mcp' : 'truncated',
    })
  );
  await writeFile(
    join(directory, 'results.json'),
    JSON.stringify([
      {
        task: 'refresh',
        arm: 'proxy',
        rep: 1,
        seed: 7,
        artifactLayout: 2,
        exit: 0,
        verdict: 'PASS',
        seconds: 1,
        requests: 1,
        usage: { input: 100, cached: 80, output: 5 },
        ledgerUsage: [
          {
            status: 200,
            usage: {
              input_tokens: 100,
              cached_input_tokens: 80,
              output_tokens: 5,
            },
          },
        ],
      },
    ])
  );
  if (mode !== 'missing')
    await writeFile(
      join(artifacts, 'requests.jsonl'),
      JSON.stringify({
        path: '/backend-api/codex/responses',
        body: JSON.stringify({
          input: [
            {
              type: 'custom_tool_call_output',
              output:
                mode === 'complete'
                  ? f.files['routes.json']
                  : 'Warning: truncated output\n' +
                    f.files['routes.json'].slice(0, 100) +
                    '…500 tokens truncated…',
            },
          ],
        }),
      }) + '\n'
    );
  if (mode.startsWith('mcp-') && mode !== 'mcp-missing') {
    const read = (diff) => ({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        server: 'token_optimizer',
        tool: 'smart_read',
        arguments: { path: join(work, 'routes.json') },
        status: 'completed',
        result: {
          content: [
            {
              text: JSON.stringify({
                metadata: { fromCache: diff, isDiff: diff },
              }),
            },
          ],
        },
      },
    });
    const refresh = {
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'node refresh.mjs',
        exit_code: 0,
      },
    };
    const events =
      mode === 'mcp-skipped'
        ? [refresh]
        : [read(false), refresh, read(mode !== 'mcp-no-diff')];
    await writeFile(
      join(artifacts, 'agent.stdout'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n'
    );
  }
  let code = 0;
  try {
    await run(process.execPath, [
      resolve('bench/live/report-codex.mjs'),
      directory,
    ]);
  } catch (error) {
    code = error.code;
  }
  const summary = JSON.parse(
    await readFile(join(directory, 'summary.json'), 'utf8')
  );
  expect(code).toBe(['truncated', 'mcp-valid'].includes(mode) ? 0 : 1);
  expect(summary.valid).toBe(['truncated', 'mcp-valid'].includes(mode));
});

test.each([
  'valid',
  'wrong answer',
  'ledger mismatch',
  'duplicate run',
  'isolated workspace',
  'provider capacity',
])('report independently audits %s artifacts', async (mode) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-report-'));
  const artifacts = join(directory, 'logs-1-control');
  const work =
    mode === 'isolated workspace' ? join(artifacts, 'workspace') : artifacts;
  await mkdir(work, { recursive: true });
  const f = fixture('logs');
  try {
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        model: 'test',
        tasks: ['logs'],
        arms: ['control'],
        reps: 1,
        balanced: true,
      })
    );
    await writeFile(
      join(directory, 'results.json'),
      JSON.stringify([
        {
          task: 'logs',
          arm: 'control',
          rep: 1,
          artifactLayout: mode === 'isolated workspace' ? 2 : 1,
          verdict: 'INVALID_READ',
          exit: mode === 'provider capacity' ? 1 : 0,
          requests: 1,
          seconds: 1,
          usage:
            mode === 'provider capacity'
              ? null
              : { input: 100, cached: 80, output: 5 },
          ledgerUsage: [
            {
              status: 200,
              usage: {
                input_tokens: 100,
                cached_input_tokens: mode === 'ledger mismatch' ? 79 : 80,
                output_tokens: 5,
              },
            },
          ],
        },
      ])
    );
    await writeFile(join(work, f.name), f.content);
    await writeFile(
      join(work, 'answer.json'),
      '\uFEFF' +
        JSON.stringify(
          mode === 'wrong answer' ? { request: 'wrong' } : f.expected
        )
    );
    await writeFile(
      join(artifacts, 'requests.jsonl'),
      JSON.stringify({
        path: '/backend-api/codex/responses',
        body: JSON.stringify({
          input: [{ type: 'custom_tool_call_output', output: f.content }],
        }),
      }) + '\n'
    );
    if (mode === 'duplicate run') {
      const rows = JSON.parse(
        await readFile(join(directory, 'results.json'), 'utf8')
      );
      await writeFile(
        join(directory, 'results.json'),
        JSON.stringify([rows[0], rows[0]])
      );
      const manifest = JSON.parse(
        await readFile(join(directory, 'manifest.json'), 'utf8')
      );
      manifest.reps = 2;
      await writeFile(
        join(directory, 'manifest.json'),
        JSON.stringify(manifest)
      );
    }
    let code = 0;
    if (mode === 'provider capacity')
      await writeFile(
        join(artifacts, 'agent.stdout'),
        JSON.stringify({
          type: 'error',
          message:
            'Selected model is at capacity. Please try a different model.',
        }) + '\n'
      );
    try {
      await run(process.execPath, [
        resolve('bench/live/report-codex.mjs'),
        directory,
      ]);
    } catch (error) {
      code = error.code;
    }
    const summary = JSON.parse(
      await readFile(join(directory, 'summary.json'), 'utf8')
    );
    const valid = ['valid', 'isolated workspace'].includes(mode);
    expect(code).toBe(valid ? 0 : 1);
    expect(summary.valid).toBe(valid);
    if (!valid) expect(summary.comparison).toEqual([]);
    if (mode === 'provider capacity') {
      const [audit] = JSON.parse(
        await readFile(join(directory, 'validation.json'), 'utf8')
      );
      expect(audit.verdict).toBe('PROVIDER_ERROR');
      expect(audit.clientErrors[0]).toContain('at capacity');
    }
    if (valid) {
      const [audit] = JSON.parse(
        await readFile(join(directory, 'validation.json'), 'utf8')
      );
      expect(audit.recordedVerdict).toBe('INVALID_READ');
      expect(audit.verdict).toBe('PASS');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
