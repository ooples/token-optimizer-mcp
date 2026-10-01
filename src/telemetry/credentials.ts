/**
 * Where an opted-in beacon sends, and the key it sends with.
 *
 * MIRRORS WHAT AiDotNet.Tensors ALREADY DOES, because the receiver is the same
 * Supabase project and there is no reason for a second arrangement. There, the
 * project URL is a committed default in the csproj and the anon key is injected
 * at build time from a CI secret as `AssemblyMetadata`, with an environment
 * variable overriding either at runtime. This is the npm-shaped version of that:
 * the URL is committed here, the key is not, and both can be overridden.
 *
 * THE URL IS NOT A SECRET AND THE KEY IS. The project URL is already published
 * in a public repository (AiDotNet.Tensors.csproj), so writing it here reveals
 * nothing; an anon key in a published npm package would be a shipped credential
 * that cannot be rotated out of installed copies, so `KEY` stays empty in the
 * tree and the release workflow rewrites this one line before packing.
 *
 * NO KEY MEANS NO UPLOAD. That is the whole failure mode, and it fails closed:
 * a build without the secret records locally and transmits nothing, which is the
 * same thing a user who never opted in gets.
 */

/** The Supabase project. Same one AiDotNet.Tensors reports to. */
export const URL_DEFAULT = 'https://yfkqwpgjahoamlgckjib.supabase.co';

/**
 * Rewritten by the release workflow. Empty in the tree, on purpose.
 *
 * Kept as a plain exported string rather than read from a generated module so
 * that a build which forgot to stamp it still compiles and still runs -- it just
 * cannot transmit, and `doctor` says which of the two happened.
 */
export const KEY_DEFAULT = '';

/**
 * The table the event shape was modelled on -- `event_type`, `machine_id_hash`,
 * `library_version`, `timestamp_utc`, `properties`. See event.ts.
 */
export const TABLE_DEFAULT = 'telemetry_events';

function trimmed(raw: string | undefined): string {
  return (raw ?? '').trim();
}

/** Project URL: environment first, then the committed default. */
export function beaconUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (trimmed(env.TOKEN_OPTIMIZER_BEACON_URL) || URL_DEFAULT).replace(
    /\/+$/,
    ''
  );
}

/** Anon key: environment first, then whatever the release stamped in. */
export function beaconKey(env: NodeJS.ProcessEnv = process.env): string {
  return trimmed(env.TOKEN_OPTIMIZER_BEACON_KEY) || KEY_DEFAULT;
}

/** Table name, overridable so a receiver can be staged without a release. */
export function beaconTable(env: NodeJS.ProcessEnv = process.env): string {
  const asked = trimmed(env.TOKEN_OPTIMIZER_BEACON_TABLE);
  // A TABLE NAME GOES INTO A URL PATH, so it is restricted to what a Postgres
  // identifier can be rather than trusted. Anything else falls back to the
  // default instead of being sent, because a crafted value here would aim the
  // request at some other endpoint on the same host.
  return /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(asked) ? asked : TABLE_DEFAULT;
}
