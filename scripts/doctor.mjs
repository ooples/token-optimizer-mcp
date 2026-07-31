#!/usr/bin/env node
/**
 * `npm run doctor` -- does this installation actually work?
 *
 * The command-line form of the same examination the install_doctor tool runs,
 * for the case where the MCP server is exactly what is broken and cannot be
 * asked. This one DOES probe the server, since it is not running inside it.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { diagnose, renderDiagnosis } from '../hooks-core/doctor.mjs';
import { wikiDir } from '../hooks-core/wiki.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const result = diagnose({
  root,
  workspace: join(tmpdir(), 'token-optimizer-doctor'),
  graphDir: wikiDir(process.cwd()),
  settingsPath: process.env.TOKEN_OPTIMIZER_SETTINGS || join(homedir(), '.claude', 'settings.json'),
});

console.log(renderDiagnosis(result));
console.log('');
console.log('Verify the release itself with `npm audit signatures` (provenance attestation),');
console.log('or `sha256sum -c CHECKSUMS.sha256` for an offline check.');

// A broken install should fail a script that asks whether it is broken.
process.exit(result.healthy ? 0 : 1);
