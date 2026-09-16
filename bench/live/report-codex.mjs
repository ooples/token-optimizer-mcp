#!/usr/bin/env node
/** Summarize a Codex campaign without treating failures or absent usage as wins. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fixture as developmentFixture } from './codex-fixtures.mjs';
import { readEvidence, outerEnvelopeTruncated } from './codex-output.mjs';
import { mcpRefreshEvidence } from './codex-mcp-evidence.mjs';
import {
  workflow as developmentWorkflow,
  workflowTasks,
  validateWorkflow as validateDevelopmentWorkflow,
} from './codex-workflows.mjs';
import {
  heldoutFixture,
  heldoutWorkflow,
  validateHeldoutWorkflow,
} from './heldout-cases.mjs';

const directory = resolve(process.argv[2] || '.');
const manifest = JSON.parse(
  await readFile(join(directory, 'manifest.json'), 'utf8')
);
const results = JSON.parse(
  await readFile(join(directory, 'results.json'), 'utf8')
);
if (
  !['development', 'heldout-v1'].includes(manifest.caseSuite ?? 'development')
)
  throw Error('Unknown case suite');
const fixture =
  manifest.caseSuite === 'heldout-v1' ? heldoutFixture : developmentFixture;
const workflow =
  manifest.caseSuite === 'heldout-v1' ? heldoutWorkflow : developmentWorkflow;
const validateWorkflow =
  manifest.caseSuite === 'heldout-v1'
    ? validateHeldoutWorkflow
    : validateDevelopmentWorkflow;
const failures = [];
const identities = new Set();
for (const row of results) {
  const id = `${row.task}/${row.arm}/${row.rep}`;
  if (
    identities.has(id) ||
    !manifest.tasks.includes(row.task) ||
    !manifest.arms.includes(row.arm) ||
    !Number.isInteger(row.rep) ||
    row.rep < 1 ||
    row.rep > manifest.reps
  )
    failures.push(`Unexpected or duplicate run: ${id}`);
  identities.add(id);
}
// Recompute correctness from artifacts, not the runner's verdict. This also
// makes validator fixes auditable without rerunning or discarding model runs.
const audit = [];
for (const row of results) {
  const artifacts = join(directory, `${row.task}-${row.rep}-${row.arm}`);
  const work =
    row.artifactLayout === 2 ? join(artifacts, 'workspace') : artifacts;
  const natural = workflowTasks.includes(row.task);
  const f = natural ? null : fixture(row.task, row.seed ?? row.rep);
  let verdict = 'FAIL',
    read = null;
  try {
    if (natural) {
      const validation = await validateWorkflow(
        row.task,
        work,
        row.seed ?? row.rep
      );
      verdict = row.exit === 0 && validation.passed ? 'PASS' : 'FAIL';
      read = { notApplicable: true };
      if (['truncated', 'outer-truncated'].includes(manifest.readMode)) {
        const captures = (
          await readFile(join(artifacts, 'requests.jsonl'), 'utf8')
        )
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map(JSON.parse);
        read = readEvidence(
          captures,
          workflow(row.task, row.seed ?? row.rep).files['routes.json']
        );
        if (!read.truncated) verdict = 'INVALID_READ';
        if (manifest.readMode === 'outer-truncated') {
          read.outerTruncated = outerEnvelopeTruncated(captures);
          if (!read.outerTruncated) verdict = 'INVALID_READ';
        }
      }
    } else {
      const captures = (
        await readFile(join(artifacts, 'requests.jsonl'), 'utf8')
      )
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map(JSON.parse);
      read = readEvidence(captures, f.content);
      const answer = JSON.parse(
        (await readFile(join(work, 'answer.json'), 'utf8')).replace(
          /^\uFEFF/,
          ''
        )
      );
      const correct = Object.entries(f.expected).every(
        ([k, v]) => answer[k] === v
      );
      const unchanged =
        (await readFile(join(work, f.name), 'utf8')) === f.content;
      verdict =
        !read.complete || read.truncated
          ? 'INVALID_READ'
          : row.exit === 0 && correct && unchanged
            ? 'PASS'
            : 'FAIL';
    }
  } catch {
    verdict = 'FAIL';
  }
  let clientErrors = [];
  try {
    const events = (await readFile(join(artifacts, 'agent.stdout'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(JSON.parse);
    if (manifest.readMode === 'mcp') {
      read = mcpRefreshEvidence(events, join(work, 'routes.json'));
      if (!read.passed) verdict = 'INVALID_MCP';
    }
    if (manifest.readMode === 'mixed') {
      const first = events.find(
        (e) =>
          e.type === 'item.completed' && e.item?.type === 'command_execution'
      )?.item;
      const output = (first?.aggregated_output || '').replaceAll('\r\n', '\n');
      const source = workflow(row.task, row.seed ?? row.rep)
        .files['routes.json'].replaceAll('\r\n', '\n')
        .trim();
      read = {
        completeMixedRead:
          first?.exit_code === 0 &&
          output.includes(source) &&
          output.includes(
            'Only work in this benchmark directory. Do not search parent directories or use external services.'
          ),
      };
      if (!read.completeMixedRead) verdict = 'INVALID_READ';
    }
    clientErrors = [
      ...new Set(
        events
          .filter((e) => e.type === 'error' || e.type === 'turn.failed')
          .map((e) => e.message || e.error?.message)
          .filter(Boolean)
      ),
    ];
  } catch {
    if (manifest.readMode === 'mcp') verdict = 'INVALID_MCP';
    if (manifest.readMode === 'mixed') verdict = 'INVALID_READ';
  }
  if (
    row.exit !== 0 &&
    clientErrors.some((message) => /model is at capacity/i.test(message))
  )
    verdict = 'PROVIDER_ERROR';
  audit.push({
    task: row.task,
    arm: row.arm,
    rep: row.rep,
    recordedVerdict: row.verdict,
    verdict,
    read,
    clientErrors,
  });
  row.verdict = verdict;
}
await writeFile(
  join(directory, 'validation.json'),
  JSON.stringify(audit, null, 2)
);
const aggregates = [];
for (const task of manifest.tasks)
  for (const arm of manifest.arms) {
    const rows = results.filter((r) => r.task === task && r.arm === arm);
    const measured = rows.filter((r) => r.usage && r.requests > 0);
    const passed = rows.filter((r) => r.verdict === 'PASS').length;
    if (
      rows.length !== manifest.reps ||
      passed !== manifest.reps ||
      measured.length !== manifest.reps
    )
      failures.push(`${task}/${arm}: incomplete or failed`);
    for (const row of measured) {
      const ledger = row.ledgerUsage || [];
      for (const [clientKey, ledgerKey] of [
        ['input', 'input_tokens'],
        ['cached', 'cached_input_tokens'],
        ['output', 'output_tokens'],
      ]) {
        const total = ledger.reduce(
          (sum, r) => sum + (r.usage?.[ledgerKey] || 0),
          0
        );
        if (total !== row.usage[clientKey])
          failures.push(
            `${task}/${arm}/rep${row.rep}: ${clientKey} ledger ${total} != Codex ${row.usage[clientKey]}`
          );
      }
      if (ledger.some((r) => r.status !== 200))
        failures.push(`${task}/${arm}/rep${row.rep}: provider error`);
    }
    const mean = (fn) =>
      measured.length
        ? measured.reduce((sum, r) => sum + fn(r), 0) / measured.length
        : null;
    aggregates.push({
      task,
      arm,
      passed,
      expected: manifest.reps,
      measured: measured.length,
      meanInput: mean((r) => r.usage.input),
      meanCached: mean((r) => r.usage.cached),
      meanUncached: mean((r) => r.usage.input - r.usage.cached),
      meanOutput: mean((r) => r.usage.output),
      meanSeconds: mean((r) => r.seconds),
      meanAgentSeconds: measured.every((r) => Number.isFinite(r.agentSeconds))
        ? mean((r) => r.agentSeconds)
        : null,
    });
  }
const comparison = failures.length
  ? []
  : manifest.tasks.flatMap((task) =>
      manifest.arms
        .filter((arm) => ['proxy', 'mcp', 'full', 'full-files'].includes(arm))
        .map((candidate) => {
          const ours = aggregates.find(
            (a) => a.task === task && a.arm === candidate
          );
          const theirs = aggregates.find(
            (a) => a.task === task && a.arm === 'headroom'
          );
          const control = aggregates.find(
            (a) => a.task === task && a.arm === 'control'
          );
          const full = aggregates.find(
            (a) => a.task === task && a.arm === 'full'
          );
          return {
            task,
            candidate,
            inputReductionVsFull:
              candidate === 'full-files' && full?.meanInput && ours?.meanInput
                ? 1 - ours.meanInput / full.meanInput
                : null,
            inputReductionVsHeadroom:
              ours?.meanInput && theirs?.meanInput
                ? 1 - ours.meanInput / theirs.meanInput
                : null,
            inputReductionVsControl:
              ours?.meanInput && control?.meanInput
                ? 1 - ours.meanInput / control.meanInput
                : null,
          };
        })
    );
const summary = {
  model: manifest.model,
  balanced: manifest.balanced,
  valid: failures.length === 0,
  failures,
  aggregates,
  comparison,
  interpretation:
    'Input includes cached tokens. Cached is a subset, not an additional charge. These are token counts, not dollar costs. Three synthetic workloads do not establish a universal win. Startup is included in seconds. HeadRoom compression is measured through provider usage, not the null recorder byte counts.',
};
await writeFile(
  join(directory, 'summary.json'),
  JSON.stringify(summary, null, 2)
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 1;
