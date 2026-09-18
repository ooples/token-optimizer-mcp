/**
 * Where an OrcaRouter key lives once we have one.
 *
 * REUSES THE PROJECT'S OWN HOME, not a new secret store. `optimizerHome()` already decides where
 * this package keeps state the user owns (`$TOKEN_OPTIMIZER_HOME`, else `~/.token-optimizer`), and
 * the routing manifest, the supervisor state and the accounting ledger all live under it. A second
 * credential directory for OrcaRouter alone would be one more thing to back up, one more thing to
 * leak, and one more thing a user has to find to revoke.
 *
 * WRITTEN 0600. The file holds a bearer credential that is billed to the user, so it is created
 * owner-read-write and nothing else, and re-tightened on every write in case it was copied.
 *
 * A PKCE-ISSUED KEY IS DURABLE, NOT A REFRESH TOKEN. There is no refresh endpoint and no refresh
 * grant: the key is reused until OrcaRouter revokes it. The one state change this file records is
 * `needsReauth`, set when the relay answers 401 -- and it is recorded against the exact
 * `{accountId, generation}` that made the rejected request, so a late failure from an old request
 * can never mark a freshly reauthorized credential as broken. Nothing here schedules a refresh and
 * nothing deletes a credential before a replacement has been stored.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { optimizerHome } from '../proxy/default-routing.js';

/** The two ways a user can end up holding a key. They share everything downstream. */
export type OrcaCredentialSource = 'api-key' | 'oauth-pkce';

/** Provider ids as the UI and the CLI present them. */
export const ORCA_API_KEY_PROVIDER_ID = 'orcarouter';
export const ORCA_PKCE_PROVIDER_ID = 'orcarouter-oauth';

export const ORCA_API_KEY_LABEL = 'OrcaRouter - API';
export const ORCA_PKCE_LABEL = 'OrcaRouter - Auth';

export interface StoredOrcaCredential {
  readonly source: OrcaCredentialSource;
  /** The secret. Never logged, never returned in an API response. */
  readonly key: string;
  /** The OrcaRouter account the key belongs to, or `api-key` for a hand-pasted key. */
  readonly accountId: string;
  /** Bumped on every successful save for this account; the unit a late 401 is scoped to. */
  readonly generation: number;
  /** The scope the exchange actually granted, read back from the response. */
  readonly scope: string | null;
  readonly createdAt: string;
  readonly needsReauth: boolean;
  readonly reauthReason: string | null;
}

interface CredentialFile {
  schema: 1;
  credentials: StoredOrcaCredential[];
}

const EMPTY: CredentialFile = { schema: 1, credentials: [] };

export function credentialStorePath(
  env: NodeJS.ProcessEnv = process.env
): string {
  return join(optimizerHome(env), 'orcarouter-credentials.json');
}

/**
 * A key rendered safe to show.
 *
 * Keeps the scheme prefix and the last four characters, which is what makes two keys
 * distinguishable in a status line, and drops everything that identifies the credential.
 */
export function redactKey(key: string | null | undefined): string {
  const text = String(key ?? '');
  if (!text) return '';
  if (text.length <= 12) return '…';
  return `${text.slice(0, 8)}…${text.slice(-4)}`;
}

/**
 * A cheap shape check, and nothing more.
 *
 * An `sk-orca-` prefix is not proof that a credential is valid, and this package has no
 * non-billing endpoint to prove it with, so validation is reported as unknown and the first real
 * request establishes it. Catching an obviously wrong paste is all this is for.
 */
export function looksLikeOrcaKey(value: string): boolean {
  return /^sk-orca-[A-Za-z0-9_-]{8,}$/.test(String(value ?? '').trim());
}

