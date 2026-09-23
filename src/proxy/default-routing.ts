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

/* eslint-disable n/no-sync -- SYNCHRONOUS THROUGHOUT, ON PURPOSE, for the reason supervisor.ts and
 * accounting.ts record. This module decides whether a client's own settings file names a live route,
 * and it is called from three places that cannot await it usefully: a doctor that reports
 * synchronously, an installer that must finish before it prints, and the MCP server's startup path
 * where an interleaved write is the failure mode. The payloads are a settings file and a manifest of
 * a few hundred bytes, and the one write that matters is write-then-rename, which is what makes a
 * reader see either the old file or the new one and never half of one. Awaiting these would buy no
 * concurrency and would let two passes interleave mid-write. */
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
  /** Whether the settings file had no `env` object at all before we wrote one. */
  readonly createdEnv?: boolean;
  /**
   * Whether WE added ENABLE_TOOL_SEARCH alongside the route.
   *
   * Recorded rather than inferred so removal undoes exactly what it did: a user who set the
   * flag themselves must keep it, and we must not leave ours behind.
   */
  readonly toolSearchAdded?: boolean;
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
const TOOL_SEARCH = 'ENABLE_TOOL_SEARCH';

/**
 * Loopback routing must not turn off Claude Code’s own tool deferral.
 *
 * POINTED AT ANY NON-ANTHROPIC BASE URL, Claude Code stops deferring its tool schemas and sends
 * every one inline. Tool schemas are roughly half a real request, so installing our route costs
 * that much payload on every turn before we have compressed anything -- and the client had been
 * doing the deferral for free. `ENABLE_TOOL_SEARCH` keeps it on through the route.
 *
 * The same decision already exists in scripts/claude-routing.mjs for the launcher path; this is
 * the settings path, which is how most installs are actually routed, and it had no equivalent.
 *
 * Three conditions, all of them about not overriding a deliberate choice: a third-party backend
 * is not ours to touch, an explicit value is the user’s, and a route that forwards somewhere
 * other than Anthropic’s API is a gateway whose behaviour we should not assume.
 *
 * OWNERSHIP IS A SEPARATE QUESTION FROM ELIGIBILITY, and collapsing the two is what made this
 * wrong. "An explicit value is the user’s" reads OUR OWN flag as the user’s on the second pass,
 * so a route rewrite recorded `toolSearchAdded: false` while the spread carried the flag
 * forward -- removal then left our value behind for good. `ours` is the answer to the other
 * question, from the manifest, and it suspends only the presence check.
 */
