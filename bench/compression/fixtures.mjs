/**
 * Request fixtures at the scale of HeadRoom's four published workloads.
 *
 * HONESTY ABOUT WHAT THESE ARE, because the percentages depend on it.
 *
 * The CODE workloads read real files out of this repository. The first
 * version generated code instead, and measurement exposed the generator as
 * the problem: eight-line bodies beneath two-line signatures is a far higher
 * signature-to-body ratio than real source, which understates what a
 * body-eliding compressor can remove. The fix was to stop inventing the
 * content rather than to tune the generator until the number improved.
 *
 * Logs, JSON and prose are still generated, because a real build log or issue
 * dump cannot be committed here without dragging in someone's data. They are
 * shaped and scaled to the workloads HeadRoom publishes -- SRE debugging at
 * ~65.7k tokens, issue triage at ~54.2k -- and they are NOT their corpora,
 * which are unpublished. A percentage measured here is comparable to theirs
 * only in the sense that both describe the same kind of content at the same
 * order of magnitude.
 *
 * Nothing here is rigged toward us. The generated fixtures carry the awkward
 * cases deliberately: logs contain unique error lines that must survive
 * folding, JSON contains rows that genuinely differ. A fixture built only
 * from compressible filler would prove nothing except that filler compresses.
 *
 * Deterministic: a seeded generator and a sorted file walk, so a number that
 * moves means the code moved.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Real source from this repository, for the code workloads.
 *
 * NOT SYNTHETIC, deliberately. The first version of this file generated code,
 * and measurement showed the generator was the problem: eight-line bodies under
 * two-line signatures is a far higher signature-to-body ratio than real source,
 * which understates how much a body-eliding compressor can remove. Rather than
 * tune the generator until the number looked better -- which would be rigging
 * the benchmark -- the code workloads now read actual files off disk.
 *
 * Deterministic: sorted by path, taken in order, capped by character budget.
 */
function realSources(root, budget) {
  const out = [];
  let total = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (total >= budget) return;
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (/\.(ts|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) {
        const text = readFileSync(full, 'utf8');
        out.push(text);
        total += text.length;
      }
    }
  };
  walk(root);
  return out.join('\n\n');
}

const REPO = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/**
 * A grep-style search result over real source: matched lines with context.
 *
 * THIS IS A DIFFERENT WORKLOAD FROM WHOLE FILES, and conflating them was an
 * error in the first version of this file. HeadRoom's code-search figure (92%)
 * is measured on search RESULTS -- their handler documents "for search results
 * it shows matched functions with +/-5 lines" -- while their codebase-
 * exploration figure (47%) is measured on whole files. Feeding whole files to
 * a fixture named code-search compares our number against the wrong one of
 * theirs.
 *
 * Emitted the way ripgrep emits it, path and line number per hit, because
 * that is what actually lands in a tool result.
 */
function searchResults(root, pattern, budget) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (/\.(ts|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) files.push(full);
    }
  };
  walk(root);

  const out = [];
  let total = 0;
  for (const file of files) {
    if (total >= budget) break;
    const lines = readFileSync(file, 'utf8').split('\n');
    const rel = file.slice(REPO.length).replace(/\\/g, '/');
    for (let i = 0; i < lines.length; i += 1) {
      if (total >= budget) break;
      if (!pattern.test(lines[i])) continue;
      const from = Math.max(0, i - 5);
      const to = Math.min(lines.length - 1, i + 5);
      const hunk = lines
        .slice(from, to + 1)
        .map((line, k) => `${rel}:${from + k + 1}: ${line}`)
        .join('\n');
      out.push(hunk);
      total += hunk.length;
      i = to;
    }
  }
  return out.join('\n--\n');
}

