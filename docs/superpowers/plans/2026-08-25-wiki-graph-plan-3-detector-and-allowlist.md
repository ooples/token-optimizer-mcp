# Wiki Graph Plan 3 — The Detector and Its Allowlist

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the defect class rather than its instances — fix the two holes in the existing reachability detector, extend it to the three sub-classes it cannot see, and empty its allowlist to zero backlog entries.

**Architecture:** `tests/hooks/reachability.test.mjs` already exists and is the right idea; it fails in two specific ways. This plan makes its scan comment-aware, extends declaration collection beyond `export function`, adds producer/consumer censuses for event kinds, edge kinds and tool names, and resolves the remaining allowlist entries by wiring or deleting each.

**Tech Stack:** Node 22 ESM, Jest. No new dependencies — the detector reads source text.

**Spec:** `docs/superpowers/specs/2026-08-25-wiki-graph-gap-closure-design.md`

**Depends on:** Plans 1 and 2 remove seven allowlist entries as a side effect of wiring their subsystems. This plan removes the remainder and makes the guard airtight. **Run it last**, or its first task will fail on work the other plans have not done yet.

---

## EXECUTION NOTE — read before implementing Task 1

This plan was executed against master after Plan 1 merged (#315) and while Plan 2
was still in flight. Three things in it are wrong, and correcting them here is
cheaper than rediscovering them.

**1. Task 1 Step 3's `stripComments` must NOT be implemented.** The scanner it
proposes skips string and template literals, and a JS lexer that knows about
quotes but not about REGEX LITERALS desynchronises on the first regex containing
a quote. `hooks-core/adapter.mjs:255` is one. Measured: adapter.mjs 1032
newlines in, 385 out — 63% of the file consumed; disclose.mjs 69%. Eleven
genuinely-called exports (`toolSucceeded`, `stableText`, `recordToolOutcome`,
`recordEpisodeOutcome`, `DISCLOSE_THRESHOLD`, `invalidateOnWrite`,
`invalidateChangedAnchors`, `prices`, `briefing`, `semanticHarvestPrompt`,
`cachedRoutingBriefing`) fall to their own declaration and report as orphans.
That violates this plan's own first Global Constraint. The comments-only
boundary already on master is correct; pin it with tests instead.

**2. Task 3's extractors were wrong in two ways, both measured against grep.**
`putEdge(dir, from, edge, to)` takes the edge kind as its THIRD argument, not
its second, and the call writing `calls` edges spans six lines in
`staleness.mjs` — so the proposed single-line second-argument regex reports the
graph's own call-edge kind as having no writer. Separately, a fixed character
window over `record(` overruns the call in `mcp-evidence.ts` and collects a
field belonging to the next function; the field census must be brace-balanced
and must SKIP any literal it cannot balance, because there over-reporting is the
strict direction.

**3. Task 5's target is stale.** It says the allowlist should end at one entry,
`policyText`. `policyText` was already removed before this plan ran — it has
callers in `adapter.mjs` and the SessionStart hook. The real target is **zero**.

**4. Tasks 3 and 5 cannot go green while Plan 2 is outstanding**, and shipping a
knowingly-red suite teaches everyone to ignore it. Five allowlist entries are
Plan 2's (`selectForConsolidation`, `contentAnchor` — its Task 4;
`consolidationRatio` — Task 8; `recordRefresh`, `recordRefreshOutcome` — Task
9). Both lists are therefore ratcheted to a ceiling that can only fall, with
every entry attributed to the task that owes it, rather than asserted at zero.

## Global Constraints

- **The detector must be wrong only in the permissive direction.** A check that fails CI on working code gets deleted within a week — `reachability.test.mjs` says so itself, and it is right.
- **Every allowlist entry needs a reason.** By the end of this plan the only entry is `policyText`.
- **Never edit a vendored copy.** `hooks-core/` then `npm run sync:hooks`.
- **Branch:** `feat/close-wiki-graph-gaps`.

---

## Why this plan exists

Round 1 built this detector. It found ~21 instances of correct-but-unreachable code, four were wired, and sixteen were moved to an allowlist labelled `TRIAGE BACKLOG` — in a file whose own documentation says *"If the reason is 'we might use it later', the honest action is to delete the function and write it again when that day comes."*

The disease is not blindness. **An accurate written description of a defect felt like resolution.** Two mechanical holes let it stick:

