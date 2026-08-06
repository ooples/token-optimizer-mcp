/**
 * Dead-ends whose lesson was learned in ONE repository and is being tested in
 * ANOTHER.
 *
 * The existing corpora (ab-injection-harness, harvested-dead-ends) seed a finding
 * and probe it in the same project, which measures retrieval. This corpus
 * measures TRANSFER: every case is seeded into project A's graph, promoted to the
 * shared tier exactly as production promotes it, and then probed from a project B
 * that has its own empty graph and has never seen the claim.
 *
 * PROVENANCE IS THE POINT. The first four are traps that actually bit during the
 * cross-repo PR work this feature came out of -- each cost real time once, and
 * each is recorded with the symptom that was observed. The last two are HELD-OUT
 * SYNTHETIC: constructed rather than suffered, marked as such, and reported
 * separately, because a corpus that can only grow when someone makes a mistake
 * cannot be extended on demand and a claim built purely on synthetic traps has
 * weak external validity. Neither set is allowed to hide inside a single average.
 *
 * `walksIn` and `avoids` are deliberately not complements. An answer that does
 * neither is scored ABSTAIN and admitted to no arm -- counting an evasive answer
 * as a success is how a measurement flatters itself.
 */

export const CROSS_CASES = [
  {
    id: 'npm-test-not-npx-jest',
    origin: 'real',
    learnedIn: 'token-optimizer-mcp',
    symptom:
      'Ran `npx jest` to check a suite. It reported green while silently failing to load 26 ESM ' +
      'suites and running ~500 fewer tests, because the project passes --experimental-vm-modules ' +
      'through its npm script.',
    claim:
      'Run the suite with `npm test`, not bare `npx jest`: this project passes ' +
      '--experimental-vm-modules through the npm script, and without it every ESM suite silently ' +
      'fails to load while the run still reports green.',
    trigger: 'jest',
    probeCommand: 'npx jest tests/unit',
    task:
      'You need to run the test suite of a Node project you have not worked in before, to check ' +
      'whether your change broke anything. State the exact command you would run and why you trust ' +
      'its result.',
    walksIn: (s) =>
      /npx\s+jest/i.test(s) && !/npm\s+(run\s+)?test/i.test(s),
    avoids: (s) =>
      /npm\s+(run\s+)?test/i.test(s) ||
      /(check|read|look at).{0,40}package\.json.{0,40}scripts/i.test(s),
  },

  {
    id: 'exit-code-before-piping',
    origin: 'real',
    learnedIn: 'token-optimizer-mcp',
    symptom:
      'A failing build was reported as succeeding: `cmd | tail` returns the exit status of `tail`, ' +
      'not of the command, so a non-zero build exited 0 through the pipe.',
    claim:
      'Capture the exit code before piping. `cmd | tail` reports the PIPE status, not the command: ' +
      'a failing build came back exit 0 and was reported as succeeding. Redirect to a file and read ' +
      '$?, or use PIPESTATUS.',
    trigger: 'build|test|\\|\\s*(tail|head|grep)',
    probeCommand: 'npm run build | tail -20',
    task:
      'You are running a long build in a shell and want to see only the last 20 lines of output, ' +
      'but you must also know reliably whether the build succeeded. Give the exact shell command ' +
      'and explain how you determine success.',
    walksIn: (s) =>
      /\|\s*(tail|head)/i.test(s) &&
      !/(PIPESTATUS|\$\?|exit code|redirect|tee|> ?[\w./]+\.log)/i.test(s),
    avoids: (s) =>
      /PIPESTATUS/i.test(s) ||
      /(redirect|write|save).{0,40}(file|log)/i.test(s) ||
      /\btee\b/i.test(s) ||
      /set\s+-o\s+pipefail/i.test(s),
  },

  {
    id: 'installed-build-not-working-tree',
    origin: 'real',
    learnedIn: 'token-optimizer-mcp',
    symptom:
      'Spent an hour attributing live tool misbehaviour to src/. The running server was launched via ' +
      'npx from the npm cache and served a build three days old; the working tree was never involved.',
    claim:
      'A running MCP server serves the build it LOADED, not what is on disk, and it may be launched ' +
      'from the npx cache rather than your working tree. Before attributing live misbehaviour to ' +
      'your source, confirm which build the process is actually running.',
    trigger: 'mcp|server|npx|restart',
    probeCommand: 'npx @some/mcp-server --version',
    task:
      'A locally installed MCP server is behaving in a way that contradicts the source code in your ' +
      'working tree. Describe the first thing you would check, and why.',
    walksIn: (s) =>
      !/(which|what|identify).{0,60}(build|version|process|binary|path)/i.test(s) &&
      !/(installed|running process|npx cache|node_modules|restart)/i.test(s),
    avoids: (s) =>
      /(npx cache|node_modules|installed (build|copy|version)|which build|running process|process command ?line|restart the server)/i.test(
        s
      ),
  },

  {
    id: 'edit-source-not-generated',
    origin: 'real',
    learnedIn: 'token-optimizer-mcp',
    symptom:
      'A fix was applied to a generated copy under plugin/hooks/lib/ and silently reverted by the ' +
      'next `npm run sync:hooks`, so the same bug reappeared with no record of the edit.',
    claim:
      'When a repository has generated copies of a module, edit the SOURCE and regenerate. A change ' +
      'made to a generated file is silently reverted by the next sync, so the bug returns and the ' +
      'edit leaves no trace.',
    trigger: 'sync|generate|lib/|generated',
    probeCommand: 'npm run sync:hooks',
    task:
      'You find the same module at src/thing.mjs and at dist/lib/thing.mjs, and the second carries a ' +
      'header saying it is generated. You need to fix a bug in that module. Which file do you edit ' +
      'and what do you do next?',
    walksIn: (s) =>
      /dist\/lib|generated (file|copy)/i.test(s) &&
      /\bedit (the )?(dist|generated)/i.test(s),
    avoids: (s) =>
      /(edit|change|fix).{0,40}(source|src\/)/i.test(s) ||
      /(regenerate|re-?run.{0,20}(sync|build|generat))/i.test(s),
  },

  // ---- HELD-OUT SYNTHETIC. Constructed, never suffered. Scored separately. ----

  {
    id: 'lockfile-install-in-ci',
    origin: 'synthetic',
    learnedIn: 'synthetic-repo-a',
    symptom:
      'CONSTRUCTED: `npm install` in CI silently updates the lockfile, so CI can pass against ' +
      'dependency versions that were never reviewed.',
    claim:
      'In CI use `npm ci`, not `npm install`: install mutates the lockfile, so the job can pass ' +
      'against dependency versions nobody reviewed and the run stops being reproducible.',
    trigger: 'npm install|ci',
    probeCommand: 'npm install --no-audit',
    task:
      'You are writing the dependency-installation step of a CI workflow for a Node project that has ' +
      'a committed package-lock.json. State the exact command and why.',
    walksIn: (s) => /npm\s+install/i.test(s) && !/npm\s+ci\b/i.test(s),
    avoids: (s) => /npm\s+ci\b/i.test(s),
  },

  {
    id: 'atomic-write-temp-rename',
    origin: 'synthetic',
    learnedIn: 'synthetic-repo-a',
    symptom:
      'CONSTRUCTED: a writer truncated the destination on open, so a concurrent reader observed a ' +
      'half-written file and decoded it without error.',
    claim:
      'Publish a file by writing a temp file in the same directory and renaming over the target. ' +
      'Opening the destination directly truncates it immediately, so a concurrent reader sees a ' +
      'partial file and a binary reader decodes the partial bytes without reporting corruption.',
    trigger: 'write|save|persist|checkpoint',
    probeCommand: 'node scripts/save-weights.mjs',
    task:
      'You are writing a function that saves a model checkpoint to a fixed path. Another process may ' +
      'read that path at any time. Describe how you write the file.',
    walksIn: (s) =>
      /(open|create|write).{0,40}(destination|final|target|path)/i.test(s) &&
      !/(temp|tmp|rename|atomic)/i.test(s),
    avoids: (s) => /(temp|tmp).{0,60}(rename|move)|atomic/i.test(s),
  },
];
