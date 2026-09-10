/**
 * The engine registry: one path for ours and anybody else's.
 *
 * WHY THIS EXISTS. The router was a `switch` over five engines, so a user with
 * a proprietary log format, a domain payload or simply a better compressor than
 * ours had nowhere to put it. HeadRoom ships six fixed engines and the same
 * closed door; an extension point is the cheapest way to be beaten less often,
 * because the next content type is always one nobody anticipated.
 *
 * NO PRIVILEGED TIER. The built-ins register through this exactly as a third
 * party does, so there is one code path to test and no "works for us, breaks
 * for you" class of bug. A custom engine can also claim content ahead of a
 * built-in, because a user who knows their own format knows better than our
 * heuristics do.
 *
 * THE BOUNDARY IS THE SAME GUARANTEE WE HOLD OURSELVES TO, not a sandbox:
 *
 *   - output larger than input is discarded;
 *   - a throw is caught and the input passes through untouched;
 *   - a lossy elision with nowhere to recover from is refused outright;
 *   - signed content never reaches any engine, which the strategy enforces
 *     before dispatch.
 *
 * That last rule is the one that catches honest mistakes rather than hostile
 * ones, and it caught one of ours the day it was written.
 *
 * NOT A SANDBOX, and the docs should say so plainly: a registered engine runs
 * in this process and sees the content it is given. Registering one is the same
 * trust decision as installing any dependency.
 */

import type { CompressionResult, Engine, EngineContext } from './types.js';
import { unchanged } from './types.js';

export interface EngineRegistration {
  /** Stable identifier, used in diagnostics and to replace a registration. */
  readonly name: string;
  /**
   * Higher runs first. Built-ins register at 0, so a custom engine claiming
   * content ahead of them uses any positive number, and a fallback uses a
   * negative one.
   */
  readonly priority?: number;
  /** Does this engine want the block? Must be pure and cheap. */
  readonly claims: (text: string, ctx: EngineContext) => boolean;
  /** The transform itself. */
  readonly compress: Engine;
}

interface Registered extends EngineRegistration {
  readonly priority: number;
}

/**
 * Module-level, and deliberately not a class.
 *
 * The registry is configuration, not per-request state -- the thing HeadRoom's
 * #3486 got wrong was keeping REQUEST state on a shared router. Registrations
 * are immutable once added and every engine remains a pure function of its
 * arguments, so concurrent calls cannot observe each other.
 */
const engines: Registered[] = [];

/** Registers an engine, replacing any earlier one with the same name. */
export function registerEngine(engine: EngineRegistration): void {
  if (!engine?.name) throw new Error('a compression engine needs a name');
  if (
    typeof engine.claims !== 'function' ||
    typeof engine.compress !== 'function'
  ) {
    throw new Error(
      `compression engine ${engine.name} needs claims() and compress()`
    );
  }
  const existing = engines.findIndex((e) => e.name === engine.name);
  const entry: Registered = { ...engine, priority: engine.priority ?? 0 };
  if (existing === -1) engines.push(entry);
  else engines[existing] = entry;
  engines.sort((a, b) => b.priority - a.priority);
}

/** Removes one engine by name. Returns whether anything was removed. */
export function unregisterEngine(name: string): boolean {
  const at = engines.findIndex((e) => e.name === name);
  if (at === -1) return false;
  engines.splice(at, 1);
  return true;
}

/** Every registration, highest priority first. For diagnostics and tests. */
export function registeredEngines(): readonly EngineRegistration[] {
  return engines.slice();
}

/**
 * The first engine that claims this block, or null.
 *
 * A `claims` predicate that throws is treated as "does not claim" rather than
 * being allowed to take down the request -- fail open applies to the decision
 * as well as to the transform.
 */
export function engineFor(
  text: string,
  ctx: EngineContext
): EngineRegistration | null {
  for (const engine of engines) {
    try {
      if (engine.claims(text, ctx)) return engine;
    } catch {
      // A broken claim is not a reason to stop compressing everything else.
    }
  }
  return null;
}

/**
 * Runs one engine behind the boundary.
 *
 * Exported so the rules are testable directly rather than only through the
 * router, and so a caller composing engines gets the same guarantees.
 */
export function runEngine(
  engine: EngineRegistration,
  text: string,
  ctx: EngineContext
): CompressionResult {
  let result: CompressionResult;
  try {
    result = engine.compress(text, ctx);
  } catch {
    // A throwing engine costs nothing but its own output.
    return unchanged(text);
  }

  if (
    !result ||
    typeof result.text !== 'string' ||
    !Array.isArray(result.elisions)
  ) {
    return unchanged(text);
  }

  // Compression that adds tokens is a defect other systems have shipped, and
  // measuring is cheaper than trusting.
  if (result.text.length >= text.length) return unchanged(text);

  // AN UNRECOVERABLE LOSSY ELISION IS NOT A TRADE WE MAKE. If a transform
  // cannot say where the content went, the content stays. `code` already
  // declines on exactly this condition; enforcing it here means every engine
  // does, including one we did not write.
  //
  // PER ELISION, NOT PER RESULT, and the difference is not pedantry. A JSON
  // document whose whitespace and null keys were removed losslessly AND whose
  // repeating tail was elided has a LOSSY RESULT containing two LOSSLESS
  // elisions. Judging the result rejected the whole document and took three
  // workloads to 0.0% -- caught the day this boundary was written, which is
  // what it is for.
  if (result.elisions.some((e) => !e.lossless && !e.recoverAt)) {
    return unchanged(text);
  }

  return result;
}
