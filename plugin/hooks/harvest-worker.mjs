#!/usr/bin/env node
/**
 * The out-of-band half of the semantic harvest.
 *
 * Spawned detached by the Stop adapter so the session that did the work never
 * pays for the model call that summarises it. Everything here is best-effort:
 * a harvest that fails must be indistinguishable from a session with nothing
 * to learn, because the alternative -- a hook that can break a turn -- is worse
 * than no findings at all.
 *
 * The cost of the extraction is recorded either way. Without it the metrics
 * report a benefit with no matching expense, and `netTokens` would flatter the
 * feature by exactly the amount it spends.
 */

import { existsSync } from 'node:fs';
import {
  harvestEnabled,
  buildDigest,
  buildFullDelta,
  extract,
  validate,
  estimateTokens,
} from './lib/harvest.mjs';
import { writeHarvested } from './lib/harvest-write.mjs';
import { wikiDir } from './lib/wiki.mjs';
import { record } from './lib/metrics.mjs';

/**
 * The files the digest says were touched.
 *
 * `buildDigest` emits them under a `## Files touched` heading and returns a
 * string, so this reads back the list it just wrote rather than walking the
 * transcript a second time. Returns null when the section is absent, which
 * `validate` treats as "no restriction" rather than "no files".
 */
function filesIn(digest) {
  const start = digest.indexOf('## Files touched');
  if (start === -1) return null;

  const rest = digest.slice(start + '## Files touched'.length);
  const end = rest.indexOf('\n##');
  const block = (end === -1 ? rest : rest.slice(0, end)).split('\n');

  const files = new Set();
  for (const line of block) {
    const value = line.trim();
    if (value) files.add(value);
  }
  return files.size ? files : null;
}

async function main() {
  const [transcript, sessionId, cwd] = process.argv.slice(2);
  if (!transcript || !existsSync(transcript) || !harvestEnabled()) return;

  const dir = wikiDir(cwd || process.cwd());

  // Default sends a structured digest with no file contents. The full delta is
  // opt-in because the default has to be defensible without reading the docs.
  const full = process.env.TOKEN_OPTIMIZER_HARVEST_FULL === 'true';
  const digest = full ? buildFullDelta(transcript) : buildDigest(transcript);
  if (!digest) return;

  const raw = await extract(digest);

  // Anchors are held to the files this session actually touched, so a model
  // that invents a plausible path cannot anchor a finding to it. The digest
  // lists them under a heading it writes itself; the full delta is raw
  // transcript and carries no such list, so it gets no restriction.
  const findings = validate(raw, { knownFiles: full ? null : filesIn(digest) });

  const written = writeHarvested(dir, findings, { sessionId: sessionId || null });

  record(dir, {
    kind: 'harvest',
    sessionId: sessionId || null,
    tokens: estimateTokens(digest),
    findings: written.length,
    at: Date.now(),
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
