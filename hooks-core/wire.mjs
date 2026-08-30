/**
 * Wiring our hooks into a settings file without destroying anybody else's.
 *
 * The installer this replaces did one of two things depending on whether `jq`
 * happened to be present: with it, a shallow merge that REPLACED the whole
 * `hooks` object; without it, a straight overwrite of the entire settings file.
 * Both destroyed every hook the user had configured, which is the exact
 * behaviour the uninstaller promises we never engage in -- and it was silent.
 *
 * So the merge lives here, in one tested implementation both installers call,
 * with three rules:
 *
 *   ADDITIVE     Entries we do not recognise are left exactly as they are, in
 *                their original order. We append; we never rewrite.
 *   IDEMPOTENT   Running the installer twice produces one set of entries, not
 *                two. Ours are identified by a marker in the command string
 *                rather than by position, so an entry that has moved is still
 *                ours and one that appeared at our old index is not.
 *   REVERSIBLE   The same identification drives unwiring, so removal takes out
 *                exactly what installation put in.
 */

/** Anything containing this in its command is ours. */
export const MARKER = 'token-optimizer';

/** The events we wire, and which hook file serves each. */
/**
 * Every event this product needs, for the SCRIPT install path.
 *
 * THIS LIST WAS MISSING HALF THE PRODUCT. It carried SessionStart, PreToolUse
 * and PreCompact only, while plugin/hooks/hooks.json -- the manifest a plugin
 * install reads -- also registers PostToolUse and Stop. Nothing compared the
 * two, so the drift was invisible to every gate: `sync:hooks:check` verifies
 * that the vendored hook SOURCES match hooks-core and says nothing about which
 * events an install actually registers.
 *
 * What a script install therefore lost:
 *
 *   PostToolUse   no tool-outcome capture, no authored-content store, no eager
 *                 staleness marking -- the measurement half records nothing
 *   Stop          no harvest at all -- the LEARNING half never runs, so the
 *                 knowledge graph stays empty however long the session ran
 *
 * A hook that is never invoked is indistinguishable from a hook that decides to
 * do nothing, which is exactly why this survived: the code was present, tested
 * and correct, and simply never called on that path.
 *
 * tests/hooks/install-paths-agree.test.mjs now compares this list against the
 * manifest, event by event and matcher by matcher.
 */
export const WIRING = [
  { event: 'SessionStart', file: 'session-start.mjs', matcher: null },
  { event: 'PreToolUse', file: 'pretooluse-router.mjs', matcher: 'Read|Grep|Glob|Edit|MultiEdit|Write|Bash|PowerShell|WebFetch|WebSearch' },
  { event: 'PostToolUse', file: 'post-tool.mjs', matcher: 'Edit|MultiEdit|Write|Bash|PowerShell|mcp__.*__(?:smart_edit|smart_write)' },
  { event: 'PreCompact', file: 'precompact-optimize.mjs', matcher: null },
  { event: 'Stop', file: 'stop.mjs', matcher: null },
];

const isOurs = (entry) => JSON.stringify(entry || {}).includes(MARKER);

/**
 * Returns a NEW settings object with our hooks wired in.
 *
 * `hooksDir` is where the hook files were installed. The command embeds it
 * directly, which is what puts the marker into the settings file and therefore
 * what makes this removable later.
 */
export function wire(settings, hooksDir) {
  const next = { ...(settings || {}) };
  const hooks = { ...(next.hooks || {}) };

  for (const { event, file, matcher } of WIRING) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    // Drop only OUR previous entries, so re-running the installer does not
    // stack duplicates and does not touch anyone else's.
    const theirs = existing.filter((entry) => !isOurs(entry));

    const ours = {
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: `node "${`${hooksDir}/${file}`.split('\\').join('/')}"` }],
    };

    hooks[event] = [...theirs, ours];
  }

  next.hooks = hooks;
  return next;
}

/**
 * Returns a NEW settings object with our hooks removed and nothing else
 * touched.
 *
 * An event left with no entries has its key removed rather than left as an
 * empty array, so an uninstall leaves the file as it found it rather than
 * leaving litter that says we were here.
 */
export function unwire(settings) {
  const next = { ...(settings || {}) };
  if (!next.hooks) return next;

  const hooks = {};
  for (const [event, entries] of Object.entries(next.hooks)) {
    if (!Array.isArray(entries)) {
      hooks[event] = entries;
      continue;
    }
    const theirs = entries.filter((entry) => !isOurs(entry));
    if (theirs.length) hooks[event] = theirs;
  }

  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;

  return next;
}

/** Which of our entries are present, for verification and for the manifest. */
export function wiredEntries(settings) {
  const found = [];
  for (const [event, entries] of Object.entries(settings?.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      if (isOurs(entry)) found.push({ event, index });
    });
  }
  return found;
}

/** A summary of what a wiring would change, for a dry run. */
export function wirePlan(settings, hooksDir) {
  const before = wiredEntries(settings);
  const after = wiredEntries(wire(settings, hooksDir));
  const foreign = Object.entries(settings?.hooks || {}).reduce((sum, [, entries]) => (
    sum + (Array.isArray(entries) ? entries.filter((e) => !isOurs(e)).length : 0)
  ), 0);

  return {
    adding: after.length - before.length,
    replacing: before.length,
    preserving: foreign,
    events: WIRING.map((w) => w.event),
  };
}
