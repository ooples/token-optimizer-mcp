/**
 * Dead-ends whose lesson was learned in ONE repository and is tested in ANOTHER.
 *
 * REBUILT AFTER A NULL RESULT. The first corpus scored 0 of 6 admitted: every
 * task asked for a GENERAL best practice ("use npm ci", "write to a temp file
 * and rename"), and a capable model already holds those. A case the control gets
 * right measures nothing, and this repository's own corpus notes had already
 * recorded the same mistake once.
 *
 * The structural tension that caused it is worth stating, because it constrains
 * what this tier can ever be worth: a lesson that TRANSFERS between projects
 * tends to be general, and general lessons are the ones already known. The band
 * where a shared tier pays is therefore narrow -- facts specific to this MACHINE,
 * this ACCOUNT or this TOOLCHAIN, which no amount of general competence supplies,
 * yet which are not tied to a single repository.
 *
 * The live example is exact. A control asked about a stale MCP server correctly
 * names the PRINCIPLE ("the running process may not be your working tree"). What
 * it cannot supply is the FACT: on this machine the server is launched by
 * `npx -y pkg@latest`, so the copy it serves lives in the npm _npx cache and
 * `npm install -g` does not touch it. The principle was known; the fact saved an
 * hour. Every case below tests a fact, not a principle.
 *
 * ACTION FIRST IN EVERY CLAIM. Measured on this project: a finding that buried
 * its instruction after three sentences of context was ignored, and the subject
 * gave the habitual answer anyway. The first clause says what to do.
 *
 * `walksIn` and `avoids` are not complements. An answer that satisfies neither is
 * scored abstain and admitted to no arm -- counting an evasive answer as success
 * is how a measurement flatters itself.
 */

