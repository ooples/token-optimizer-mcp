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

/** A build/test log: heavy repetition, with genuine failures that must survive. */
function buildLog(r, lines) {
  const out = [];
  const stamp = (i) => `2026-09-09T18:${String(10 + (i % 50)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`;
  for (let i = 0; i < lines; i += 1) {
    const roll = r();
    if (roll < 0.55) {
      out.push(`${stamp(i)} INFO  webpack: compiled module ${i % 9} successfully`);
    } else if (roll < 0.8) {
      out.push(`${stamp(i)} DEBUG resolving dependency graph for package-${i % 12}`);
    } else if (roll < 0.94) {
      out.push(`${stamp(i)} WARN  peer dependency mismatch for lib-${i % 30}`);
    } else {
      // Unique and load-bearing. Folding these would be the defect.
      out.push(`${stamp(i)} ERROR AssertionError at src/mod${i}.ts:${i % 400}: expected ${i} to equal ${i + 1}`);
    }
  }
  return out.join('\n');
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
      request: request(
        'You are a coding agent.',
        [
          searchResults(join(REPO, 'hooks-core'), /function |=> \{/, 12_000),
          'Searching for the retry helper.',
        ],
        [searchResults(join(REPO, 'src', 'tools'), /function |=> \{/, 60_000)]
      ),
    },
    {
      name: 'sre-debugging',
      theirs: { before: 65694, after: 5118 },
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
