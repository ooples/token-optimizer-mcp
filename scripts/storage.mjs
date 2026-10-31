#!/usr/bin/env node
/**
 * token-optimizer-storage: move a project store out of its repository (#542).
 *
 *   token-optimizer-storage status  [repo]   state, location, blockers
 *   token-optimizer-storage migrate [repo]   move it, or say exactly why not
 *   token-optimizer-storage recover [repo]   finish or undo an interrupted move
 *   token-optimizer-storage gc      [repo]   delete the backup after re-validating
 *   token-optimizer-storage restore [repo]   move a migrated store back into the repository
 *
 * `repo` defaults to the current directory. Exit 0 on success, 1 when refused
 * or failed, 2 on a usage error. Every refusal names its blockers; a refused
 * migration records its intent and is completed by a later session start once
 * the blockers clear.
 */
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  gc,
  migrate,
  offlineBlockers,
  readTombstone,
  recover,
  restore,
  tokenOptimizerProcesses,
} from '../hooks-core/migrate.mjs';
import { liveLeases, readState, storeId } from '../hooks-core/maintenance.mjs';

const [command = 'status', target = '.'] = process.argv.slice(2);
const root = resolve(target);
const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

function status() {
  const tomb = readTombstone(root);
  const id = tomb?.storeId ?? storeId(join(root, '.token-optimizer'));
  return {
    root,
    storeId: id,
    location: tomb?.movedTo ?? (existsSync(join(root, '.token-optimizer')) ? join(root, '.token-optimizer') : null),
    moved: Boolean(tomb?.movedTo),
    maintenance: readState(id),
    liveLeases: liveLeases(id).length,
    // Known participants only: a process this host cannot see is not listed,
    // and an incomplete list is itself reported as a blocker.
    blockers: tomb?.movedTo ? [] : offlineBlockers(tokenOptimizerProcesses()),
  };
}

switch (command) {
  case 'status':
    print(status());
    break;
  case 'migrate': {
    const result = migrate(root);
    print(result);
    process.exitCode = result.ok ? 0 : 1;
    break;
  }
  case 'recover':
    print(recover(root));
    break;
  case 'restore': {
    const result = restore(root);
    print(result);
    process.exitCode = result.ok ? 0 : 1;
    break;
  }
  case 'gc': {
    const result = gc(root);
    print(result);
    process.exitCode = result.ok ? 0 : 1;
    break;
  }
  default:
    process.stderr.write(`unknown command: ${command}\nusage: token-optimizer-storage status|migrate|recover|gc|restore [repo]\n`);
    process.exitCode = 2;
}
