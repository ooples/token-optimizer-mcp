/**
 * Dead-ends whose lesson was learned in ONE repository and tested in ANOTHER.
 *
 * THIRD REVISION, AND THE FIRST TWO ARE WHY. Corpus 1 asked for general best
 * practice: a capable model already holds those, 0 of 6 admitted. Corpus 2 asked
 * for environment-specific practice, still phrased as a principle, and a blind
 * control reasoned its way to the mechanism unaided: 1 of 6 admitted. The pattern
 * is consistent -- a model can name a MECHANISM it has never met on this machine.
 * What it cannot do is produce a VALUE it has never been told.
 *
 * So every case below turns on a specific value discovered in this session and
 * recorded nowhere a model could reach: a cache directory hash, a run date, a
 * baseline error count, a corpus size. The control can reason perfectly and still
 * not know the number.
 *
 * WHAT THIS MEASURES, STATED PLAINLY BECAUSE IT IS NARROWER THAN IT LOOKS. It is
 * whether a delivered non-derivable fact CHANGES THE ANSWER GIVEN. It is not a
 * test of judgement -- the previous two corpora were, and both showed the model's
 * judgement is already good. A model could receive the fact and still answer from
 * habit, which is the failure this catches, and which has been observed on this
 * project before: a finding that buried its instruction after three sentences was
 * ignored and the subject gave the habitual answer anyway.
 *
 * That makes this a NECESSARY condition for the tier to be worth anything, not a
 * sufficient one. Delivery converting to behaviour is the claim; "makes the agent
 * smarter" is not, and must not be reported as though it were.
 *
 * EVERY TASK REQUIRES USING THE VALUE, not reciting it. Each asks for a command,
 * a decision or a judgement that is wrong without the number, so an answer that
 * ignores the injection is visibly wrong rather than merely incomplete.
 */

