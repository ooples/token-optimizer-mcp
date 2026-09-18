/**
 * On by default for a client we did not launch.
 *
 * THE PROBLEM THIS SOLVES. Everything else here routes a client by setting a variable in the
 * process we spawn, which only reaches people who type `claude` in a shell we wrapped. The
 * documented install is `/plugin`, and those users start Claude Code from a shortcut, an IDE or a
 * desktop app -- so compression was off for them, and the doctor reported that as a broken install
 * rather than as a feature that never applied.
 *
 * Claude Code reads `env` from settings.json at startup, which is the one lever that reaches a
 * session we did not start. Using it means writing to a file the user owns, so:
 *
 *   RECORDED. Every value we write is recorded in our own manifest next to what was there before.
 *   Removal restores the previous value exactly, and refuses when the current value is not the one
 *   we wrote -- a user who edited it since owns it again.
 *
 *   NEVER WRITTEN ON HOPE. The entry is written only after the supervisor has actually served the
 *   route, because a settings file naming a dead port does not degrade politely: Claude Code cannot
 *   reach Anthropic at all.
 *
 *   SELF-HEALING. Session start calls this again. If the supervisor cannot be brought up, the entry
 *   is removed there and then, so at most one session is affected and the next one is clean.
 *
 *   THE USER'S ENDPOINT IS THE UPSTREAM. Someone already pointed at a gateway or a proxy of their
 *   own keeps reaching it; we insert ourselves in front of that value and record it as the one to
 *   restore.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface RoutingEntry {
  readonly variable: string;
  readonly value: string;
  /** What the file said before we ever touched it; absent when the variable was not set. */
  readonly previous?: string;
  readonly upstream: string;
  readonly writtenAt: string;
}

export interface RoutingManifest {
  readonly schema: 1;
  readonly entries: Record<string, RoutingEntry>;
}

/** A settings file is the user's; we know about one key in it and carry the rest untouched. */
interface Settings {
  env?: Record<string, string>;
  [key: string]: unknown;
}

type Inspection =
  | { readonly foreign: true }
  | {
      readonly foreign: false;
      readonly upstream: string;
      readonly original?: string;
    };

export interface RoutingResult {
  readonly status:
    | 'written'
    | 'unchanged'
    | 'removed'
    | 'healed'
    | 'absent'
    | 'disabled'
    | 'no-client'
    | 'unreadable'
    | 'unavailable'
    | 'foreign-proxy'
    | 'user-owned';
  readonly path?: string;
  readonly url?: string;
  readonly upstream?: string;
}

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
const VARIABLE = 'ANTHROPIC_BASE_URL';

const disabled = (value: unknown): boolean =>
  /^(0|false|no|off)$/i.test(String(value || '').trim());

export function optimizerHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.TOKEN_OPTIMIZER_HOME || join(homedir(), '.token-optimizer');
}

/** Claude Code's user settings file. */
export function claudeSettingsFile(
  env: NodeJS.ProcessEnv = process.env
): string {
  return (
    env.TOKEN_OPTIMIZER_SETTINGS || join(homedir(), '.claude', 'settings.json')
  );
}

