/**
 * Making it impossible to average two different builds into one number.
 *
 * THE BUG THIS EXISTS FOR, hit twice in one day. THOL's runner resumes from its
 * results database and skips runs already recorded for a campaign label. Its
 * rows carry `competitor_version`, which read `6.0.2` for every run because the
 * package version is not bumped between builds. So an arm re-measured after a
 * code change silently averaged the old build with the new one under a single
 * name, and nothing in the row said otherwise.
 *
 * Proved by timestamp after the fact: the image was built at 22:03:48 and the
 * arm's three reps ran at 17:42, 17:43 and 22:08 -- two thirds of it measured
 * code that no longer existed. Recovering that required knowing to check
 * `docker image inspect --format '{{.Created}}'` against `started_at`, which is
 * archaeology, not measurement.
 *
 * The fix is that a row without provenance is not a row. Every record carries
 * the image digest and the commit that produced the artefact under test, and
 * `assertSingleBuild` refuses to summarise a group that spans more than one.
 * The check is cheap and it is not optional: a benchmark that can silently mix
 * builds cannot support any claim at all, which is the state we were in.
 */

/** Fields every row must carry before it may be counted. */
export const REQUIRED_FIELDS = [
  'task',
  'arm',
  'rep',
  'track',
  'status',
  'usd',
  'turns',
  'score',
  'image_digest',
  'commit_sha',
  'started_at',
];

/**
 * Tracks a run may belong to.
 *
 * SEPARATE, NEVER AVERAGED. `cold` starts from a fresh state directory, which
 * is what the published leaderboards measure. `warm` lets state accumulate
 * across an ordered sequence in one repository, which is how these tools are
 * actually used and the only condition under which a cross-session mechanism
 * can show anything at all. A tool that wins one and loses the other must be
 * described that way rather than averaged into a single misleading figure.
 */
export const TRACKS = ['cold', 'warm'];

/**
 * Why a row is unusable, or null when it is fine.
 *
 * Returns the REASON rather than a boolean because the loader reports rejected
 * rows in full. Silently dropping malformed rows is how a run count quietly
 * stops matching the number of runs that happened.
 */
export function rowProblem(row) {
  if (!row || typeof row !== 'object') return 'not an object';
  for (const field of REQUIRED_FIELDS) {
    if (row[field] === undefined || row[field] === null) return `missing ${field}`;
  }
  if (!TRACKS.includes(row.track)) return `unknown track ${row.track}`;
  // PROVENANCE MUST BE SHAPED LIKE PROVENANCE, not merely present.
  //
  // Review found this on a row I created myself. Pinning a top-up with
  // `--commit-sha`, I typed a remembered 8-character prefix and invented the
  // rest; the ledger's build-scoping caught it -- the run reported "0 rows
  // already recorded" where it should have said 600 -- but only because the key
  // failed to MATCH. The row itself was accepted: status ok, a real cost, and a
  // commit_sha resolving to nothing. Quarantining the file was not a fix,
  // because `--store` points wherever it is told and any future typo produces
  // the same thing under a name nobody flags.
  //
  // Checked as a shape rather than against `git cat-file`: a row must be
  // readable years later, on a machine that does not have this repository, from
  // a JSONL file alone. A 40-character hex sha cannot prove the commit exists,
  // but it does reject the whole class of hand-typed values -- short prefixes,
  // truncations, invented tails -- which is what actually happened here.
  if (!/^[0-9a-f]{40}$/.test(String(row.commit_sha))) {
    return `commit_sha must be a full 40-character hex sha, got "${row.commit_sha}"`;
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(row.image_digest))) {
    return `image_digest must be sha256:<64 hex>, got "${row.image_digest}"`;
  }
  if (typeof row.usd !== 'number' || !Number.isFinite(row.usd) || row.usd < 0) {
    return 'usd must be a finite non-negative number';
  }
  if (typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score < 0 || row.score > 1) {
    return 'score must be a number in [0, 1]';
  }
  // A FAILED RUN IS STILL A ROW, and must still carry its cost. That is the
  // whole point: the ranking charges failures, so a harness that discards them
  // reintroduces exactly the flaw it was built to remove.
  if (row.status !== 'ok' && row.score !== 0) {
    return 'a non-ok run must score 0';
  }
  return null;
}