export const CROSS_CASES = [
  {
    id: 'npx-cache-hash-path',
    origin: 'real',
    learnedIn: 'token-optimizer-mcp',
    symptom:
      'Updated the global npm install and the running MCP server kept serving the old build. The ' +
      'client launches it with `npx -y pkg@latest`, so the executed copy lives under ' +
      'AppData/Local/npm-cache/_npx/339a02466fae3d9e/node_modules/@ooples/token-optimizer-mcp.',
    claim:
      'Install into AppData/Local/npm-cache/_npx/339a02466fae3d9e/node_modules/@ooples/token-optimizer-mcp ' +
      'as well as globally: on this machine the client launches the server with `npx -y pkg@latest`, ' +
      'so that hashed npx-cache directory holds the copy actually executed and `npm install -g` ' +
      'upgrades one nothing runs.',
    trigger: 'npx|npm install|mcp|server|upgrade',
    probeCommand: 'npm install -g @ooples/token-optimizer-mcp@latest',
    task:
      'You built a new version of an npm-distributed MCP server on this machine and need the running ' +
      'server to actually pick it up. Give the exact filesystem location you install the tarball into. ' +
      'A location is required; if you do not know it, say so explicitly.',
    // Walks in: cannot name the executed copy's directory.
    walksIn: (s) => !/339a02466fae3d9e/i.test(s),
    avoids: (s) => /339a02466fae3d9e/i.test(s),
  },

  {
    id: 'harmonicengine-baseline-errors',
    origin: 'real',
    learnedIn: 'HarmonicEngine',
    symptom:
      'A clean checkout of the HarmonicEngine test project failed to build with 536 errors ' +
      '(294 CS0234, 226 CS0246, 16 CS0103) resolving AiDotNet types. They are pre-existing: the ' +
      'committed state does not build without local uncommitted package changes.',
    claim:
      'Expect 536 pre-existing build errors on a clean HarmonicEngine checkout and compare against ' +
      'that number rather than against zero: the committed state does not build without local ' +
      'uncommitted package changes, so a build is only evidence about YOUR change if its error count ' +
      'differs from 536.',
    trigger: 'dotnet build|build|errors',
    probeCommand: 'dotnet build tests/HarmonicEngine.Tests.csproj',
    task:
      'You changed four C# files in a research repo on this machine and ran the test project build. ' +
      'It reports build errors. State the specific number of errors that would tell you your change ' +
      'introduced nothing new, and how you use it. A number is required; if you do not know it, say ' +
      'so explicitly.',
    walksIn: (s) => !/\b536\b/.test(s),
    avoids: (s) => /\b536\b/.test(s),
  },

  {
    id: 'wikitext-corpus-size',
    origin: 'real',
    learnedIn: 'HarmonicEngine',
    symptom:
      'An HE_NTR sweep computed vocabulary and IDF over the whole training file while the ' +
      'co-occurrence pass consumed only NTR+50000 tokens. wiki.train.full holds 117,920,208 tokens ' +
      'against a default NTR of 1,500,000 -- so the statistics came from 76x more data than the run.',
    claim:
      'Truncate the corpus before computing vocabulary and IDF: wiki.train.full holds 117,920,208 ' +
      'tokens while the default HE_NTR window is 1,500,000, so statistics taken over the whole file ' +
      'describe roughly 76x more data than the run actually consumes and HE_NTR stops varying ' +
      'anything.',
    // THE TRIGGER MUST MATCH THE COMMAND TEXT, NOT THE CONCEPT. The first version
    // matched on 'NTR|corpus|idf|vocab' -- none of which appear in
    // 'python scripts/freq_hop_lambada.py' -- so the lesson never fired and the
    // arm came back empty. Caught by the harness refusing to admit it.
    trigger: 'python|lambada|freq_hop|HE_NTR',
    probeCommand: 'HE_NTR=1500000 python scripts/freq_hop_lambada.py',
    task:
      'A research script computes token counts and IDF weights from a training file, then builds ' +
      'co-occurrence statistics from a truncated prefix of that same file. State the size of the full ' +
      'corpus in tokens and why the mismatch matters. A number is required; if you do not know it, ' +
      'say so explicitly.',
    walksIn: (s) => !/117[,._ ]?920[,._ ]?208|117\.9\s*(m|million)/i.test(s),
    avoids: (s) => /117[,._ ]?920[,._ ]?208|117\.9\s*(m|million)/i.test(s),
  },

  {
    id: 'roslyn-csc-sdk-path',
    origin: 'real',
    learnedIn: 'HarmonicEngine',
    symptom:
      'Needed to syntax-check single C# files in a repo whose project could not build. The compiler ' +
      'ships inside the SDK rather than on PATH: this machine has it at ' +
      'C:/Program Files/dotnet/sdk/8.0.129/Roslyn/bincore/csc.dll, and a first attempt that globbed ' +
      'the path silently ran nothing and reported every file clean.',
    claim:
      'Invoke the compiler directly at C:/Program Files/dotnet/sdk/8.0.129/Roslyn/bincore/csc.dll to ' +
      'syntax-check a C# file without building: csc is not on PATH on this machine, it ships inside ' +
      'the SDK, and a wrong path fails silently -- the run reports no syntax errors because no ' +
      'compiler ever started.',
    trigger: 'csc|dotnet|syntax|compile|build',
    probeCommand: 'dotnet build Foo.csproj',
    task:
      'On this machine you need to syntax-check one C# file without building its project, which does ' +
      'not compile. Give the exact path to the compiler you invoke. A path is required; if you do not ' +
      'know it, say so explicitly.',
    walksIn: (s) => !/8\.0\.129/.test(s),
    avoids: (s) => /8\.0\.129/.test(s),
  },

  {
    id: 'hook-state-dir-isolation',
    origin: 'real',
    learnedIn: 'token-optimizer-mcp',
    symptom:
      'A suite driving the hook passed on its first run and reported the feature broken on every run ' +
      'after. Injection is once-per-session and the gate persists to a FIXED directory under the ' +
      'system temp dir, so named sessions inherited what a previous RUN had recorded.',
    claim:
      'Set TOKEN_OPTIMIZER_STATE_DIR to a fresh directory per test when driving these hooks: the ' +
      'once-per-session injection gate persists to a fixed path under the system temp dir, so a test ' +
      'that names its sessions inherits what a previous RUN recorded and reports the feature broken ' +
      'from the second run onward.',
    trigger: 'test|jest|hook|session',
    probeCommand: 'npm test -- tests/hooks/injection.test.mjs',
    task:
      'You are writing a test that drives a tool whose hook injects context only once per session. ' +
      'The test passes the first time you run it and fails on every run afterwards, with no code ' +
      'change. Name the exact environment variable you set to fix it. A name is required; if you do ' +
      'not know it, say so explicitly.',
    walksIn: (s) => !/TOKEN_OPTIMIZER_STATE_DIR/i.test(s),
    avoids: (s) => /TOKEN_OPTIMIZER_STATE_DIR/i.test(s),
  },

  // ---- HELD-OUT SYNTHETIC: a constructed value, never observed. Scored apart. ----
  {
    id: 'gpu-runner-label',
    origin: 'synthetic',
    learnedIn: 'synthetic-org-config',
    symptom:
      'CONSTRUCTED in the shape of a real org fact: GPU jobs scheduled onto the default runner queued ' +
      'forever because the GPU pool uses a dedicated label.',
    claim:
      'Set runs-on to gpu-a10-8core for any GPU job in this organisation: the default runner pool has ' +
      'no GPUs, so a GPU job scheduled onto it queues indefinitely rather than failing, and nothing ' +
      'reports an error.',
    trigger: 'runs-on|workflow|gpu|ci',
    probeCommand: 'gh workflow run gpu-benchmark.yml',
    task:
      'You are adding a GPU benchmark job to this organisation\'s CI workflow. State the exact ' +
      'runs-on label you use. A label is required; if you do not know it, say so explicitly.',
    walksIn: (s) => !/gpu-a10-8core/i.test(s),
    avoids: (s) => /gpu-a10-8core/i.test(s),
  },
];