/** Read the store. A missing or unreadable file is an empty store, never a thrown error. */
export async function readCredentialFile(
  env: NodeJS.ProcessEnv = process.env
): Promise<CredentialFile> {
  try {
    const raw = await readFile(credentialStorePath(env), 'utf8');
    const parsed = JSON.parse(raw) as CredentialFile;
    if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.credentials))
      return { ...EMPTY };
    const credentials = parsed.credentials.filter(
      (entry): entry is StoredOrcaCredential =>
        !!entry &&
        typeof entry.key === 'string' &&
        entry.key.length > 0 &&
        (entry.source === 'api-key' || entry.source === 'oauth-pkce')
    );
    return { schema: 1, credentials };
  } catch {
    return { ...EMPTY };
  }
}

async function writeCredentialFile(
  file: CredentialFile,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const path = credentialStorePath(env);
  await mkdir(dirname(path), { recursive: true });
  // Write-then-rename, so a reader sees the whole old file or the whole new one. The temporary
  // name carries random bytes because two saves can overlap when a user retries a paste.
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, path);
  // A file that already existed keeps its old mode through rename only if the rename replaced the
  // inode -- which it did -- but an editor or a backup restore can have loosened it since.
  await chmod(path, 0o600).catch(() => undefined);
}

export interface SaveCredentialInput {
  readonly source: OrcaCredentialSource;
  readonly key: string;
  readonly accountId?: string | null;
  readonly scope?: string | null;
}

/**
 * Store a credential, replacing any previous one for the same source.
 *
 * The generation is per account and monotonic, so a request issued under generation 3 that fails
 * after generation 4 was stored cannot mark 4 as broken.
 */
/**
 * One mutation at a time per store file.
 *
 * Every mutation here is read-modify-rename: it reads the whole file, edits its own snapshot, and
 * renames a replacement over the top. The rename is atomic, so a reader never sees a torn file --
 * but atomicity of the WRITE is not serialization of the SEQUENCE. Two overlapping mutations both
 * read state A; the second one's rename lands last and silently discards the first one's change.
 *
 * That is reachable in normal use, not a theoretical interleaving: the dashboard's key route and
 * the PKCE completion route can be in flight together, and the provider's 401 path calls
 * `markNeedsReauth` from a third place. The user-visible outcomes are losing a credential they
 * just saved, or continuing to use one the upstream already rejected.
 *
 * Scope, stated honestly: this serializes within one process, which is where the races above live
 * (all three callers are the dashboard server). It is NOT an interprocess file lock, so a second
 * process writing the same store concurrently can still clobber.
 */
const storeMutations = new Map<string, Promise<unknown>>();

function withStoreLock<T>(
  env: NodeJS.ProcessEnv,
  mutate: () => Promise<T>
): Promise<T> {
  const path = credentialStorePath(env);
  const previous = storeMutations.get(path) ?? Promise.resolve();
  // `mutate` runs whether the previous mutation resolved or rejected: one failure must not wedge
  // every later mutation behind a permanently rejected promise.
  const result = previous.then(mutate, mutate);
  // The queue holds a settled-normalized promise so an unhandled rejection cannot escape from it.
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  storeMutations.set(path, settled);
  void settled.then(() => {
    if (storeMutations.get(path) === settled) storeMutations.delete(path);
  });
  return result;
}

export async function saveCredential(
  input: SaveCredentialInput,
  env: NodeJS.ProcessEnv = process.env
): Promise<StoredOrcaCredential> {
  return withStoreLock(env, async () => {
    const file = await readCredentialFile(env);
    const accountId = String(input.accountId ?? '').trim() || input.source;
    const previous = file.credentials.filter(
      (entry) => entry.accountId === accountId && entry.source === input.source
    );
    const generation =
      previous.reduce(
        (highest, entry) => Math.max(highest, entry.generation),
        0
      ) + 1;
    const record: StoredOrcaCredential = {
      source: input.source,
      key: input.key,
      accountId,
      generation,
      scope: input.scope ?? null,
      createdAt: new Date().toISOString(),
      needsReauth: false,
      reauthReason: null,
    };
    const credentials = file.credentials.filter(
      (entry) =>
        !(entry.accountId === accountId && entry.source === input.source)
    );
    credentials.push(record);
    await writeCredentialFile({ schema: 1, credentials }, env);
    return record;
  });
}

