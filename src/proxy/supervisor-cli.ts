#!/usr/bin/env node
/**
 * The supervisor as its own process, which is how `ensureSupervisor` starts it.
 *
 * Separate from `cli.ts` because that one is a foreground proxy a person runs and watches; this is
 * a detached background service with no output. It exits quietly when another supervisor already
 * owns the control port, so a race between two clients starting at once settles itself.
 */

import { runSupervisor } from './supervisor.js';

const started = await runSupervisor();
if (!started) process.exit(0);

// A supervisor nobody can find any more is a port and a directory held for nothing; see
// the note on the retry loop in supervisor.ts. It has already closed its listeners here.
void started.decommissioned.then(() => process.exit(0));

const stop = () => {
  // Keep the route registry so connected clients can recover their exact ports after any exit.
  // A state file is not a liveness claim: callers must probe the control endpoint.
  process.exit(0);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGHUP', stop);
