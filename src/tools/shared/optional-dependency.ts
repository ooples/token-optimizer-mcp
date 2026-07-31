/**
 * Loading a heavy dependency only if the tool that needs it is actually used.
 *
 * Eleven packages were imported at module top level and shipped in nobody's
 * install -- `typescript`, `@babel/parser`, `@typescript-eslint/typescript-estree`,
 * `prettier`, `react` and others were devDependencies or absent entirely. On a
 * developer's machine they resolve out of node_modules and everything looks
 * fine. On a user's machine `npm i -g` installs only `dependencies`, so around
 * twelve advertised MCP tools threw
 *
 *     Cannot find package 'typescript' imported from ...
 *
 * the moment anything touched them. Dead on arrival, with an error that tells
 * the user nothing about what to do.
 *
 * The small dependencies are now declared and simply work. The heavy ones --
 * a TypeScript compiler is 20 MB, and most sessions never run a code-analysis
 * tool -- load on first use through here, so:
 *
 *   - installing the package stays cheap for the people who never need them
 *   - a tool that cannot run says WHICH package is missing and the exact
 *     command that fixes it
 *   - the failure happens when the tool is called, not when it is imported, so
 *     one missing optional package cannot take the whole server down
 *
 * `cache-compression` already did this correctly for lz4/zstd/snappy. This is
 * that pattern, made shared and given a decent error message.
 */

/** Cached per specifier, so the cost is paid once per process. */
const loaded = new Map<string, unknown>();

export class MissingOptionalDependency extends Error {
  constructor(
    readonly packageName: string,
    readonly toolName: string,
    readonly why: string
  ) {
    super(
      `${toolName} needs the optional package "${packageName}", which is not installed.\n` +
        `  ${why}\n` +
        `  Install it with:  npm install -g ${packageName}\n` +
        `  Every other tool keeps working without it.`
    );
    this.name = 'MissingOptionalDependency';
  }
}

/**
 * Imports an optional package, or explains precisely why it could not.
 *
 * @param packageName what to import, exactly as it would be typed into npm
 * @param toolName    the tool asking, so the message names something the user
 *                    recognises rather than a file path
 * @param why         one line on what the package is for, so the user can
 *                    decide whether they want it at all
 */
export async function optionalDependency<T = unknown>(
  packageName: string,
  toolName: string,
  why: string
): Promise<T> {
  const cached = loaded.get(packageName);
  if (cached !== undefined) return cached as T;

  try {
    const mod = await import(/* @vite-ignore */ packageName);
    // Interop: CJS packages arrive under `default`, ESM ones do not.
    const resolved = (mod as { default?: unknown }).default ?? mod;
    loaded.set(packageName, resolved);
    return resolved as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A package that exists but fails to load is a different problem, and
    // pretending it is missing would send the user to reinstall something they
    // already have.
    if (!/Cannot find (package|module)/i.test(message)) {
      throw new Error(`${toolName} could not load "${packageName}": ${message}`);
    }
    throw new MissingOptionalDependency(packageName, toolName, why);
  }
}

/** Whether an optional package is available, without throwing. */
export async function hasOptionalDependency(packageName: string): Promise<boolean> {
  try {
    await optionalDependency(packageName, 'availability check', '');
    return true;
  } catch {
    return false;
  }
}