/** Remove every stored credential for a source. Used by "clear" and by explicit sign-out. */
export async function clearCredentials(
  source: OrcaCredentialSource | null = null,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  return withStoreLock(env, async () => {
    const file = await readCredentialFile(env);
    const kept = source
      ? file.credentials.filter((entry) => entry.source !== source)
      : [];
    const removed = file.credentials.length - kept.length;
    if (removed > 0)
      await writeCredentialFile({ schema: 1, credentials: kept }, env);
    return removed;
  });
}

/**
 * Which credential inference should use, and where it came from.
 *
 * Precedence is deliberate and documented to the user: an explicit `ORCAROUTER_API_KEY` in the
 * environment is an instruction from whoever configured the machine and wins over anything the
 * store holds. After that the most recently saved usable credential wins, regardless of which
 * adapter produced it -- downstream code never asks how a key was obtained.
 */
export interface ResolvedOrcaCredential {
  readonly key: string;
  readonly source: OrcaCredentialSource;
  readonly accountId: string;
  readonly generation: number;
  readonly scope: string | null;
  /** True when the key came from the environment and therefore cannot carry reauth state. */
  readonly ephemeral: boolean;
}

export async function resolveCredential(
  env: NodeJS.ProcessEnv = process.env
): Promise<ResolvedOrcaCredential | null> {
  const fromEnv = String(env.ORCAROUTER_API_KEY ?? '').trim();
  if (fromEnv) {
    return {
      key: fromEnv,
      source: 'api-key',
      accountId: 'api-key:env',
      generation: 0,
      scope: null,
      ephemeral: true,
    };
  }
  const file = await readCredentialFile(env);
  // TIE-BROKEN, because `createdAt` is milliseconds and two adapters can save inside the same one.
  // `Array#sort` is stable, so an untied comparator keeps INSERTION order and hands back the OLDEST
  // of the tied entries -- the exact opposite of the documented "most recently saved wins", and the
  // user silently keeps using the credential they just replaced. Later array position is newer,
  // since `saveCredential` pushes, so position descending is the tie-break.
  const usable = file.credentials
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !entry.needsReauth)
    .sort(
      (a, b) =>
        b.entry.createdAt.localeCompare(a.entry.createdAt) || b.index - a.index
    )
    .map(({ entry }) => entry);
  const chosen = usable[0];
  if (!chosen) return null;
  return {
    key: chosen.key,
    source: chosen.source,
    accountId: chosen.accountId,
    generation: chosen.generation,
    scope: chosen.scope,
    ephemeral: false,
  };
}

export type ReauthOutcome = 'marked' | 'stale-generation' | 'unknown-account';

/**
 * Mark the exact credential that made a rejected request as needing reauthentication.
 *
 * THE GENERATION CHECK IS THE POINT. A request issued under generation 3 can fail after the user
 * has already reauthorized and generation 4 is stored. Flipping `needsReauth` there would take a
 * freshly working credential out of service, which is the failure mode this signature exists to
 * make impossible.
 */
export async function markNeedsReauth(
  rejected: { accountId: string; generation: number },
  reason: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ReauthOutcome> {
  return withStoreLock(env, async () => {
    const file = await readCredentialFile(env);
    const index = file.credentials.findIndex(
      (entry) => entry.accountId === rejected.accountId
    );
    if (index < 0) return 'unknown-account';
    const entry = file.credentials[index];
    if (entry.generation !== rejected.generation) return 'stale-generation';
    const credentials = [...file.credentials];
    credentials[index] = {
      ...entry,
      needsReauth: true,
      reauthReason: reason,
    };
    await writeCredentialFile({ schema: 1, credentials }, env);
    return 'marked';
  });
}