| Hole | Evidence |
|---|---|
| `usedInShippedCode` bare-word-matches **raw text**, so a comment counts as a call site | `invalidateOnWrite`: 1 raw reference, 0 code references. The reference is prose at `pretooluse-router.mjs:153`. Remove the allowlist entry and the test still passes. |
| Only `export function` is collected — 38 exported consts are invisible | `contradicts` and `answers` sat in `EDGE_KINDS` with zero write sites |

**A THIRD HOLE, found during Plan 1 Task 8.** `usedInShippedCode` word-matches over
stripped code, so an `import { name }` specifier counts as a use. A function can be
imported and never called and the guard passes it. Proven by mutation: dropping the
`cacheOrdered` CALL while keeping its import left reachability green; only dropping
the import too made it fail. So Task 1 must discount import and export specifier
occurrences as well as comments and strings — "imported" is not "called".

**A FOURTH HOLE, and a FIFTH, found while executing Plan 1.**

*Fourth:* the scan checks EXPORTS, so an unread RECORD FIELD is invisible to it.
`contradictionReason` -- up to 400 characters of human explanation -- was written on
every `contradict` call with the guard green throughout, and read by nothing. Plan 3
needs a written-fields-versus-read-fields census, or this class stays undetectable.

*Fifth (test hygiene, not reachability):* several entry points consult the stratified
holdout (`forTouch`, `forCommand`, `forSharedCommand`, `substitutionFor`), so a test
asserting on their output must pin `TOKEN_OPTIMIZER_HOLDOUT` or it fails
intermittently when the anchor lands in the withheld arm. The convention is
copy-pasted per suite in three different variants and nothing enforces it -- one
newly-added test on this branch omitted it and produced exactly that flake. A guard
asserting that every suite calling a holdout-consulting entry point pins the arm
would close it.

And three sub-classes are outside its model entirely: readers with no producer (`kind:'query'`), producers with no reader (`kind:'lessons'`), and referents with no target (`wiki_query`, named in twelve shipped copies of injected prompt text).

---

## File Structure

| File | Responsibility |
|---|---|
| `tests/hooks/reachability.test.mjs` | Comment-aware scan; const declarations; the allowlist. |
| `tests/hooks/census.test.mjs` **(new)** | Event-kind, edge-kind and tool-name producer/consumer censuses. |
| `scripts/wiki-census.mjs` **(new)** | Runnable census for the acceptance criteria — live state, not CI state. |
| `hooks-core/standing.mjs` | `renderStanding` gains a caller. |
| `hooks-core/audit.mjs` | Renders the standing panel. |
| `hooks-core/doctor.mjs` | Reports manifest coverage via `manifestSize`. |

---

## Task 1: Make the scan comment-aware

**Files:** Modify `tests/hooks/reachability.test.mjs`

**Interfaces:**
- Produces: `stripComments(text: string) => string` (module-local); `usedInShippedCode` consumes stripped text.

- [ ] **Step 1: Write the failing test**

Add this to `reachability.test.mjs`. It asserts the hole directly, using a name that is genuinely prose-only, so it fails before the fix and passes after.

```javascript
describe('the scan does not mistake prose for a call site', () => {
  it('ignores a name that appears only in a comment', () => {
    const text = [
      '// A write the hook observes is invalidated eagerly by `someOrphanFn`, so',
      'export function other() { return 1; }',
    ].join('\n');
    expect(stripComments(text)).not.toContain('someOrphanFn');
  });

  it('ignores a name inside a block comment', () => {
    expect(stripComments('/* calls someOrphanFn */ const x = 1;')).not.toContain('someOrphanFn');
  });

  it('keeps real code intact, including a URL that contains a double slash', () => {
    const code = "const url = 'https://example.com/x'; realCall();";
    const stripped = stripComments(code);
    expect(stripped).toContain('realCall');
    expect(stripped).toContain('example.com');
  });
});
```

The third case is the trap: a naïve `indexOf('//')` truncates at the `//` in `https://`, which would silently blind the scan to everything after any URL in a file. **`stripComments` must not do that.**

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest tests/hooks/reachability.test.mjs -t "prose"`
Expected: FAIL — `stripComments is not defined`

- [ ] **Step 3: Implement `stripComments`**

```javascript
/**
 * Removes comments and string literals before the usage scan.
 *
 * THIS IS THE HOLE THAT MADE THE ALLOWLIST NECESSARY. `usedInShippedCode`
 * matched raw file text, so DOCUMENTING a dead function marked it live:
 * `invalidateOnWrite` had exactly one reference in shipped code and it was a
 * comment. Measured before this fix: 1 raw reference, 0 code references.
 *
 * Written as a small scanner rather than regexes because the naive line-comment
 * regex truncates at the `//` inside `https://`, which would blind the scan to
 * everything after any URL -- a silent permissive failure, which is exactly the
 * kind this guard exists to prevent.
 */
