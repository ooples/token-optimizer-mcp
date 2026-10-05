#!/usr/bin/env node
/**
 * Stamp the Supabase anon key into the package being built.
 *
 * WHY IT IS NOT IN GIT. This repository is public and the package is published
 * to npm, so a key committed here is a credential handed to everyone who runs
 * `npm view` -- and it cannot be rotated out of the copies already installed.
 * AiDotNet.Tensors solved the same problem the same way: the project url is a
 * committed default and the key is injected at build time from a CI secret
 * (`-p:TelemetryKey=` there, this script here).
 *
 * WHY A MISSING KEY IS NOT AN ERROR. A fork's pull request gets no secrets, and
 * a contributor building locally has none either. Both must still produce a
 * working package; what they must not produce is a package that looks like it
 * uploads and silently does not. So an absent key leaves the empty literal in
 * place, says so on stderr, and exits 0 -- and `doctor` then prints "packed
 * without a key" for anyone who opted in. A tampered or unrecognisable source
 * file IS an error, because that is drift between this script and the module it
 * edits, and the failure mode of guessing is shipping an unstamped release.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// The file to stamp, defaulting to this checkout's copy. Overridable so the
// tests can stamp a throwaway copy rather than editing the working tree, and so
// a release that needs to stamp somewhere else does not need a second script.
const target = process.argv[2]
  ? resolve(process.argv[2])
  : join(here, '..', 'src', 'telemetry', 'credentials.ts');
const EMPTY = "export const KEY_DEFAULT = '';";

const raw = (process.env.TOKEN_OPTIMIZER_BEACON_KEY ?? '').trim();
const source = readFileSync(target, 'utf8');

if (!source.includes(EMPTY)) {
  // ALREADY STAMPED, OR MOVED. Either way this script must not guess: a second
  // run over a stamped file would be a no-op that reports success, and a
  // renamed constant would mean the release ships unstamped while this exits 0.
  const stamped = /export const KEY_DEFAULT = '[^']+';/.test(source);
  console.error(
    stamped
      ? 'stamp-telemetry-key: KEY_DEFAULT is already set; refusing to overwrite it.'
      : `stamp-telemetry-key: could not find \`${EMPTY}\` in ${target}. ` +
          'The constant was renamed or reformatted -- update this script rather than shipping unstamped.'
  );
  process.exit(1);
}

if (!raw) {
  console.error(
    'stamp-telemetry-key: TOKEN_OPTIMIZER_BEACON_KEY is not set, so this build cannot upload telemetry. ' +
      'That is correct for a fork, a local build and any pull request; a release without it is a mistake.'
  );
  process.exit(0);
}

// A KEY IS A JWT, AND NOTHING ELSE GOES INTO A SOURCE LITERAL. Anything with a
// quote, a backslash or a newline in it would either break the module or splice
// code into it, and a value that is not shaped like a key is far more likely to
// be a misconfigured secret than a working one.
if (!/^[A-Za-z0-9._-]{40,}$/.test(raw)) {
  console.error(
    `stamp-telemetry-key: the key does not look like a Supabase anon key (${raw.length} chars, ` +
      'expected 40+ of [A-Za-z0-9._-]). Refusing to write it.'
  );
  process.exit(1);
}

writeFileSync(target, source.replace(EMPTY, `export const KEY_DEFAULT = '${raw}';`), 'utf8');
// THE LENGTH, NEVER THE VALUE. Workflow logs are public on a public repository.
console.log(`stamp-telemetry-key: stamped a ${raw.length}-character key into credentials.ts`);