export const CROSS_CASES = [
  {
    id: 'npx-cache-not-global-install',
    origin: 'real',
    learnedIn: 'token-optimizer-mcp',
    symptom:
      'Updated the global npm install of an MCP server and verified the version there. The running ' +
      'server kept serving the old build: the client launches it with `npx -y pkg@latest`, so the ' +
      'copy in use lives in the npm _npx cache, keyed by a hash, and -g never touched it.',
    claim:
      'Update the npx cache copy too, not just the global install: a client that launches a server ' +
      'with `npx -y pkg@latest` runs the copy under the npm _npx cache (keyed by a hash), so ' +
      '`npm install -g` upgrades a copy nothing executes and the old build keeps serving.',
    trigger: 'npx|npm install -g|mcp|server',
    probeCommand: 'npm install -g @ooples/token-optimizer-mcp',
    task:
      'On this machine a tool is distributed as an npm package and run as a server by a client app. ' +
      'You published a new version, ran `npm install -g <pkg>@latest`, confirmed the version in the ' +
      'global node_modules, and restarted the client. It still behaves like the old version. Name the ' +
      'specific location you check next.',
    // Walks in: reaches for reinstall/restart/cache-clear without naming where the
    // executed copy actually lives.
    walksIn: (s) =>
      !/(_npx|npx cache|npm-cache|npx.{0,25}cache)/i.test(s),
    avoids: (s) => /(_npx|npx cache|npm-?cache)/i.test(s),
  },

  {
    id: 'clone-beside-siblings',
    origin: 'real',
    learnedIn: 'AiDotNet-Prototype',
    symptom:
      'Cloned a .NET repo into a scratch directory and `dotnet build` failed instantly with MSB3202: ' +
      'the solution references ../AiDotNet/src/AiDotNet.csproj by relative path, so the repo only ' +
      'builds when checked out beside its sibling dependencies.',
    claim:
      'Clone the repo BESIDE its sibling dependencies, in the same parent directory: solutions on ' +
      'this machine reference other repos by relative path (../AiDotNet/src/...), so a clone placed ' +
      'anywhere else fails at restore with MSB3202 before a single file compiles.',
    trigger: 'clone|git clone|dotnet build|restore',
    probeCommand: 'git clone https://github.com/ooples/AiDotNet-Prototype',
    task:
      'You are about to clone one of our .NET repositories onto this machine so you can build it. ' +
      'Its solution depends on another one of our repositories. State where you clone it and why the ' +
      'location matters.',
    walksIn: (s) =>
      !/(beside|next to|sibling|same parent|same (directory|folder) as|relative path)/i.test(s),
    avoids: (s) =>
      /(beside|next to|sibling|same parent|same (directory|folder) as)/i.test(s) ||
      /relative (path|reference).{0,60}(sibling|parent|repo)/i.test(s),
  },

  {
    id: 'fossil-ci-checks',
    origin: 'real',
    learnedIn: 'ZeroDev',
    symptom:
      'Sixty open PRs each showed ~20 red checks. The runs were from November 2025 -- job-level ' +
      'startup failures with no failed STEPS -- nine months stale. Nothing was failing today; the ' +
      'results were fossils nobody had re-run.',
    claim:
      'Check WHEN the failing runs executed before treating them as current: a long-dormant PR shows ' +
      'the last run it ever had, so identical red checks across many old PRs are usually fossils from ' +
      'a config that no longer exists, not a live failure. A job that failed with no failed steps ' +
      'never started.',
    trigger: 'gh pr checks|ci|failing|triage',
    probeCommand: 'gh pr checks 189',
    task:
      'You are triaging a repository where roughly sixty open pull requests each show the same twenty ' +
      'failing checks. Before you start fixing anything, state the first thing you establish about ' +
      'those check results and how.',
    walksIn: (s) =>
      !/(when|date|age|stale|timestamp|how (old|recently)|last run|re-?run)/i.test(s),
    avoids: (s) =>
      /(when|date|age|stale|timestamp|how (old|recently)|last ran?|re-?run)/i.test(s),
  },

  {
    id: 'prettier-failure-is-line-endings',
    origin: 'real',
    learnedIn: 'mcp-console-automation',
    symptom:
      'CI format:check listed 165 files. Running the repo\'s own `prettier --write` locally produced ' +
      'a git diff of exactly 2 files. The other 163 differed only in line endings: no .gitattributes, ' +
      'CRLF committed in the blobs, prettier defaulting to endOfLine lf.',
    claim:
      'Check the line endings before reformatting: when a format check lists far more files than a ' +
      'local write actually changes, the difference is CRLF in the committed blobs against ' +
      'prettier\'s lf default. Add .gitattributes and renormalize; running --write across the repo ' +
      'produces a huge diff that fixes nothing.',
    trigger: 'prettier|format|lint',
    probeCommand: 'npx prettier --check .',
    task:
      'A repository\'s CI format check fails and lists 165 files. You run the project\'s own format ' +
      'command locally; it reports success afterwards, but `git status` shows only 2 files modified. ' +
      'Explain what is happening and state what you change.',
    walksIn: (s) => !/(line ending|crlf|lf\b|eol|gitattributes|autocrlf)/i.test(s),
    avoids: (s) => /(line ending|crlf|\blf\b|eol|gitattributes|autocrlf)/i.test(s),
  },

  {
    id: 'mutually-blocking-dependabot',
    origin: 'real',
    learnedIn: 'mcp-console-automation',
    symptom:
      'Three dependabot PRs each bumped one vulnerable package. All three failed the same Security ' +
      'Scan job, because `npm audit --audit-level=high` fails until EVERY advisory clears -- so no ' +
      'single-package PR could ever turn it green.',
    claim:
      'Resolve the advisories together in one PR: a CI job running `npm audit --audit-level=high` ' +
      'fails while ANY high advisory remains, so one-package-per-PR dependabot bumps each stay red on ' +
      'a check their own change cannot fix, and they block each other indefinitely.',
    trigger: 'dependabot|npm audit|security scan|bump',
    probeCommand: 'npm audit --audit-level=high',
    task:
      'A repository has three open dependabot pull requests, each bumping a different package. All ' +
      'three are failing the same "Security Scan" check. Explain why and state how you get them ' +
      'merged.',
    walksIn: (s) =>
      !/(together|one pr|single pr|combine|all (of them|three|the advisories)|at once)/i.test(s),
    avoids: (s) =>
      /(together|one pr|single pr|combin|all three|all the advisories|at once)/i.test(s),
  },

  // ---- HELD-OUT SYNTHETIC: constructed, marked, scored separately. ----
  {
    id: 'farm-thread-cap',
    origin: 'synthetic',
    learnedIn: 'synthetic-machine-config',
    symptom:
      'CONSTRUCTED in the shape of a real machine fact: on a 128-core box, leaving each worker at the ' +
      'library default spawned 128 threads per process and the workers thrashed.',
    claim:
      'Cap threads per worker to 64 on this machine: it has 128 cores, and numeric libraries default ' +
      'to one thread per core, so several concurrent workers each claim all 128 and spend their time ' +
      'in contention rather than work.',
    trigger: 'torch|threads|farm|parallel|worker',
    probeCommand: 'python run_experiment.py --workers 4',
    task:
      'You are launching four concurrent numeric worker processes on this machine. State what you set ' +
      'for per-process thread count and why.',
    walksIn: (s) => !/(cap|limit|set|restrict).{0,40}(thread|core)/i.test(s),
    avoids: (s) =>
      /(cap|limit|set|restrict).{0,40}(thread|core)/i.test(s) ||
      /(OMP_NUM_THREADS|torch\.set_num_threads|MKL_NUM_THREADS)/i.test(s),
  },
];