function stripComments(text) {
  const source = String(text);
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    // Line comment: only when not preceded by a colon (the `https://` case is
    // handled by string skipping below, but a bare scheme in code is not).
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // String and template literals are skipped whole: a name inside a string is
    // not a call. Template literals may nest `${}`, but a name there is code, so
    // template contents are preserved rather than dropped.
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += ' ';
      continue;
    }
    if (c === '`') {
      i += 1;
      while (i < n && source[i] !== '`') {
        if (source[i] === '\\') { i += 2; continue; }
        // Preserve interpolations -- they contain real code.
        if (source[i] === '$' && source[i + 1] === '{') {
          let depth = 1;
          out += ' ';
          i += 2;
          while (i < n && depth > 0) {
            if (source[i] === '{') depth += 1;
            if (source[i] === '}') depth -= 1;
            if (depth > 0) out += source[i];
            i += 1;
          }
          continue;
        }
        i += 1;
      }
      i += 1;
      out += ' ';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
```

Then change `usedInShippedCode` to scan stripped text:

```javascript
// Stripped ONCE per file, not per name -- this runs over 256 files times ~250
// exported names, and re-stripping per name made the suite visibly slower.
const strippedUsages = usages.map(({ file, text }) => ({ file, text: stripComments(text) }));
```

and have `usedInShippedCode` read `strippedUsages`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest tests/hooks/reachability.test.mjs`
Expected: the three new tests PASS. **The orphan assertions may now fail with new names** — that is the hole closing. Record the list; Task 5 resolves it.

- [ ] **Step 5: Commit**

```bash
git add tests/hooks/reachability.test.mjs
git commit -m "test(reachability): stop counting comments as call sites

usedInShippedCode matched raw text, so documenting a dead function marked it
live -- invalidateOnWrite had 1 raw reference and 0 code references, the
reference being prose. This is the hole that made the allowlist necessary."
```

---

## Task 2: Collect exported consts, not just functions

**Files:** Modify `tests/hooks/reachability.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
it('collects exported consts, which were invisible to the scan', () => {
  const names = exportedNames().map((e) => e.name);
  // EDGE_KINDS is an exported const in hooks-core/wiki.mjs. If the collector
  // only sees `export function`, 38 declarations go unchecked -- which is where
  // contradicts and answers hid with zero write sites.
  expect(names).toContain('EDGE_KINDS');
});
```

- [ ] **Step 2: Run to verify it fails** → `EDGE_KINDS` absent

- [ ] **Step 3: Rename `exportedFunctions` to `exportedNames` and add the const pattern**

```javascript
/** Every `export function` / `export async function` / `export const` in the live path. */
function exportedNames() {
  const found = [];
  for (const { file, text } of declarations) {
    const code = stripComments(text);
    for (const re of [
      /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
      /export\s+const\s+([A-Za-z_$][\w$]*)/g,
    ]) {
      let m;
      while ((m = re.exec(code)) !== null) found.push({ name: m[1], file });
    }
  }
  return found;
}
```

Update the declaration-subtraction in `usedInShippedCode` to discount `export const NAME` as well as `export function NAME`, or a const referenced nowhere else will look used by its own declaration.

- [ ] **Step 4: Run** → the new test passes; expect additional orphans reported.
- [ ] **Step 5: Commit**

```bash
git add tests/hooks/reachability.test.mjs
git commit -m "test(reachability): check exported consts too -- 38 were invisible"
```

---

## Task 3: Producer/consumer censuses

**Files:** Create `tests/hooks/census.test.mjs`

**Interfaces:**
- Produces (module-local): `eventKinds()`, `edgeKinds()`, `toolNamesInInjectedText()`

**Note on false positives:** `kind` is used in at least three unrelated namespaces — event kinds, node kinds (`file`/`symbol`/`task`/`finding`), symbol kinds (`function`/`class`/`variable`), standing-entry kinds (`skill`/`agent`), and a token-type parameter in `pricing.mjs`. A census that conflates them reports confident nonsense. Restrict extraction to `record(` / `recordRead(` call sites for producers and to `metrics.mjs` consumers for readers, and keep an explicit non-event allowlist.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/hooks/census.test.mjs
import { describe, it, expect } from '@jest/globals';

describe('event kinds', () => {
  it('has no kind that is read but never written', () => {
    const { written, read } = eventKinds();
    const orphanReaders = [...read].filter((k) => !written.has(k));
    // `query` was read by indexBudget and written only by the test suite, so
    // the ratio was 0 for every project and the budget sat at its floor.
    expect(orphanReaders).toEqual([]);
  });

  it('has no kind that is written but never read', () => {
    const { written, read } = eventKinds();
    const orphanWriters = [...written].filter((k) => !read.has(k));
    // `lessons` was written by harvest-worker.mjs:113 and read by nothing.
    expect(orphanWriters).toEqual([]);
  });
});

describe('edge kinds', () => {
  it('has a write site for every declared edge kind', () => {
    const { declared, written } = edgeKinds();
    expect([...declared].filter((k) => !written.has(k))).toEqual([]);
  });
});

describe('tool names in injected text', () => {
  it('names no tool that does not exist', () => {
    // The SessionStart index told the model to call wiki_query for a year.
    expect(toolNamesInInjectedText().missing).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest tests/hooks/census.test.mjs`
Expected: FAIL on any sub-class Plans 1 and 2 have not yet closed. If all four pass immediately, verify the extractors actually find something — add an assertion that `written.size > 5` so a broken census cannot report a clean bill of health.

- [ ] **Step 3: Implement the three censuses**

```javascript
/** Event kinds, restricted to record()/recordRead() call sites and metrics readers. */
function eventKinds() {
  // NOT an event kind. `kind` is overloaded across four namespaces in this
  // codebase and conflating them produces confident nonsense -- verified by
  // getting it wrong once: `output` is a token-type in pricing.mjs, `skill` and
  // `agent` are standing-context entry types, `file`/`symbol`/`task`/`finding`
  // are node kinds.
  const NOT_EVENTS = new Set([
    'file', 'symbol', 'task', 'finding',
    'function', 'class', 'variable', 'expression', 'reexport',
    'skill', 'agent', 'output', 'ours', 'yours',
  ]);

  const written = new Set();
  for (const { text } of declarations) {
    const code = stripComments(text);
    // Two-line window after a record( call, which is how these are written.
    const re = /record(?:Read)?\(\s*[A-Za-z_$][\w$]*\s*,\s*\{[^}]{0,200}?kind:\s*'([a-z_]+)'/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      if (!NOT_EVENTS.has(m[1])) written.add(m[1]);
    }
  }

  const read = new Set();
  for (const { file, text } of declarations) {
    if (!/metrics\.mjs$/.test(file)) continue;
    const code = stripComments(text);
    const re = /kind\s*[=!]==\s*'([a-z_]+)'/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      if (!NOT_EVENTS.has(m[1])) read.add(m[1]);
    }
  }

  return { written, read };
}

/** Declared edge kinds against actual putEdge / putNodeWithEdges write sites. */
function edgeKinds() {
  const wiki = declarations.find(({ file }) => /hooks-core[\\/]wiki\.mjs$/.test(file));
  const block = /export const EDGE_KINDS = \[([\s\S]*?)\]/.exec(stripComments(wiki.text));
  const declared = new Set([...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

  const written = new Set();
  for (const { text } of declarations) {
    const code = stripComments(text);
    for (const m of code.matchAll(/putEdge\([^,]+,\s*'([a-z_]+)'/g)) written.add(m[1]);
    for (const m of code.matchAll(/edge:\s*'([a-z_]+)'/g)) written.add(m[1]);
  }
  return { declared, written };
}

/** Tool names appearing in injected prompt text, checked against the registry. */
function toolNamesInInjectedText() {
  const registry = new Set();
  for (const { file, text } of usages) {
    if (!/tool-schemas\.ts$/.test(file)) continue;
    for (const m of stripComments(text).matchAll(/^\s{2}([a-z_]+):\s*\w+Schema,/gm)) {
      registry.add(m[1]);
    }
  }

  const mentioned = new Set();
  for (const { file, text } of declarations) {
    // Injected text lives in template literals, which stripComments preserves
    // only for interpolations -- so scan the RAW text here and accept that a
    // tool name in a comment counts. Over-reporting is the safe direction for
    // this particular check: a name in a comment that does not exist is still
    // worth knowing about.
    if (!/inject\.mjs$|policy\.mjs$|adapter\.mjs$/.test(file)) continue;
    for (const m of text.matchAll(/\b(smart_[a-z_]+|wiki_[a-z_]+|optimize_session|get_optimization_report)\b/g)) {
      mentioned.add(m[1]);
    }
  }

  return { mentioned, registry, missing: [...mentioned].filter((t) => !registry.has(t)) };
}
```

- [ ] **Step 4: Run to verify it passes** (after Plans 1 and 2)
- [ ] **Step 5: Commit**

```bash
git add tests/hooks/census.test.mjs
git commit -m "test(census): catch the three sub-classes the reachability scan cannot see

Readers with no producer (kind:'query'), producers with no reader
(kind:'lessons'), and referents with no target (wiki_query in seven shipped
copies of injected text). The overloaded `kind` field is namespaced explicitly,
because conflating the four namespaces produced confident nonsense on the first
attempt."
```

---

## Task 4: Wire `renderStanding` and `manifestSize`

**Files:** Modify `hooks-core/audit.mjs`, `hooks-core/doctor.mjs`, `tests/hooks/reachability.test.mjs`; Test `tests/hooks/standing.test.mjs`, `tests/hooks/doctor.test.mjs`

**Why:** `auditStanding` and `verdictFor` are both reachable, so something already computes which CLAUDE.md rules and skills are stale or never used, and throws the result away. Skills/memory health is one of the gaps #203 claimed closed, which is hard to defend while the report cannot be seen.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/hooks/standing.test.mjs
it('includes the standing-context panel in the audit output', () => {
  const output = renderAudit(auditFixture());
  expect(output).toMatch(/standing context|never used|stale instruction/i);
});
```

```javascript
// tests/hooks/doctor.test.mjs
it('reports what the installation manifest covers', () => {
  expect(diagnose().some((row) => /manifest/i.test(row.label))).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Call `renderStanding` from `audit.mjs`** where the other panels are assembled, and `manifestSize` from `doctor.mjs` in the installation section.
- [ ] **Step 4: Remove both allowlist entries.**
- [ ] **Step 5: Run** `npx jest tests/hooks/standing.test.mjs tests/hooks/doctor.test.mjs tests/hooks/audit.test.mjs tests/hooks/reachability.test.mjs` → PASS
- [ ] **Step 6: Commit**

```bash
npm run sync:hooks
git add hooks-core/audit.mjs hooks-core/doctor.mjs tests plugin integrations
git commit -m "feat(audit): surface the standing-context report and manifest coverage

auditStanding computed which rules are stale or never used and nothing showed
it. Skills and memory health is a gap #203 claimed closed."
```

---

## Task 5: Empty the allowlist

**Files:** Modify `tests/hooks/reachability.test.mjs`

- [ ] **Step 1: Remove the stale `forTouch` entry**

It has 2 real call sites (verified by probe), so the entry is dead weight that would mask a regression.

- [ ] **Step 2: Confirm the remaining entries are gone**

By this point Plans 1 and 2 plus Task 4 have resolved: `invalidateOnWrite`, `cacheOrdered`, `selectForConsolidation`, `consolidationRatio`, `contentAnchor` (deleted), `recordRefresh`, `recordRefreshOutcome`, `renderStanding`, `manifestSize`.

Run: `grep -c "^  \['" tests/hooks/reachability.test.mjs`
Expected: `1` — only `policyText`.

- [ ] **Step 3: Add the ratchet that stops the list growing back**

```javascript
it('keeps the allowlist at zero backlog entries', () => {
  // The list is not a backlog. Round 1 built this detector, it found ~21
  // unreachable capabilities, four were wired and sixteen were parked here with
  // accurate descriptions -- and an accurate description of a defect felt like
  // resolution. Every entry now must be genuine public API, and there is
  // exactly one.
  const backlog = [...ALLOWED.entries()].filter(([, reason]) => !/^PUBLIC API/.test(reason));
  expect(backlog).toEqual([]);
});
```

- [ ] **Step 4: Run the full suite**

Run: `npm run build && npx jest && npm run sync:hooks:check`
Expected: PASS, PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add tests/hooks/reachability.test.mjs
git commit -m "test(reachability): empty the allowlist, and refuse a new backlog entry

Sixteen capabilities were parked here with accurate descriptions of what was
wrong with them. That is how round 1 ended: an honest note where a wire or a
deletion belonged. Entries must now be genuine public API, and there is one."
```

---

## Task 6: The census script — acceptance measured, not asserted

**Files:** Create `scripts/wiki-census.mjs`; Modify `package.json`

**Why:** every one of the ten instances passed CI. A green suite is not evidence that the graph is alive; the live logs are. This script is what the spec's acceptance criteria are checked against, and it can be re-run any time to see whether the graph is still working.

- [ ] **Step 1: Write the script**

```javascript
#!/usr/bin/env node
/**
 * What the graph is actually doing, on this machine, right now.
 *
 * NOT A TEST. Every instance of the wiring defect this work closed passed CI --
 * the detector that found them is a test, but the evidence that a capability is
 * ALIVE is that its events exist in a real log. This prints that.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || join(process.cwd(), '.token-optimizer', 'wiki');
const count = (file, pattern) => {
  const path = join(dir, file);
  if (!existsSync(path)) return 0;
  return (readFileSync(path, 'utf8').match(pattern) || []).length;
};

const rows = [
  ['findings in graph', count('graph.jsonl', /"kind":"finding"/g)],
  ['query events', count('metrics.jsonl', /"kind":"query"/g)],
  ['index events', count('metrics.jsonl', /"kind":"index"/g)],
  ['result events', count('metrics.jsonl', /"kind":"result"/g)],
  ['inject events', count('metrics.jsonl', /"kind":"inject"/g)],
  ['contradicts edges', count('graph.jsonl', /"edge":"contradicts"/g)],
  ['answers edges', count('graph.jsonl', /"edge":"answers"/g)],
];

console.log(`\nwiki census -- ${dir}\n`);
for (const [label, value] of rows) {
  const flag = value === 0 ? '  <-- DEAD' : '';
  console.log(`  ${String(value).padStart(7)}  ${label}${flag}`);
}
console.log('\nA zero on any row means that capability is declared and not running.\n');
```

- [ ] **Step 2: Add the script to `package.json`**

```json
    "wiki:census": "node scripts/wiki-census.mjs",
```

- [ ] **Step 3: Run it**

Run: `npm run wiki:census`
Expected: it prints. Before this work: findings 1, query 0, index 0, result 0, contradicts 0, answers 0. After a working session with all three plans landed, every row should be non-zero.

- [ ] **Step 4: Commit**

```bash
git add scripts/wiki-census.mjs package.json
git commit -m "chore(wiki): census script -- acceptance measured from live logs, not CI

Every instance of the wiring defect passed CI. A green suite is not evidence
that a capability runs; events in a real log are."
```

---

## Task 7: Close out the documentation and the issues

- [ ] **Step 1: Update `docs/WIKI_GRAPH.md`** — hit rate defined as Layer 1 calibrated against Layer 2, with the interference, power and selection limitations stated rather than implied.
- [ ] **Step 2: Add the status column to `docs/COMPETITIVE_GAPS.md`**, and correct the stale concession: the doc still says our delta-on-re-read "requires the model to reissue the call against `smart_read`", which zero-turn substitution made untrue.
- [ ] **Step 3: Tick #204's phases with census output**, not assertions. Note explicitly which parts of the design were **changed** rather than implemented: hit rate was redefined, `contentAnchor` was deleted with a follow-up issue, and `GRAPH_VERSION` was deliberately not bumped.
- [ ] **Step 4: Open the PR**

```bash
npm run validate:pr && npm run pr:create
```

Never `gh pr create` directly — it bypasses the validation pipeline.

- [ ] **Step 5: Commit any doc fixes the validation surfaces**

---

## Definition of done for Plan 3

| Check | Command | Expected |
|---|---|---|
| Prose is not a call site | `npx jest tests/hooks/reachability.test.mjs -t prose` | PASS |
| Consts are checked | `EDGE_KINDS` appears in `exportedNames()` | true |
| No dead event kinds | `npx jest tests/hooks/census.test.mjs` | PASS |
| No dead edge kinds | same | PASS |
| No dangling tool names | same | PASS |
| Allowlist has no backlog | `grep -c "^  \['" tests/hooks/reachability.test.mjs` | 1 (`policyText`) |
| Census runs | `npm run wiki:census` | every row non-zero after a session |
| Full suite green | `npm run build && npx jest && npm run sync:hooks:check` | PASS |