/** Where we record what we wrote, so it can be taken back out exactly. */
export function routingManifestFile(
  env: NodeJS.ProcessEnv = process.env
): string {
  return join(optimizerHome(env), 'default-routing.json');
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

export function readRoutingManifest(
  env: NodeJS.ProcessEnv = process.env
): RoutingManifest {
  const parsed = readJson(routingManifestFile(env)) as RoutingManifest | null;
  return parsed?.schema === 1 ? parsed : { schema: 1, entries: {} };
}

/**
 * May we write to a client's own configuration at all?
 *
 * Three separate refusals, because they mean different things: the whole product being off, request
 * compression being off, and this one mechanism being declined by someone who is happy to keep
 * launching through the wrapper.
 */
export function defaultRoutingAllowed(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (
    String(env.TOKEN_OPTIMIZER_MODE || '')
      .trim()
      .toLowerCase() === 'off'
  )
    return false;
  if (disabled(env.TOKEN_OPTIMIZER_PROXY)) return false;
  if (disabled(env.TOKEN_OPTIMIZER_DEFAULT_ROUTING)) return false;
  return true;
}

function pointsAtLoopback(value: unknown): boolean {
  try {
    const host = new URL(String(value)).hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase();
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * What is in the file now, and what it means for us.
 *
 * A LOOPBACK VALUE WE DID NOT WRITE IS SOMEONE ELSE'S PROXY -- a corporate recorder, a local model
 * gateway, another tool like this one. Forwarding to it could as easily be forwarding to ourselves,
 * and replacing it would silently take that tool out of the path, so the only correct move is to
 * leave the file alone.
 */
function inspect(
  settings: Settings,
  recorded: RoutingEntry | undefined
): Inspection {
  const configured = settings?.env?.[VARIABLE];
  // Ours only when the file still holds the exact value we recorded writing.
  const mine = recorded && configured === recorded.value ? recorded : undefined;
  if (configured && pointsAtLoopback(configured) && !mine)
    return { foreign: true };
  // On a rewrite the upstream is the one we recorded, never the route we ourselves installed.
  return {
    foreign: false,
    upstream: (mine ? mine.previous : configured) || DEFAULT_UPSTREAM,
    original: mine ? mine.previous : configured,
  };
}

function loadSettings(path: string): {
  settings: Settings;
  existed: boolean;
  unreadable: boolean;
} {
  if (!existsSync(path))
    return { settings: {}, existed: false, unreadable: false };
  const parsed = readJson(path) as Settings | null;
  // Refuse rather than clobber, exactly as wire-hooks.mjs does: a settings file we cannot parse is
  // one we certainly did not write.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return { settings: {}, existed: true, unreadable: true };
  return { settings: parsed, existed: true, unreadable: false };
}

function saveSettings(path: string, settings: Settings): void {
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.backup`);
    } catch {
      /* a failed backup is not a reason to refuse a reversible change */
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function record(env: NodeJS.ProcessEnv, entry: RoutingEntry | null): void {
  const manifest = readRoutingManifest(env);
  const path = claudeSettingsFile(env);
  if (entry) manifest.entries[path] = entry;
  else delete manifest.entries[path];
  writeJson(routingManifestFile(env), manifest);
}

/**
 * Take our entry back out, restoring what was there before.
 *
 * Refuses when the file no longer holds the value we wrote: that means the user has changed it since
 * and restoring "our" previous value would overwrite their choice.
 */
export function removeDefaultRouting(
  env: NodeJS.ProcessEnv = process.env
): RoutingResult {
  const path = claudeSettingsFile(env);
  const recorded = readRoutingManifest(env).entries[path];
  if (!recorded) return { status: 'absent' };
  const { settings, unreadable } = loadSettings(path);
  if (unreadable) return { status: 'unreadable', path };
  const current = settings?.env?.[VARIABLE];
  if (current !== undefined && current !== recorded.value) {
    record(env, null);
    return { status: 'user-owned', path };
  }
  if (settings.env) {
    if (recorded.previous === undefined) delete settings.env[VARIABLE];
    else settings.env[VARIABLE] = recorded.previous;
    if (Object.keys(settings.env).length === 0) delete settings.env;
    saveSettings(path, settings);
  }
  record(env, null);
  return { status: 'removed', path };
}

/**
 * Point Claude Code at the proxy, or take the entry back out when we cannot serve it.
 *
 * `route` is injected: this module must not import the compiled supervisor, because the hooks that
 * call it are also copied into client integrations that do not ship `dist/`.
 */
export async function applyDefaultRouting(
  route: (upstream: string) => Promise<string | null>,
  env: NodeJS.ProcessEnv = process.env
): Promise<RoutingResult> {
  const path = claudeSettingsFile(env);
  if (!defaultRoutingAllowed(env)) {
    // Turning it off has to actually undo it, or the setting would only stop FUTURE changes while
    // leaving the last one in place.
    return readRoutingManifest(env).entries[path]
      ? removeDefaultRouting(env)
      : { status: 'disabled' };
  }
  // Claude Code not being installed is not a failure; there is simply nothing to configure.
  if (!existsSync(path) && !readRoutingManifest(env).entries[path])
    return { status: 'no-client' };

  const { settings, unreadable } = loadSettings(path);
  if (unreadable) return { status: 'unreadable', path };
  const recorded = readRoutingManifest(env).entries[path];
  const state = inspect(settings, recorded);
  if (state.foreign) return { status: 'foreign-proxy', path };
  const upstream: string = state.upstream;
  const original = state.original;

  let url: string | null = null;
  try {
    url = await route(upstream);
  } catch {
    url = null;
  }
  if (!url) {
    // THE SELF-HEAL. Our entry names a port we have just failed to serve, so leaving it would point
    // Claude Code at nothing on its next start. Removing it costs compression and restores a
    // working client.
    return recorded
      ? { ...removeDefaultRouting(env), status: 'healed' }
      : { status: 'unavailable' };
  }
  if (settings.env?.[VARIABLE] === url && recorded?.value === url)
    return { status: 'unchanged', path, url, upstream };

  settings.env = { ...settings.env, [VARIABLE]: url };
  saveSettings(path, settings);
  record(env, {
    variable: VARIABLE,
    value: url,
    // What the file said before we ever touched it, captured before the write above. Re-deriving it
    // on a later pass would record our own route as the thing to restore.
    previous: original,
    upstream,
    writtenAt: new Date().toISOString(),
  });
  return { status: 'written', path, url, upstream };
}

/**
 * The real endpoint behind a value that may be a route we installed.
 *
 * WHY THE LAUNCHER NEEDS THIS. Once settings.json names our loopback route, anything that reads that
 * file to decide where a client is pointed -- `token-optimizer-run claude`, most of all -- would
 * take our own proxy for the provider and start a second proxy in front of the first. That chain
 * works only for as long as both are up, and it compresses already-compressed traffic.
 *
 * Recognised by the manifest, not by being loopback: a user running their own local gateway is
 * pointed somewhere real, and we must keep forwarding to it.
 */
export function originalUpstream(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (!value) return value;
  const recorded = readRoutingManifest(env).entries[claudeSettingsFile(env)];
  if (!recorded || recorded.value !== value) return value;
  return recorded.previous ?? DEFAULT_UPSTREAM;
}

/**
 * Ensure the route and write it where a client we did not launch will read it.
 *
 * Fire-and-forget: every failure inside is a reason to leave the user's configuration as it is, and
 * none of them is a reason to fail whatever called this.
 */
export async function maintainDefaultRouting(
  env: NodeJS.ProcessEnv = process.env
): Promise<RoutingResult> {
  try {
    const { ensureRoute } = await import('./supervisor.js');
    return await applyDefaultRouting(
      (upstream) => ensureRoute(upstream, env),
      env
    );
  } catch {
    return { status: 'unavailable' };
  }
}
