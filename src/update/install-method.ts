/**
 * How this copy of the package got onto the machine, and therefore how it is
 * upgraded.
 *
 * ONE ANSWER PER INSTALL, DERIVED FROM OUR OWN PATH rather than from the
 * environment, because the environment belongs to whatever launched us. An MCP
 * server is started by a client, not by a shell, so `npm_config_global`,
 * `npm_lifecycle_event` and the rest are absent exactly when this question is
 * being asked. The directory the built module sits in, however, is always
 * present and is the thing npm actually placed.
 *
 * WHY THE METHOD AND NOT JUST A VERSION: `npm install -g` fixes a stale global
 * and does nothing for a stale copy inside a project's `node_modules`, and
 * neither touches a plugin install. Reporting "you are behind" without the
 * command that ends it leaves the reader to guess among three answers, two of
 * which silently do nothing.
 */

/** The ways this package is installed, and the only values `detect` returns. */
export enum InstallMethod {
  /** `npm install -g` -- one copy, on the PATH, shared by every client. */
  GlobalNpm = 'GlobalNpm',
  /** An `npx`/`npm exec` cache entry, which is replaced rather than upgraded. */
  NpxCache = 'NpxCache',
  /** A dependency of some project's `package.json`. */
  ProjectDependency = 'ProjectDependency',
  /** Installed as a Claude Code plugin, upgraded through the plugin surface. */
  ClaudePlugin = 'ClaudePlugin',
  /** A git checkout being built in place -- upgraded with `git pull`. */
  SourceCheckout = 'SourceCheckout',
  /** Somewhere none of the above describes. Reported, never guessed at. */
  Unknown = 'Unknown',
}

/** The npm name this package publishes under, used for the upgrade commands. */
export const PACKAGE_NAME = '@ooples/token-optimizer-mcp';

/**
 * Where the built module lives, as path segments.
 *
 * TAKEN FROM `import.meta.url` OF THE CALLER rather than of this file so a test
 * can ask the question about a path that does not exist on the test machine.
 * Passing the URL in is also the only way to keep this function pure: reading
 * `import.meta.url` here would answer about the compiled `dist/update/` copy in
 * every case, including the cases a test is trying to describe.
 */
function segmentsOf(moduleUrl: string): string[] {
  let pathname: string;
  try {
    const parsed = new URL(moduleUrl);
    // A URL that is not a file URL tells us nothing about an install, and
    // throwing here would take down a diagnostic. No segments is the answer.
    if (parsed.protocol !== 'file:') return [];
    // THE PATHNAME, NOT `fileURLToPath`. That helper answers for the platform it
    // runs on -- it rejects a POSIX path on Windows and a drive letter on
    // POSIX -- so using it would make this function unable to answer about the
    // other platform's install layout, which is exactly what its tests ask.
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return [];
  }
  return pathname.split(/[\\/]/).filter((part) => part.length > 0);
}

/**
 * Two segments in a row, case-insensitively, anywhere in the path.
 *
 * Not a regex over the joined path: a Windows path contains `\`, which would
 * have to be escaped into every pattern, and a directory named with a regex
 * metacharacter would quietly change what matched.
 */
function hasRun(segments: string[], run: string[]): boolean {
  const lower = segments.map((part) => part.toLowerCase());
  for (let at = 0; at + run.length <= lower.length; at += 1)
    if (run.every((want, i) => lower[at + i] === want)) return true;
  return false;
}

/** Which install this is. Never throws; `Unknown` is a real answer. */
export function detectInstallMethod(moduleUrl: string): InstallMethod {
  const segments = segmentsOf(moduleUrl);
  if (segments.length === 0) return InstallMethod.Unknown;

  // A plugin install is checked FIRST because it also sits under a
  // `node_modules`, and the plugin surface is what upgrades it -- answering
  // `ProjectDependency` here would hand the reader an `npm install` that
  // updates a directory the plugin loader does not read.
  if (hasRun(segments, ['.claude', 'plugins']))
    return InstallMethod.ClaudePlugin;
  if (hasRun(segments, ['claude', 'plugins']))
    return InstallMethod.ClaudePlugin;

  // `npx` unpacks into `_npx/<hash>/node_modules/...`. It is not upgraded: the
  // next invocation with `@latest` fetches a new one.
  if (segments.some((part) => part.toLowerCase() === '_npx'))
    return InstallMethod.NpxCache;

  const inNodeModules = segments.some(
    (part) => part.toLowerCase() === 'node_modules'
  );
  if (!inNodeModules) return InstallMethod.SourceCheckout;

  // The global root, on both platforms npm uses. POSIX puts it under
  // `<prefix>/lib/node_modules`; npm for Windows puts it under
  // `<prefix>/node_modules` where the prefix directory is itself `npm`.
  if (hasRun(segments, ['lib', 'node_modules'])) return InstallMethod.GlobalNpm;
  if (hasRun(segments, ['npm', 'node_modules'])) return InstallMethod.GlobalNpm;

  return InstallMethod.ProjectDependency;
}

/**
 * What to run to stop being behind, or null when there is nothing to run.
 *
 * A NULL IS NOT A FAILURE. `SourceCheckout` and `Unknown` are installs this
 * package did not place and cannot speak for, and printing a plausible-looking
 * `npm install -g` for a git checkout would replace a developer's working tree
 * with a published copy. Saying nothing is the correct answer there.
 */
export function upgradeCommand(method: InstallMethod): string | null {
  switch (method) {
    case InstallMethod.GlobalNpm:
      return `npm install -g ${PACKAGE_NAME}@latest`;
    case InstallMethod.ProjectDependency:
      return `npm install ${PACKAGE_NAME}@latest`;
    case InstallMethod.NpxCache:
      // Nothing to upgrade: the cache entry is immutable and the next run with
      // an explicit `@latest` replaces it.
      return `npx -y ${PACKAGE_NAME}@latest`;
    case InstallMethod.ClaudePlugin:
      return '/plugin update token-optimizer';
    case InstallMethod.SourceCheckout:
    case InstallMethod.Unknown:
      return null;
  }
}

/**
 * The methods `token-optimizer-update` will upgrade in place.
 *
 * Narrower than the set with an `upgradeCommand`, deliberately. `NpxCache` has
 * a command, but that command RUNS the package rather than upgrading anything,
 * so performing it would report success having changed nothing. `ClaudePlugin`
 * is the client's to upgrade, and `SourceCheckout` would have a developer's
 * working tree replaced by the published tarball.
 *
 * It lives here rather than beside `applyUpdate` because it is a property of
 * the install method, and both the applier and the diagnostic line that names
 * the command need it -- and `apply.ts` already imports `check.ts`, so a home
 * there would make that pair circular.
 */
export const UPGRADABLE_METHODS: readonly InstallMethod[] = Object.freeze([
  InstallMethod.GlobalNpm,
  InstallMethod.ProjectDependency,
]);

/** How the method reads in a diagnostic line. */
export function describeInstallMethod(method: InstallMethod): string {
  switch (method) {
    case InstallMethod.GlobalNpm:
      return 'a global npm install';
    case InstallMethod.ProjectDependency:
      return "a project's node_modules";
    case InstallMethod.NpxCache:
      return 'an npx cache entry';
    case InstallMethod.ClaudePlugin:
      return 'a Claude Code plugin';
    case InstallMethod.SourceCheckout:
      return 'a source checkout';
    case InstallMethod.Unknown:
      return 'an install this package cannot identify';
  }
}
