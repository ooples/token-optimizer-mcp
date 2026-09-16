/** Resume only an audited, complete prefix after a between-case hash failure. */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hashes } from './confirmation-freeze.mjs';

export async function continuationPrefix(study, plan, freeze) {
  const path = join(study, 'continuation.json');
  const text = await readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (text === null) return { pairs: [], continuation: null };
  if (!freeze.sha256[path]) throw Error('Continuation is not frozen');
  const registration = JSON.parse(text);
  const source = resolve(registration.source);
  if (source === resolve(study))
    throw Error('Cannot resume into original evidence');
  const journal = JSON.parse(
    await readFile(join(source, 'execution.json'), 'utf8')
  );
  if (
    journal.status !== 'incomplete' ||
    journal.error !== 'RangeError: Array buffer allocation failed' ||
    journal.pairs.length !== registration.completedPairs ||
    journal.pairs.length === 0 ||
    journal.pairs.length >= plan.pairs
  )
    throw Error('Not the registered between-case hash interruption');
  const rawCases = (await readdir(journal.raw, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (
    JSON.stringify(rawCases) !==
    JSON.stringify(journal.pairs.map((pair) => pair.id).sort())
  )
    throw Error('Unjournaled or missing raw attempt directory');
  const priorPlan = await readFile(join(source, 'plan.json'), 'utf8');
  if (priorPlan !== (await readFile(join(study, 'plan.json'), 'utf8')))
    throw Error('Continuation changed the schedule or estimand');
  const now = await hashes(Object.keys(registration.evidenceSha256));
  for (const [file, expected] of Object.entries(registration.evidenceSha256)) {
    if (now[file] !== expected)
      throw Error(`Interrupted evidence changed: ${file}`);
  }
  const originalFreeze = JSON.parse(
    await readFile(join(source, 'freeze.json'), 'utf8')
  );
  const changes = new Set([
    join(freeze.root, 'bench/live/confirmation-freeze.mjs'),
    join(freeze.root, 'bench/live/confirmation-run.mjs'),
  ]);
  const originalNow = await hashes(Object.keys(originalFreeze.sha256));
  for (const [file, expected] of Object.entries(originalFreeze.sha256)) {
    if (originalNow[file] !== expected && !changes.has(file))
      throw Error(
        `Continuation changed a product, task, client or analysis artifact: ${file}`
      );
  }
  for (const [index, pair] of journal.pairs.entries()) {
    if (
      pair.id !== plan.schedule[index].id ||
      pair.status !== 'complete' ||
      pair.runnerExit !== 0
    )
      throw Error('Cannot skip, replace or repeat a partial pair');
    const audit = JSON.parse(
      await readFile(join(study, 'cases', pair.id, 'validation.json'), 'utf8')
    );
    if (
      audit.length !== 2 ||
      new Set(audit.map((row) => row.arm)).size !== 2 ||
      !audit.every((row) => plan.schedule[index].arms.includes(row.arm))
    )
      throw Error('Interrupted pair does not contain both audited arms');
    // Derive infrastructure state from the audit, including the last pair whose
    // post-case hash check failed before this journal field could be persisted.
    pair.infrastructureFailure = audit.some(
      (row) => row.verdict === 'PROVIDER_ERROR' || row.clientErrors?.length > 0
    );
    if (audit.every((row) => row.verdict === 'INVALID_READ'))
      throw Error('Cannot resume a measurement-exposure failure');
  }
  return {
    pairs: journal.pairs,
    continuation: {
      source,
      completedPairs: journal.pairs.length,
      reason: journal.error,
      amendment: 'AMENDMENT.md',
    },
  };
}
