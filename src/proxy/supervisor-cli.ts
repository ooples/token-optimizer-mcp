#!/usr/bin/env node
/**
 * The supervisor as its own process, which is how `ensureSupervisor` starts it.
 *
 * Separate from `cli.ts` because that one is a foreground proxy a person runs and watches; this is
 * a detached background service with no output. It exits quietly when another supervisor already
 * owns the control port, so a race between two clients starting at once settles itself.
 */

import { runSupervisor, supervisorStateFile } from './supervisor.js';
import { rmSync } from 'node:fs';

const started = await runSupervisor();
if (!started) process.exit(0);

const stop = () => {
  // The state file names routes that die with this process; leaving it would tell the next reader
  // to use ports nothing is listening on.
  try {
    // Sync because this runs inside a signal handler that ends with process.exit: an awaited
    // removal would not finish, and the stale file is exactly what we are here to prevent.
    // eslint-disable-next-line n/no-sync -- see above
    rmSync(supervisorStateFile(), { force: true });
  } catch {
    /* best effort */
  }
  process.exit(0);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGHUP', stop);
