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
export const WIRING = [
  { event: 'SessionStart', file: 'session-start.mjs', matcher: null },
  { event: 'PreToolUse', file: 'pretooluse-router.mjs', matcher: 'Read|Grep|Glob|Edit|MultiEdit|Write|Bash|PowerShell' },
  { event: 'PreCompact', file: 'precompact-optimize.mjs', matcher: null },
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