/** The build a row was produced by. Two rows agree only if BOTH parts agree. */
export function buildKey(row) {
  return `${row.image_digest}@${row.commit_sha}`;
}

/**
 * Throws unless every row came from one build.
 *
 * DELIBERATELY FATAL. The alternative -- a warning -- is what the previous
 * harness effectively had, and a warning printed into a long campaign log is
 * indistinguishable from no warning at all. Refusing to produce a number is the
 * only response that cannot be ignored by accident.
 */
export function assertSingleBuild(rows, label = 'group') {
  const builds = new Map();
  for (const row of rows) {
    const key = buildKey(row);
    if (!builds.has(key)) builds.set(key, []);
    builds.get(key).push(row);
  }
  if (builds.size <= 1) return builds.size === 1 ? [...builds.keys()][0] : null;

  const detail = [...builds.entries()]
    .map(([key, group]) => {
      const times = group.map((r) => r.started_at).sort();
      return `  ${key}  n=${group.length}  ${times[0]} .. ${times[times.length - 1]}`;
    })
    .join('\n');
  throw new Error(
    `${label} spans ${builds.size} builds; refusing to summarise.\n${detail}\n` +
      `Purge the rows from the superseded build and re-run that arm.`
  );
}

/**
 * Rows that belong to the newest build, and what was dropped.
 *
 * The recovery path for a store that already contains a mixture. Returns the
 * discards rather than deleting anything, because a benchmark should never be
 * the thing that destroys its own evidence -- the caller decides.
 */
export function newestBuildOnly(rows) {
  if (!rows.length) return { kept: [], dropped: [], build: null };
  const latest = new Map();
  for (const row of rows) {
    const key = buildKey(row);
    const at = String(row.started_at);
    if (!latest.has(key) || at > latest.get(key)) latest.set(key, at);
  }
  let build = null;
  let newest = '';
  for (const [key, at] of latest) {
    if (at > newest) {
      newest = at;
      build = key;
    }
  }
  const kept = rows.filter((r) => buildKey(r) === build);
  return { kept, dropped: rows.filter((r) => buildKey(r) !== build), build };
}

/**
 * Which commits in a set of rows do not exist in this repository.
 *
 * SEPARATE FROM `rowProblem`, AND DELIBERATELY OPT-IN. That function is pure: it
 * judges a row from the row alone, so a JSONL file stays readable years later on
 * a machine that never had this repository. Resolving a sha needs a git object
 * database, which is exactly the dependency the raw rows are meant not to have.
 *
 * IT EXISTS BECAUSE A SHAPE CHECK CANNOT CATCH THIS. Pinning a top-up with
 * `--commit-sha`, I typed a remembered 8-character prefix and invented the tail.
 * The result was a well-formed 40-character hex sha that resolves to nothing --
 * so `/^[0-9a-f]{40}$/` accepts it, and the only way to tell is to ask git. The
 * ledger caught the mistake by a different route (the build key failed to match,
 * and the run reported "0 rows already recorded" where it should have said 600),
 * but that is luck about which half of the key was wrong, not a check.
 *
 * `run` is injected so this is testable without a repository.
 */
export function unresolvableCommits(rows, { run = null, cwd = process.cwd() } = {}) {
  const shas = [...new Set(rows.map((r) => String(r.commit_sha)).filter(Boolean))];
  if (!shas.length || !run) return [];
  const missing = [];
  for (const sha of shas) {
    try {
      // `commit^{commit}` fails for a tree, a blob or a non-existent object, so
      // it answers "is this a commit here" rather than "does some object exist".
      run('git', ['-C', cwd, 'rev-parse', '--quiet', '--verify', `${sha}^{commit}`]);
    } catch {
      missing.push(sha);
    }
  }
  return missing;
}