function toolSearchAppropriate(
  settings: Settings,
  upstream: string,
  env: NodeJS.ProcessEnv
): boolean {
  const external = [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  ].some((key) =>
    /^(1|true|yes|on)$/i.test(
      String(settings.env?.[key] ?? env[key] ?? '').trim()
    )
  );
  if (external) return false;
  // BY ORIGIN, NOT BY STRING. `https://api.anthropic.com/` is the same endpoint
  // written with the trailing slash a URL bar adds, and a string comparison
  // calls it a gateway -- which would not merely decline to add the flag, it
  // would take an existing one of ours back out. `scripts/claude-routing.mjs`
  // already decides this by origin; this is the same rule.
  return sameOrigin(upstream, DEFAULT_UPSTREAM);
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function shouldPreserveToolSearch(
  settings: Settings,
  upstream: string,
  env: NodeJS.ProcessEnv,
  ours: boolean
): boolean {
  if (!toolSearchAppropriate(settings, upstream, env)) return false;
  if (!ours && settings.env?.[TOOL_SEARCH] !== undefined) return false;
  if (env[TOOL_SEARCH] !== undefined) return false;
  return true;
}

/**
 * Is the flag in the file still the one we wrote?
 *
 * The same test removal uses (`toolSearchAdded` and the value untouched), because the two have to
 * agree: anything this calls ours is something removal will take back out, and anything it does
 * not is a value we must leave exactly where it is.
 */
function toolSearchIsOurs(
  settings: Settings,
  recorded: RoutingEntry | undefined
): boolean {
  return (
    recorded?.toolSearchAdded === true && settings.env?.[TOOL_SEARCH] === 'true'
  );
}

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
    env.TOKEN_OPTIMIZER_SETTINGS ||
    join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
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
    // Ours to remove only if we added it AND nobody has changed it since. A user who edited the
    // value in between has adopted it, and removal must leave their choice alone.
    if (recorded.toolSearchAdded && settings.env[TOOL_SEARCH] === 'true')
      delete settings.env[TOOL_SEARCH];
    // Only tidy away an `env` object we created. Deleting one the user already had -- even an empty
    // one -- would mean removal did not return the file to what it was, and this file is the whole
    // reason to trust the feature.
    if (recorded.createdEnv && Object.keys(settings.env).length === 0)
      delete settings.env;
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
  // Starting a supervisor yields to other processes. Hook migration or a user edit may have
  // changed settings while we waited; merge into the current file, not the earlier snapshot.
  const {
    settings: latest,
    existed: stillExists,
    unreadable: changedUnreadable,
  } = loadSettings(path);
  if (changedUnreadable) return { status: 'unreadable', path };
  if (!stillExists) return { status: 'user-owned', path };
  if (latest.env?.[VARIABLE] !== settings.env?.[VARIABLE])
    return { status: 'user-owned', path };

  // READ FROM `latest` FOR THE SAME REASON THE WRITE GOES THERE. The snapshot taken before the
  // await describes a file somebody may have edited since, and who owns the tool-search flag is
  // exactly the kind of thing such an edit changes.
  const ours = toolSearchIsOurs(latest, recorded);
  // TWO DIFFERENT REASONS NOT TO WRITE IT, and only one of them is a reason to take it back.
  // "We must not assert this" -- a third-party backend, or a route forwarding to a gateway --
  // means a flag of ours in the file is wrong and has to go. "Someone else is already asserting
  // it" does not: `scripts/run-client.mjs` puts ENABLE_TOOL_SEARCH in the environment of the
  // Claude it launches, so an MCP server running inside that child sees it set and would
  // otherwise delete the settings entry that serves every OTHER way the user starts Claude.
  const appropriate = toolSearchAppropriate(latest, upstream, env);
  const addToolSearch = shouldPreserveToolSearch(latest, upstream, env, ours);
  const takeBack = ours && !appropriate;

  if (latest.env?.[VARIABLE] === url && recorded?.value === url) {
    // OUR FLAG CAN OUTLIVE THE REASON FOR IT. The route has not moved, so there is nothing to
    // write -- but a later session may have turned on Bedrock, Vertex or Foundry, and nothing
    // else would ever take the flag back out: removal only runs when routing is switched off
    // altogether, and a third-party backend does not switch routing off.
    if (takeBack && latest.env) {
      delete latest.env[TOOL_SEARCH];
      saveSettings(path, latest);
    } else if (addToolSearch && latest.env?.[TOOL_SEARCH] === undefined) {
      // AND THE REASON CAN OUTLIVE THE FLAG. A route installed by a build that predates this
      // feature leaves the entry missing for ever, because the only other place we write it is
      // the branch that runs when the route MOVES -- and upgrading does not move the port.
      // Absent means writable here for the same reason it does in `scripts/claude-routing.mjs`,
      // which reads `ENABLE_TOOL_SEARCH === undefined` as permission to set it: switching
      // deferral off is done by giving the key a value, and a value is what `ours` protects.
      latest.env = { ...latest.env, [TOOL_SEARCH]: 'true' };
      saveSettings(path, latest);
    }
    // OWNERSHIP IS RECONCILED EVEN WHEN NOTHING WAS WRITTEN. A user who edits the flag to
    // something other than what we wrote has taken it over, and leaving `toolSearchAdded` true
    // would have `removeDefaultRouting` delete their value later on our behalf.
    const stillOurs = addToolSearch || (ours && appropriate);
    if (recorded && recorded.toolSearchAdded !== stillOurs)
      record(env, { ...recorded, toolSearchAdded: stillOurs });
    return { status: 'unchanged', path, url, upstream };
  }

  const createdEnv = recorded ? recorded.createdEnv : latest.env === undefined;
  latest.env = { ...latest.env, [VARIABLE]: url };
  // Written when we want it, taken out when it is ours and asserting it has become wrong, and
  // otherwise carried through by the spread. Never touched when it is the user’s: that is the
  // whole of `ours`.
  if (addToolSearch) latest.env[TOOL_SEARCH] = 'true';
  else if (takeBack) delete latest.env[TOOL_SEARCH];
  saveSettings(path, latest);
  record(env, {
    variable: VARIABLE,
    value: url,
    createdEnv,
    // Ownership survives a pass that did not write, as long as the value is still ours and still
    // right; it is given up the moment we stop being the one asserting it.
    toolSearchAdded: addToolSearch || (ours && appropriate),
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
  const recorded = Object.values(readRoutingManifest(env).entries).filter(
    (entry) => entry?.value === value
  );
  if (!recorded.length) return value;
  const upstreams = new Set(
    recorded.map((entry) => entry.upstream || entry.previous)
  );
  if (upstreams.size !== 1 || ![...upstreams][0])
    throw new Error(
      'Ambiguous proxy ownership; restore the provider endpoint before launching.'
    );
  return [...upstreams][0];
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