/** Small deterministic PRNG -- mulberry32. No dependency, same output everywhere. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];

const VERBS = ['resolve', 'compute', 'validate', 'normalise', 'render', 'persist', 'collect'];
const NOUNS = ['Session', 'Manifest', 'Payload', 'Anchor', 'Digest', 'Registry', 'Outcome'];

/** A TypeScript module with real signatures and real bodies. */
function tsModule(r, functions) {
  const parts = [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "import { join, dirname } from 'node:path';",
    '',
  ];
  for (let i = 0; i < functions; i += 1) {
    const name = `${pick(r, VERBS)}${pick(r, NOUNS)}${i}`;
    const short = r() < 0.25;
    parts.push(`/** ${name}: ${pick(r, VERBS)}s the ${pick(r, NOUNS).toLowerCase()}. */`);
    parts.push(`export function ${name}(input: string, limit = ${Math.floor(r() * 900) + 10}): string {`);
    if (short) {
      parts.push('  return input.slice(0, limit);');
    } else {
      parts.push('  const parts = input.split(/\\s+/).filter(Boolean);');
      parts.push('  const out: string[] = [];');
      parts.push('  for (const part of parts) {');
      parts.push('    if (out.join(" ").length + part.length > limit) break;');
      parts.push(`    out.push(part.toLowerCase().replace(/[^a-z0-9]/g, "${i % 7}"));`);
      parts.push('  }');
      parts.push('  const joined = out.join(" ");');
      parts.push('  return joined.length ? joined : input.slice(0, limit);');
    }
    parts.push('}');
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * Structured log entries in the shape HeadRoom actually benchmarks.
 *
 * READ FROM THEIR GENERATOR, not inferred -- the same mistake as code-search,
 * made twice. benchmarks/scenarios/tool_outputs.py::generate_log_entries emits
 * JSON DICTIONARIES, not text lines: timestamp, level, logger, message,
 * service, hostname and a unique trace_id, with ERROR and CRITICAL entries
 * carrying an extra exception object. Messages come from eight templates, and
 * only include_errors + include_critical entries out of n are outside them.
 *
 * That shape routes to the JSON engine rather than the log engine, which is
 * why their figure is achievable with a unique id on every entry: the bulk is
 * repeated keys and templated messages, not the ids.
 *
 * The exception-carrying entries are needles by construction -- they hold a
 * key the other 99% lack -- so anomaly preservation must keep them.
 */
function structuredLog(r, n) {
  const messages = [
    'Request processed successfully for user {user}',
    'Database query completed in {ms}ms',
    'Cache hit for key {key}',
    'API call to {service} returned {status}',
    'Background job {job} started',
    'Background job {job} completed',
    'Health check passed for {component}',
    'Metrics exported: {count} datapoints',
  ];
  const errors = [
    'Connection failed to {service}: timeout after {ms}ms',
    'Database error: {error_type}',
    'Failed to process request: {error}',
    'Rate limit exceeded for user {user}',
  ];
  const fill = (t) =>
    t.replace(/\{(\w+)\}/g, (_m, k) => `${k}-${Math.floor(r() * 900) + 100}`);
  const hex = (i) => ((i * 2654435761) >>> 0).toString(16).padStart(8, '0');

  const entries = [];
  for (let i = 0; i < n; i += 1) {
    // DEEP IN THE PAYLOAD, NOT AT THE HEAD. The critical record used to be
    // entry zero, which every engine keeps as a shape sample -- so a gate
    // asserting it survived could not fail, which is worse than no gate. At
    // 83% it survives only because it BREAKS THE SHAPE: it carries an
    // `exception` key the INFO rows lack, which is exactly the anomaly
    // preservation the gate is there to protect.
    const critical = i === Math.floor(n * 0.83);
    const error = !critical && i < 6;
    const level = critical
      ? 'CRITICAL'
      : error
        ? 'ERROR'
        : r() < 0.1
          ? 'WARNING'
          : r() < 0.1
            ? 'DEBUG'
            : 'INFO';
    // A DETERMINISTIC MARKER ON THE CRITICAL ENTRY, so the gate has something
    // to look for. This generator documents its CRITICAL and ERROR records as
    // needles by construction, but nothing checked them: an arm could drop
    // every exception in the log and still pass every gate. A random message
    // cannot be asserted, so the first entry carries a fixed one.
    const message = critical
      ? NEEDLE_CRITICAL
      : fill(pick(r, error ? errors : messages));
    const entry = {
      timestamp: `2026-01-06T00:${String(Math.floor(i / 120) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
      level,
      logger: pick(r, ['app', 'api', 'worker', 'scheduler']),
      message,
      service: 'token-optimizer-benchmark',
      hostname: `worker-${String((i % 10) + 1).padStart(2, '0')}`,
      trace_id: `trace_${hex(i)}${hex(i + 1)}`,
    };
    if (error || critical) {
      entry.exception = {
        type: pick(r, ['TimeoutError', 'ConnectionError', 'ValueError', 'RuntimeError']),
        message,
        stacktrace: `Traceback (most recent call last):\n  File "app/handler.py", line ${100 + i}, in handle\n    return dispatch(request)\n  File "app/dispatch.py", line ${200 + i}, in dispatch`,
      };
    }
    entries.push(entry);
  }
  return JSON.stringify(entries, null, 2);
}

/** A build/test log: heavy repetition, with genuine failures that must survive. */
/** A stable, UUID-shaped correlation id per request. */
function reqId(i) {
  const h = (n) => ((n * 2654435761) >>> 0).toString(16).padStart(8, '0');
  return `${h(i)}-${h(i + 1).slice(0, 4)}-4${h(i + 2).slice(0, 3)}-9${h(i + 3).slice(0, 3)}-${h(i + 4)}${h(i + 5).slice(0, 4)}`;
}

function buildLog(r, lines) {
  const out = [];
  const stamp = (i) => `2026-09-09T18:${String(10 + (i % 50)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`;
  for (let i = 0; i < lines; i += 1) {
    const roll = r();
    if (roll < 0.55) {
      out.push(`${stamp(i)} INFO  webpack: compiled module ${i % 9} successfully`);
    } else if (roll < 0.8) {
      // A correlation id on the line, because real logs carry them and a
      // fixture without one cannot exercise the identifier floor at all --
      // which is why the benchmark could not have caught the shredding bug.
      out.push(
        `${stamp(i)} DEBUG resolving dependency graph for package-${i % 12} req=${reqId(i)}`
      );
    } else if (roll < 0.94) {
      out.push(`${stamp(i)} WARN  peer dependency mismatch for lib-${i % 30}`);
    } else {
      // Unique and load-bearing. Folding these would be the defect.
      out.push(`${stamp(i)} ERROR AssertionError at src/mod${i}.ts:${i % 400}: expected ${i} to equal ${i + 1}`);
    }
  }
  return out.join('\n');
}

/**
 * Search results in the shape HeadRoom actually benchmarks.
 *
 * THIS IS THEIR code-search WORKLOAD, and assuming otherwise cost a lot of
 * wasted tuning. Their generator lives in benchmarks/scenarios/
 * tool_outputs.py as `generate_search_results`, and it emits
 * Elasticsearch-style JSON -- {id, score, title, snippet, source,
 * metadata{author, created_at, category}} -- not grep output. Feeding it
 * ripgrep text compared our number against the wrong one of theirs.
 *
 * IT ALSO PLANTS NEEDLES, and that is the more important half. The
 * generator takes `include_uuid_needles` and `include_errors`, inserting
 * marked records at random positions specifically for relevance testing.
 * A compressor is not allowed to hit a high ratio by dropping them.
 */
function searchJson(r, rows) {
  const items = [];
  for (let i = 0; i < rows; i += 1) {
    items.push({
      id: `doc_${i}`,
      score: Number(Math.max(0.1, 1 - (i * 0.8) / rows).toFixed(4)),
      title: `${pick(r, VERBS)} the ${pick(r, NOUNS).toLowerCase()} correctly`,
      snippet:
        'The retry budget is applied before the operation is abandoned, and the caller receives the last error rather than a generic failure.',
      source: pick(r, ['web', 'internal', 'docs', 'api']),
      metadata: {
        author: `${pick(r, NOUNS)} ${pick(r, VERBS)}`,
        created_at: `2026-0${1 + (i % 9)}-1${i % 10}`,
        category: pick(r, ['technical', 'guide', 'reference', 'tutorial']),
      },
    });
  }
  // The needles, at fixed positions so the gate is deterministic.
  items[Math.floor(rows * 0.78)].uuid = NEEDLE_UUID;
  items[Math.floor(rows * 0.78)].is_needle = true;
  items[Math.floor(rows * 0.39)].error = NEEDLE_ERROR;
  items[Math.floor(rows * 0.39)].status = 'failed';
  return JSON.stringify(items, null, 2);
}

/** Values the gate looks for in the compressed output. */
export const NEEDLE_UUID = '9f1c2b3a-7d4e-4a1b-9c6f-abcdefabcdef';
export const NEEDLE_ERROR = 'Permission denied';

/**
 * The CRITICAL entry in a structured log, which no arm may drop.
 *
 * The log generator has always produced CRITICAL and ERROR records with
 * stacktraces and documented them as needles, but no gate looked for them --
 * `fixture.needles` was set on `code-search` alone. An arm could therefore
 * discard every exception in a 900-line incident log and pass all four gates,
 * on the workload where the exceptions ARE the content.
 */
export const NEEDLE_CRITICAL =
  'FATAL: primary datastore unreachable, failing over';

/**
 * The relevance needle, and why it is shaped differently from the two above.
 *
 * The UUID and error needles are STRUCTURAL: they add a key the other rows
 * lack, so anomaly preservation rescues them and the gate proves the engine
 * is not truncating. This one adds no key at all -- it is byte-for-byte the
 * same shape as its neighbours and sits deep in the tail. Nothing in the
 * content can save it. It survives only if the question is read off the
 * request and used to rank retention, which makes it the only end-to-end
 * check that relevance is wired up at all: a size benchmark cannot see it,
 * because relevance reorders a fixed budget rather than enlarging one.
 */
export const NEEDLE_RELEVANT = 'connection pool exhausted after the deploy';
export const RELEVANCE_QUESTION =
  'Why is the connection pool exhausted since the deploy?';

/**
 * A payload whose only distinguishing row is distinguished by CONTENT.
 *
 * `plant` is not decoration. The needle goes ONLY in the fresh turn: planted in
 * the cached prefix as well, v1 would pass the gate for free, because v1 never
 * rewrites the prefix and the string would still be in the request no matter
 * what the engines did. That is exactly the vacuous gate this file warns about
 * elsewhere -- caught by disabling relevance and watching v1 pass anyway.
 */
function relevanceJson(r, rows, plant) {
  const items = [];
  for (let i = 0; i < rows; i += 1) {
    items.push({
      id: `evt_${i}`,
      level: "info",
      message:
        plant && i === Math.floor(rows * 0.83)
          ? NEEDLE_RELEVANT
          : `${pick(r, VERBS)} the ${pick(r, NOUNS).toLowerCase()} for tenant ${i % 7}`,
      elapsed_ms: Math.floor(r() * 400),
    });
  }
  return JSON.stringify(items, null, 2);
}

/** An issue-triage payload: a JSON array of realistic issue objects. */
function issueJson(r, rows) {
  const items = [];
  for (let i = 0; i < rows; i += 1) {
    items.push({
      number: 3000 + i,
      title: `[BUG] ${pick(r, VERBS)} ${pick(r, NOUNS).toLowerCase()} fails when input is empty`,
      state: r() < 0.7 ? 'open' : 'closed',
      assignee: null,
      milestone: null,
      labels: r() < 0.5 ? ['bug'] : ['bug', 'needs-triage'],
      comments: Math.floor(r() * 20),
      body: `Steps to reproduce:\n1. Run the command\n2. Observe failure ${i}\n\nExpected: success. Actual: exit ${1 + (i % 3)}.`,
      closed_at: null,
      author_association: 'CONTRIBUTOR',
    });
  }
  return JSON.stringify(items, null, 2);
}

/** Prose: a design note with real content and real filler. */
function designProse(r, paragraphs) {
  const out = [];
  for (let i = 0; i < paragraphs; i += 1) {
    out.push(
      `The ${pick(r, NOUNS).toLowerCase()} layer must never drop a record silently, because a caller cannot distinguish an empty result from a failure. ` +
        `It is worth noting that this is generally considered good practice. ` +
        `As we mentioned, the retry budget is ${3 + (i % 5)} attempts before the operation is abandoned. ` +
        `In other words, the system might possibly retry somewhat more often than strictly necessary. ` +
        `The error surfaces at src/layer${i}.ts:${40 + i} with exit code ${1 + (i % 2)}. ` +
        `Needless to say, callers should handle it.`
    );
  }
  return out.join('\n\n');
}

/**
 * A session that reads the same things more than once.
 *
 * NOT A CONTRIVANCE, and worth defending because it is the one workload here
 * with no counterpart in HeadRoom's published set. An agentic coding session
 * repeats itself constantly and for good reasons: read a file, edit it, read
 * it back to check the edit; run the tests, fix, run them again; grep, follow
 * a hit, grep the same pattern again from somewhere else. Their four
 * workloads are all single-shot payloads, so none of them can show what a
 * forty-turn session actually spends its tokens on.
 *
 * The repeats here are EXACT, because that is the only case either design
 * dedups. A file re-read after a real edit is different content and must stay
 * whole -- the edit is the thing the agent is looking at.
 */
function repeatedReads(root, budget) {
  const file = realSources(root, budget);
  const tests = buildLog(rng(20260910), 300);
  return { file, tests };
}

/** Wraps content as an Anthropic-shaped request with a cache breakpoint. */
function request(system, cachedTurns, freshBlocks) {
  const messages = [];
  for (const [i, text] of cachedTurns.entries()) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [
        {
          type: 'text',
          text,
          // The last cached turn carries the breakpoint.
          ...(i === cachedTurns.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
        },
      ],
    });
  }
  messages.push({
    role: 'user',
    content: freshBlocks.map((text) => ({ type: 'text', text })),
  });
  return { system, messages, tools: [] };
}

/** The four workloads. */
export function fixtures() {
  const r = rng(20260909);
  return [
    {
      name: 'code-search',
      theirs: { before: 17765, after: 1408 },
      // Needles must survive this one; see needles below.
      needles: true,
      request: request(
        'You are a coding agent.',
        [searchJson(r, 40), 'Searching for the retry helper.'],
        [searchJson(r, 260)]
      ),
    },
    {
      name: 'sre-debugging',
      theirs: { before: 65694, after: 5118 },
      criticalNeedle: true,
      request: request(
        'You are an SRE agent.',
        [structuredLog(r, 120), 'Investigating the failed deploy.'],
        [structuredLog(r, 900)]
      ),
    },
    {
      // OUR OWN, HARDER CASE, kept because real build output is raw text with a
      // correlation id per line and no JSON structure to exploit. No published
      // comparator, so it is reported rather than compared.
      name: 'raw-build-log',
      theirs: null,
      request: request(
        'You are an SRE agent.',
        [buildLog(r, 200), 'Investigating the failed deploy.'],
        [buildLog(r, 1800)]
      ),
    },
    {
      name: 'issue-triage',
      theirs: { before: 54174, after: 14761 },
      request: request(
        'You are triaging issues.',
        [issueJson(r, 20), 'Grouping by root cause.'],
        [issueJson(r, 220)]
      ),
    },
    {
      // Kept as a fifth workload: ripgrep text is real tool output we handle,
      // it is simply not what their code-search figure measures.
      name: 'grep-output',
      theirs: null,
      request: request(
          'You are a coding agent.',
        [searchResults(join(REPO, 'hooks-core'), /function |=> \{/, 12_000), 'Reading hits.'],
        [searchResults(join(REPO, 'src', 'tools'), /function |=> \{/, 60_000)]
      ),
    },
    {
      // OURS. The question is a real question, and the row that answers it
      // is shape-identical to 300 others -- so only relevance can keep it.
      name: 'relevance-probe',
      theirs: null,
      relevanceNeedle: true,
      request: request(
        'You are debugging a production incident.',
        [relevanceJson(r, 40, false), RELEVANCE_QUESTION],
        [relevanceJson(r, 300, true), RELEVANCE_QUESTION]
      ),
    },
    {
      // OURS, AND THE ONE THEIR WORKLOADS CANNOT SHOW. A session that reads
      // the same file three times and the same test output twice, which is
      // what a long coding session actually does. No published comparator.
      name: 'repeated-reads',
      theirs: null,
      request: (() => {
          const { file, tests } = repeatedReads(join(REPO, 'src', 'core'), 20_000);
          return request(
            'You are a coding agent.',
            [file, 'Reading the cache engine.'],
            [tests, file, 'Fixing the failing case.', tests, file]
          );
        })(),
    },
    {
      name: 'codebase-exploration',
      theirs: { before: 78502, after: 41254 },
      request: request(
        'You are exploring a codebase.',
        [realSources(join(REPO, 'src', 'core'), 12_000), 'Mapping the module graph.'],
        [realSources(join(REPO, 'src', 'server'), 45_000), buildLog(r, 400), designProse(r, 40)]
      ),
    },
  ];
}
