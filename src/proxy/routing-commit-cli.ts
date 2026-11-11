#!/usr/bin/env node
/**
 * The deferred-route committer as its own process; see routing-commit.ts. Detached, no output,
 * and it exits once it has written the route or decided not to.
 */

import { commitWhenSessionsEnd, parseCommitArgs } from './routing-commit.js';

try {
  await commitWhenSessionsEnd({ self: parseCommitArgs(process.argv.slice(2)) });
} catch {
  // Nothing to report to: a failed commit leaves the client where it was, which is working.
}
process.exit(0);
