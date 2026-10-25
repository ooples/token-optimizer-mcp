// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/routing-record.mjs. Regenerate with `npm run sync:hooks`.
/**
 * The record of what default routing wrote into a client's settings, for the
 * hooks (doctor, capabilities), which cannot import the compiled proxy.
 *
 * Mirrors src/proxy/default-routing.ts: the record is kept BESIDE the settings
 * file it describes (`token-optimizer-routing.json`), and a record an earlier
 * version left in the optimizer home (`default-routing.json`) is still read.
 * The record beside the settings file wins for any file both name.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function claudeSettingsFile(env = process.env) {
  return (
    env.TOKEN_OPTIMIZER_SETTINGS ||
    join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
  );
}

function entriesAt(path) {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    return manifest?.schema === 1 && manifest.entries && typeof manifest.entries === 'object'
      ? manifest.entries
      : {};
  } catch {
    return {};
  }
}

/** Every entry we have recorded, keyed by the settings file it describes. */
export function routingEntries(env = process.env) {
  const home = env.TOKEN_OPTIMIZER_HOME || join(homedir(), '.token-optimizer');
  const current = join(dirname(claudeSettingsFile(env)), 'token-optimizer-routing.json');
  const legacy = join(home, 'default-routing.json');
  return {
    ...(legacy === current ? {} : entriesAt(legacy)),
    ...entriesAt(current),
  };
}
