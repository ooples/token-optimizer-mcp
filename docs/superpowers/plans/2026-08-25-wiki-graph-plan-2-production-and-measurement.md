# Wiki Graph Plan 2 — Production and Measurement

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a default install produce findings without a model call, and measure per-finding value causally rather than by guessing whether a retrieval was "used".

**Architecture:** Extraction runs at `Stop`, derives findings from data the hooks already hold (exit codes, test transitions, corrections, churn), passes them through budgeted selection, and stores them with the same anchor discipline as every other writer. Measurement is two layers: a cheap explicit-reference label, and a per-finding leave-one-out holdout whose effect is shrunk by empirical Bayes and published under FDR control. The two are deliberately independent so calibrating one against the other is not circular.

**Tech Stack:** Node 22 ESM for hooks-core, TypeScript for `src/`, Jest.

**Spec:** `docs/superpowers/specs/2026-08-25-wiki-graph-gap-closure-design.md`

**Depends on:** Plan 1 (the `query` event supplies Layer 1's numerator; `contradict`/`hasOutstandingContradiction` gate confidence).

## Global Constraints

- **Never edit a vendored copy.** Edit `hooks-core/`, run `npm run sync:hooks`.
- **Fail open.** Extraction and measurement must never break a tool call or a session end.
- **No model call in `derive.mjs`.** Nothing leaves the machine. That is what makes it safe on by default.
- **Redaction is mandatory** on any text derived from captured output, before storage.
- **No `GRAPH_VERSION` bump.** Per-finding utility lives in metrics, never in graph nodes.
- **Confidence is never raised by utility.** Promotion requires `!hasOutstandingContradiction`.
- **No dollar figure on an estimated saving.** Currency appears only on measured-counterfactual lines, sourced from `pricing.mjs`.
- **Anchor discipline.** `indexFile` first; refuse unanchorable findings.
- **Branch:** `feat/close-wiki-graph-gaps`.

---

## File Structure

| File | Responsibility |
|---|---|
| `hooks-core/redact.mjs` **(new)** | Secret-pattern redaction and capping for any derived claim text. |
| `hooks-core/derive.mjs` **(new)** | The four zero-cost extractors. No model, no network. |
| `hooks-core/adapter.mjs` | post-tool records exit code and truncated output; Stop runs `derive`. |
| `hooks-core/consolidate.mjs` | `selectForConsolidation` gains its caller; `contentAnchor` is deleted. |
| `hooks-core/usage.mjs` **(new)** | Layer 1: explicit-reference classification per injection. |
| `hooks-core/loo.mjs` **(new)** | Layer 2: leave-one-out arms, empirical Bayes, BH-FDR, ε-exploration. |
| `hooks-core/metrics.mjs` | Report gains Layer 1, Layer 2, the calibration verdict, `consolidationRatio`. |
| `hooks-core/keepwarm.mjs` | `recordRefresh`/`recordRefreshOutcome` wired; decision reads observed hit rate. |
| `hooks-core/recall.mjs` **(new)** | Held-out retrieval probe. |
| `hooks-core/inject.mjs` | Consults `loo.mjs` for which finding to withhold; ε-exploration. |
| `src/tools/analytics/get-optimization-report.ts` | Routes `balanceSheet()`; pricing via `pricing.mjs`. |

---

## Task 1: Redaction, before anything derives a claim

**Files:** Create `hooks-core/redact.mjs`; Test `tests/hooks/redact.test.mjs`

**Interfaces:**
- Produces: `redact(text: string, { max?: number }) => string`

**Why first:** every later task in this plan writes claim text derived from captured command output. Claims are injected into context *and* exported to markdown, so a secret in stderr becomes a secret in two more places. This must exist before the first extractor.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/hooks/redact.test.mjs
import { describe, it, expect } from '@jest/globals';
import { redact } from '../../hooks-core/redact.mjs';

describe('redact', () => {
  it('removes bearer tokens', () => {
    expect(redact('failed: Authorization: Bearer sk-abc123def456ghi789')).not.toContain('sk-abc123');
  });
  it('removes assignments that look like secrets', () => {
    expect(redact('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG')).not.toContain('wJalrXUtnFEMI');
  });
  it('removes connection strings with credentials', () => {
    expect(redact('postgres://user:hunter2@db:5432/x')).not.toContain('hunter2');
  });
  it('keeps ordinary error text intact', () => {
    const text = 'TS2345: Argument of type string is not assignable to number';
    expect(redact(text)).toBe(text);
  });
  it('caps length', () => {
    expect(redact('x'.repeat(5000), { max: 400 }).length).toBeLessThanOrEqual(400);
  });
  it('never throws on non-string input', () => {
    expect(() => redact(null)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest tests/hooks/redact.test.mjs` → FAIL, module not found.

- [ ] **Step 3: Implement**

```javascript
// hooks-core/redact.mjs
/**
 * Redaction for anything derived from captured output.
 *
 * WHY THIS IS MANDATORY RATHER THAN PRUDENT. derive.mjs builds claims out of
 * command stderr. A claim is INJECTED into model context and EXPORTED to
 * markdown, so a secret that reaches a claim reaches two more places than the
 * terminal it came from. Pattern matching is imperfect and that is stated in the
 * spec, but "imperfect" beats "absent" by a wide margin here.
 */

const PATTERNS = [
  // Bearer / API-key shaped tokens.
  [/\b(bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi, '$1[redacted]'],
  [/\b(sk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{10,}/gi, '[redacted]'],
  // KEY=value where the key name suggests a secret.
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*\S+/g, '$1=[redacted]'],
  // Credentials inside a URL.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@]+@/gi, '$1:[redacted]@'],
  // PEM blocks.
  [/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, '[redacted key]'],
];

export function redact(text, { max = 400 } = {}) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out.length > max ? `${out.slice(0, Math.max(0, max - 1))}…` : out;
}
```

- [ ] **Step 4: Run to verify it passes** → `npx jest tests/hooks/redact.test.mjs` → PASS (6)
- [ ] **Step 5: Commit**

```bash
npm run sync:hooks
git add hooks-core/redact.mjs tests/hooks/redact.test.mjs plugin integrations
git commit -m "feat(derive): mandatory redaction for claims derived from captured output"
```

---

## Task 2: Extend `tool-outcome` with output and exit code

**Files:** Modify `hooks-core/adapter.mjs`; Test `tests/hooks/capture-results.test.mjs` **(new)**

**VERIFIED CONTRACT — this task is far smaller than first planned.** The
post-tool branch of `adapter.mjs` (~line 855) already computes the command, the
touched files, the anchor and the project root, and calls
`recordToolOutcome(wikiDir(root), { ...episode, surface, anchor, toolName,
success: toolSucceeded(raw), durationMs, ...usageFrom(raw) })`.
`recordToolOutcome` (`metrics.mjs:505`) writes `kind: 'tool-outcome'` and — the
part that matters most — **already joins the outcome back to its injection**,
recording `injectionId`, `findingIds` and a `joinMethod` of `tool-call-id`,
`episode-anchor` or `none`. This repository holds **234 live `tool-outcome`
events**, so the pipeline runs.

There is therefore **no new event kind**. Add two *optional* fields to what
post-tool already passes: `output` (redacted per Task 1, capped at 4 KB) and
`exit` (the numeric code where a client supplies one, `null` otherwise).

**Interfaces:**
- Produces: `kind: 'tool-outcome'` gains optional `output` and `exit`. Additive only, so no `GRAPH_VERSION` question.

**Why:** `toolSucceeded(raw)` returns a **boolean**, normalised across clients from error and status fields. A boolean cannot distinguish a compile error from a test failure from a denied permission, and the failure findings that carry the most value need the text. The exit code is opportunistic — many clients never report one.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/hooks/capture-results.test.mjs
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAll, recordToolOutcome } from '../../hooks-core/metrics.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'res-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const outcome = (extra) => recordToolOutcome(dir, {
  surface: 'command', anchor: 'npm test', toolName: 'Bash', success: false, ...extra,
});
const latest = () => readAll(dir).filter((e) => e.kind === 'tool-outcome').pop();

describe('tool-outcome carries output and exit', () => {
  it('records the output and the exit code alongside success', () => {
    outcome({ output: 'FAIL x.test.ts', exit: 1 });
    expect(latest().success).toBe(false);
    expect(latest().exit).toBe(1);
    expect(latest().output).toContain('FAIL');
  });

  it('redacts secrets out of captured output', () => {
    outcome({ output: 'API_TOKEN=abcdef123456 failed', exit: 1 });
    expect(latest().output).not.toContain('abcdef123456');
  });

  it('caps output so a huge log is never stored whole', () => {
    outcome({ output: 'x'.repeat(100000), exit: 0 });
    expect(latest().output.length).toBeLessThanOrEqual(4096);
  });

  it('leaves exit null when the client reports no code, rather than guessing 0', () => {
    outcome({ output: 'denied' });
    expect(latest().exit).toBeNull();
  });

  it('does not disturb the injection join the pipeline already performs', () => {
    outcome({ output: 'x', exit: 1 });
    expect(latest().joinMethod).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** → `event.exit` and `event.output` are `undefined`

- [ ] **Step 3: Normalise the two fields in `metrics.mjs`, and pass them from `adapter.mjs`**

In `recordToolOutcome`, normalise at the boundary so no caller can store raw text:

```javascript
  // REDACTED AND CAPPED HERE, not at the call site. A claim built from this text
  // is injected into model context AND exported to markdown, so the boundary is
  // the only place that can guarantee it.
  const output = outcome.output === undefined
    ? undefined
    : redact(String(outcome.output), { max: 4096 });
  // Null rather than 0 when nothing is reported: most clients supply no numeric
  // code, and defaulting to 0 would claim every unreported call succeeded.
  const exit = Number.isInteger(outcome.exit) ? outcome.exit : null;
```

Include both in the recorded event and import `redact` from `./redact.mjs`.

In `adapter.mjs`'s post-tool branch, add two fields to the **existing**
`recordToolOutcome` call — do not add a second call:

```javascript
        output: outputFrom(raw),
        exit: exitFrom(raw),
```

`outputFrom` and `exitFrom` belong beside `toolSucceeded` (`adapter.mjs:145`),
which is where per-client response shapes are already normalised — the same
`raw.tool_response` / `raw.toolResponse` / `raw.tool_result` / `raw.postToolUse`
family it reads today. Do not read raw fields at the call site; that is precisely
what `toolSucceeded` exists to prevent.


- [ ] **Step 4: Run to verify it passes** → PASS (3)
- [ ] **Step 5: Commit**

```bash
npm run sync:hooks
git add hooks-core/adapter.mjs hooks-core/metrics.mjs tests/hooks/capture-results.test.mjs plugin integrations
git commit -m "feat(capture): carry output and exit code on tool-outcome

Only a success boolean was recorded, which cannot distinguish a compile error
from a test failure from a denied permission.

Extends the existing tool-outcome event rather than adding a parallel kind:
that pipeline already runs (234 live events in this repo) and already joins
each outcome to its injection, so a second event describing the same thing
would have duplicated the join and given the overloaded kind field a fifth
meaning."
```

---

## Task 3: The four extractors

**Files:** Create `hooks-core/derive.mjs`; Test `tests/hooks/derive.test.mjs`

**Interfaces:**
- Consumes: `readAll` (`metrics.mjs`), `redact`, `selectForConsolidation` (`consolidate.mjs`), `writeHarvested` (`harvest-write.mjs`), `rereadWaste` (`metrics.mjs`).
- Produces: `derive(dir, { sessionId, transcriptPath, projectRoot }) => { candidates: Array, written: string[] }`
- Confidence caps, exported for the test: `CONFIDENCE = { command: 0.9, test: 0.85, correction: 0.6, churn: 0.4 }`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/hooks/derive.test.mjs
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record } from '../../hooks-core/metrics.mjs';
import { indexFile } from '../../hooks-core/staleness.mjs';
import { load } from '../../hooks-core/wiki.mjs';
import { derive, CONFIDENCE } from '../../hooks-core/derive.mjs';

let dir, file;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'der-'));
  file = join(dir, 'a.ts');
  writeFileSync(file, 'export const a = 1;');
  indexFile(dir, file, 'export const a = 1;');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('derive', () => {
  it('turns a failed-then-succeeded command into a command and a failure finding', () => {
    // VERIFIED: the event kind is 'tool-outcome' with a `success` boolean, and
    // optional `output`/`exit` added in Task 2. There is no 'result' kind.
    record(dir, { kind: 'tool-outcome', surface: 'command', anchor: 'npm run build', success: false, output: 'TS2345 error', exit: 1, at: 1 });
    record(dir, { kind: 'tool-outcome', surface: 'command', anchor: 'npm run build -- --skipLibCheck', success: true, output: 'ok', exit: 0, at: 2 });

    const { candidates } = derive(dir, { sessionId: 's', projectRoot: dir });
    const types = candidates.map((c) => c.type);
    expect(types).toContain('command');
    expect(types).toContain('failure');
  });

  it('caps confidence per detector so a heuristic cannot outrank an exit code', () => {
    expect(CONFIDENCE.command).toBeGreaterThan(CONFIDENCE.correction);
    expect(CONFIDENCE.correction).toBeGreaterThan(CONFIDENCE.churn);
  });

  it('redacts secrets out of a derived claim', () => {
    record(dir, { kind: 'tool-outcome', surface: 'command', anchor: 'deploy', success: false, output: 'API_TOKEN=abcdef123456', at: 1 });
    record(dir, { kind: 'tool-outcome', surface: 'command', anchor: 'deploy --retry', success: true, output: 'ok', at: 2 });
    const { candidates } = derive(dir, { sessionId: 's', projectRoot: dir });
    expect(JSON.stringify(candidates)).not.toContain('abcdef123456');
  });

  it('writes nothing when there is nothing to derive', () => {
    expect(derive(dir, { sessionId: 's', projectRoot: dir }).candidates).toEqual([]);
  });

  it('never throws, because it runs at session end', () => {
    record(dir, { kind: 'tool-outcome', surface: 'command', anchor: null, success: null, output: null, at: 1 });
    expect(() => derive(dir, { sessionId: 's', projectRoot: dir })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails** → module not found

- [ ] **Step 3: Implement `derive.mjs`**

```javascript
// hooks-core/derive.mjs
/**
 * Findings from data we already hold, with no model call.
 *
 * WHY THIS EXISTS. The semantic harvest is opt-in for good reasons -- it spends
 * money and sends a digest off the machine -- so a default install produced a
 * structural skeleton and no verdicts. Measured on this repository over three
 * weeks: 1,446 symbol nodes, 468 file nodes, 45 task nodes, ONE finding. The
 * product thesis is "retrieve verdicts, not evidence" and there were no verdicts.
 *
 * Everything here is derived from exit codes, test transitions, corrections and
 * churn -- all already recorded, all local. Nothing leaves the machine, so there
 * is nothing to consent to and this is on by default.
 *
 * PRECISION IS CAPPED, NOT CLAIMED. "Failed then succeeded" does not prove the
 * second command fixed the first. Each detector carries a confidence ceiling and
 * Plan 2's per-finding utility prunes what turns out not to help.
 */

import { readAll, rereadsByAnchor } from './metrics.mjs';
import { redact } from './redact.mjs';

/** Ceilings, ordered by how much the evidence actually supports. */
export const CONFIDENCE = { command: 0.9, test: 0.85, correction: 0.6, churn: 0.4 };

const TEST_COMMAND = /\b(test|jest|vitest|pytest|mocha|dotnet\s+test|go\s+test|cargo\s+test)\b/i;

/** Commands are "the same attempt" when their first two words match. */
function attemptKey(command) {
  return String(command || '').trim().split(/\s+/).slice(0, 2).join(' ').toLowerCase();
}

export function derive(dir, { sessionId, projectRoot } = {}) {
  let events;
  try {
    events = readAll(dir);
  } catch {
    return { candidates: [], written: [] };
  }

  // 'tool-outcome' with surface 'command'. The anchor holds the command text --
  // adapter.mjs sets `anchor` to the command for a command surface, which is why
  // there is no separate `command` field to read.
  const results = events
    .filter((e) => e.kind === 'tool-outcome' && e.surface === 'command' && e.anchor)
    .map((e) => ({ ...e, command: e.anchor, failed: e.success === false || (Number.isInteger(e.exit) && e.exit !== 0) }));
  const candidates = [];

  // ---- 1 & 2: a failed attempt followed by a succeeding one -------------
  // Grouped by attempt key and ordered, so `npm run build` failing and then
  // `npm run build -- --skipLibCheck` succeeding is one story rather than two
  // unrelated events.
  const byAttempt = new Map();
  for (const event of results) {
    const key = attemptKey(event.command);
    if (!byAttempt.has(key)) byAttempt.set(key, []);
    byAttempt.get(key).push(event);
  }

  for (const [, run] of byAttempt) {
    // `failed` uses the success boolean first and the exit code only as a
    // refinement, because most clients never report a numeric code.
    const failed = run.find((e) => e.failed);
    if (!failed) continue;
    const fixed = run.find((e) => !e.failed && (e.at ?? 0) > (failed.at ?? 0));
    if (!fixed) continue;

    const isTest = TEST_COMMAND.test(fixed.command);
    const cap = isTest ? CONFIDENCE.test : CONFIDENCE.command;

    candidates.push({
      type: 'command',
      claim: redact(`\`${fixed.command}\` works where \`${failed.command}\` failed`),
      confidence: cap,
      anchors: [projectRoot],
      evidence: redact(`failed${Number.isInteger(failed.exit) ? ` (exit ${failed.exit})` : ''} then succeeded`),
      derivedBy: isTest ? 'test-transition' : 'command-transition',
      at: fixed.at ?? Date.now(),
    });

    candidates.push({
      type: 'failure',
      claim: redact(`\`${failed.command}\` fails: ${String(failed.output || '').split('\n')[0]}`),
      confidence: cap,
      anchors: [projectRoot],
      evidence: redact(String(failed.output || '')),
      derivedBy: isTest ? 'test-transition' : 'command-transition',
      at: failed.at ?? Date.now(),
    });
  }

  // ---- 3: user corrections -------------------------------------------------
  // A `feedback` finding, the one type whose source is a person saying the agent
  // was wrong. Heuristic, hence the lowest cap but one.
  for (const event of events) {
    if (event.kind !== 'correction' || !event.text) continue;
    candidates.push({
      type: 'feedback',
      claim: redact(String(event.text)),
      confidence: CONFIDENCE.correction,
      anchors: event.files?.length ? event.files : [projectRoot],
      evidence: 'user correction observed in session',
      derivedBy: 'correction',
      at: event.at ?? Date.now(),
    });
  }

  // ---- 4: re-read churn ---------------------------------------------------
  // Describes our own behaviour rather than the code, so it gets the lowest cap
  // and will be starved by the injection budget's confidence ranking unless it
  // earns its place through measured utility.
  // VERIFIED: rereadWaste returns a single AGGREGATE -- { repeats, wasteful,
  // wastefulTokens, legitimate, legitimateTokens, undecidable,
  // undecidableTokens, coverage } -- with no per-anchor rows. An earlier draft
  // of this plan iterated `waste.worst`, which does not exist, so the detector
  // would have produced nothing silently inside this try/catch.
  //
  // Both consumers now share `rereadsByAnchor` (Task 3b) rather than each
  // implementing "what counts as a wasteful re-read".
  try {
    for (const row of rereadsByAnchor(events).slice(0, 3)) {
      if (!row.anchor || row.repeats < 2) continue;
      candidates.push({
        type: 'map',
        claim: `${row.anchor} is a recurring reference point in this project`,
        confidence: CONFIDENCE.churn,
        anchors: [row.anchor],
        evidence: `re-read ${row.repeats} times, ${row.wasteful} without changing`,
        derivedBy: 'churn',
        at: Date.now(),
      });
    }
  } catch {
    // A failure here costs one detector, never the session.
  }

  return { candidates, written: [] };
}
```

No verification step is needed — `rereadWaste`'s shape is recorded above, and
Task 3b supplies the per-anchor helper this detector consumes.

- [ ] **Step 4: Run to verify it passes** → PASS (5)
- [ ] **Step 5: Commit**

```bash
npm run sync:hooks
git add hooks-core/derive.mjs tests/hooks/derive.test.mjs plugin integrations
git commit -m "feat(derive): four zero-cost extractors, so a default install produces findings

This repository's own graph held 1,446 symbol nodes and ONE finding after three
weeks, because the only path to a verdict was an opt-in model call. These four
derive findings from exit codes, test transitions, corrections and churn --
locally, with no model and nothing leaving the machine."
```

---

## Task 3b: `rereadsByAnchor` — one implementation, two consumers

**Files:** Modify `hooks-core/metrics.mjs`; Test `tests/hooks/reread-waste.test.mjs`

**Interfaces:**
- Produces: `rereadsByAnchor(events) => Array<{ anchor, repeats, wasteful, tokens }>`, descending by `wasteful` then `repeats`.
- `rereadWaste` keeps **every existing field unchanged** and gains `worst: rereadsByAnchor(events).slice(0, 10)`.

**Why:** the churn detector needs per-anchor rows and `rereadWaste` returns only an aggregate. Implementing the grouping a second time inside `derive.mjs` would put two definitions of "what counts as a wasteful re-read" in the codebase, free to drift — the exact divergence `npm run sync:hooks` exists to prevent elsewhere. So the grouping moves into one shared function that both consume.

The existing aggregate fields must not change: `balanceSheet` reads them, and `worst` is purely additive.

- [ ] **Step 1: Write the failing test**

```javascript
it('groups re-reads by anchor, worst first', () => {
  const events = [
    { kind: 'read', anchor: 'a.ts', fp: 'x', tokens: 100, at: 1 },
    { kind: 'read', anchor: 'a.ts', fp: 'x', tokens: 100, at: 2 },
    { kind: 'read', anchor: 'a.ts', fp: 'x', tokens: 100, at: 3 },
    { kind: 'read', anchor: 'b.ts', fp: 'y', tokens: 50, at: 4 },
    { kind: 'read', anchor: 'b.ts', fp: 'z', tokens: 50, at: 5 },
  ];
  const rows = rereadsByAnchor(events);
  expect(rows[0].anchor).toBe('a.ts');
  // Two repeats with an unchanged fingerprint are wasteful; b.ts changed, so it is not.
  expect(rows[0].wasteful).toBe(2);
  expect(rows.find((r) => r.anchor === 'b.ts').wasteful).toBe(0);
});

it('leaves every existing rereadWaste field untouched', () => {
  const before = rereadWaste(dir, { events, includeFixtures: true });
  expect(before).toHaveProperty('repeats');
  expect(before).toHaveProperty('wastefulTokens');
  expect(before).toHaveProperty('coverage');
  expect(Array.isArray(before.worst)).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails** → `rereadsByAnchor is not a function`

- [ ] **Step 3: Extract the grouping**

Lift the per-anchor loop already inside `rereadWaste` into `rereadsByAnchor`, have `rereadWaste` call it and fold its rows into the existing counters, then append `worst`. The judgement of wasteful-versus-legitimate (`prev.fp === cur.fp`) moves with it and must not be reimplemented.

- [ ] **Step 4: Run to verify it passes** → `npx jest tests/hooks/reread-waste.test.mjs`

- [ ] **Step 5: Commit**

```bash
npm run sync:hooks
git add hooks-core/metrics.mjs tests/hooks/reread-waste.test.mjs plugin integrations
git commit -m "refactor(metrics): share re-read grouping between rereadWaste and derive

The churn detector needs per-anchor rows; rereadWaste returned only an
aggregate. One shared helper rather than two definitions of what counts as a
wasteful re-read. Existing aggregate fields are unchanged -- worst is additive."
```

---

## Task 4: Wire `selectForConsolidation`, delete `contentAnchor`

**Files:** Modify `hooks-core/derive.mjs`, `hooks-core/consolidate.mjs`, `tests/hooks/reachability.test.mjs`, `tests/hooks/consolidate.test.mjs`

**Interfaces:**
- Consumes: `selectForConsolidation(graph, candidates, { budget })`.
- Produces: `derive()` now returns `written: string[]` — the keys actually stored.

- [ ] **Step 1: Write the failing test**

```javascript
// append to tests/hooks/derive.test.mjs
it('passes candidates through budgeted selection before writing', () => {
  for (let i = 0; i < 40; i++) {
    record(dir, { kind: 'result', command: `cmd${i} a`, exit: 1, output: 'x', at: i });
    record(dir, { kind: 'result', command: `cmd${i} a --fix`, exit: 0, output: 'ok', at: i + 1000 });
  }
  const { candidates, written } = derive(dir, { sessionId: 's', projectRoot: dir });
  // Selection is under a token budget, so not everything derived is stored.
  expect(written.length).toBeGreaterThan(0);
  expect(written.length).toBeLessThan(candidates.length);
});
```

- [ ] **Step 2: Run to verify it fails** → `written` is empty

- [ ] **Step 3: Wire selection and storage into `derive()`**

```javascript
  // BUDGETED SELECTION, not everything derived. selectForConsolidation exists
  // for exactly this and had no caller: it keeps failures and decisions on a
  // floor regardless of score, which encodes the design's judgement that dead
  // ends are the highest-value kind.
  const { selectForConsolidation } = await import('./consolidate.mjs');
  const { writeHarvested } = await import('./harvest-write.mjs');
  const { load } = await import('./wiki.mjs');

  const graph = load(dir);
  const chosen = selectForConsolidation(graph, candidates, { budget: 4000 });
  const written = writeHarvested(dir, chosen, {
    sessionId,
    origin: ORIGIN_HARVESTED,
    projectRoot,
  });
  return { candidates, written };
```

`derive` becomes `async` — update its callers and the tests to `await`.

- [ ] **Step 4: Delete `contentAnchor`**

Remove `export function contentAnchor` from `hooks-core/consolidate.mjs` and its allowlist entry. Then open the follow-up issue so the idea is not lost:

```bash
gh issue create --title "Content-addressed anchors: a finding about a vendored file should appear in every repo holding it" --body "$(cat <<'EOF'
`contentAnchor` was implemented in `hooks-core/consolidate.mjs` and never wired,
then deleted in the #204 gap-closure work rather than left dormant.

The idea is worth keeping. From its docblock:

> A vendored library file is the same file in every repository that holds it,
> whatever path each gives it. Anchoring to content as well as path means a
> finding about it appears in all of them with no promotion step and no path
> mapping -- reach a per-session checkpoint cannot have even in principle.
> The PATH anchor still drives staleness within a repo; this is additive.

Deleted rather than wired because it introduces a second anchor identity, and
anchor identity is the one place in this codebase that has already caused silent
node-splitting (Windows path canonicalisation). It also interacts with
`fleet.mjs` cross-project transfer. That deserves its own design pass.

Recoverable from git history: see the deletion commit on `feat/close-wiki-graph-gaps`.
EOF
)"
```

- [ ] **Step 5: Run tests** → `npx jest tests/hooks/derive.test.mjs tests/hooks/consolidate.test.mjs tests/hooks/reachability.test.mjs` → PASS
- [ ] **Step 6: Commit**

```bash
npm run sync:hooks
git add hooks-core tests plugin integrations
git commit -m "feat(derive): budgeted selection before storage; delete contentAnchor

selectForConsolidation had no caller, so nothing bounded what entered the
graph -- risk 2 (bloat) unaddressed. contentAnchor is deleted rather than left
dormant, with the idea preserved in a follow-up issue."
```

---

## Task 5: Run `derive` at Stop, and the other three cold-graph measures

**Files:** Modify `hooks-core/adapter.mjs`, `hooks-core/standing.mjs`, `hooks-core/doctor.mjs`, `docs/WIKI_GRAPH.md`, `README.md`; Test `tests/hooks/derive.test.mjs`

- [ ] **Step 1: Call `derive` from the Stop branch of `adapter.mjs`**, alongside the existing harvest, wrapped so a failure is silent.
- [ ] **Step 2: Add the standing rule** nudging `wiki_write`, inside the existing standing budget in `standing.mjs`. Keep it to one line of guidance; the budget is 400 tokens for roughly a dozen rules.
- [ ] **Step 3: Surface the local endpoint.** In `doctor.mjs` and the SessionStart summary, when `harvestMode()` returns `'local'`, say so plainly: `local model found — semantic harvest is on, free and private`. When it returns `'off:not-opted-in'`, say what turning it on would buy and what it would send.
- [ ] **Step 4: State the default honestly** in `README.md` and `docs/WIKI_GRAPH.md`: a default install derives findings locally from exit codes, tests, corrections and churn; the model-based semantic harvest additionally requires `TOKEN_OPTIMIZER_HARVEST=1` or a local endpoint.
- [ ] **Step 5: Test the Stop path end to end**

```javascript
it('derives findings when the session ends, through the Stop path', async () => {
  record(dir, { kind: 'result', command: 'npm run build', exit: 1, output: 'TS2345' });
  record(dir, { kind: 'result', command: 'npm run build -- --fix', exit: 0, output: 'ok' });
  await runStop(dir, { sessionId: 's', projectRoot: dir });   // real Stop entry, not derive() directly
  const findings = [...load(dir).nodes.values()].filter((n) => n.kind === 'finding');
  expect(findings.length).toBeGreaterThan(0);
});
```

- [ ] **Step 6: Commit**

```bash
npm run sync:hooks
git add hooks-core docs README.md tests plugin integrations
git commit -m "feat(derive): run at Stop; surface local harvest; state the default honestly"
```

---

## Task 6: Layer 1 — explicit-reference classification

**Files:** Create `hooks-core/usage.mjs`; Test `tests/hooks/usage.test.mjs`

**VERIFIED CONTRACT — do not invent a join.** `inject` events already record
`findingIds` (the finding keys) at five call sites in `inject.mjs`, and
`recordToolOutcome` already joins each outcome back to its injection, recording
`injectionId`, `findingIds` and a `joinMethod` of `tool-call-id`,
`episode-anchor` or `none`. That join prefers an exact `tool-call-id` match,
which is strictly better evidence than the `(sessionId, findingKey)`
approximation an earlier draft of this plan proposed — and it already reports
`joinMethod: 'none'` when it cannot attribute, so unattributable observations can
be excluded honestly instead of silently mis-joined.

**So Layer 1 requires no change to `inject.mjs` at all.** It reads
`kind: 'tool-outcome'` events, uses their `findingIds`, and drops rows whose
`joinMethod` is `none`.

**Interfaces:**
- Consumes: `readAll` from `metrics.mjs`; `tool-outcome` events with `findingIds`, `injectionId`, `joinMethod`. Depends on Plan 1's `query` event for the numerator.
- Produces:
  - `classify(dir) => Array<{ findingKey, injectionId, label: 'referenced'|'not-referenced'|'unknown' }>`
  - `referenceRate(dir) => { referenced: number, denominator: number, rate: number|null, unattributable: number }`

**Why Layer 1 uses references and not read-suppression:** read-suppression is Layer 2's estimand. Using it in both would make the calibration loop compare two spellings of one quantity — a strong correlation that means nothing. `unknown` is excluded from the denominator rather than counted as a miss, and `unattributable` is reported separately rather than folded into either.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/hooks/usage.test.mjs
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record } from '../../hooks-core/metrics.mjs';
import { classify, referenceRate } from '../../hooks-core/usage.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'usage-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Layer 1', () => {
  it('labels an injection referenced when a later query names the finding', () => {
    record(dir, { kind: 'inject', anchor: 'a.ts', findingKeys: ['k1'], sessionId: 's', at: 1 });
    record(dir, { kind: 'query', operation: 'get', key: 'k1', sessionId: 's', at: 2 });
    expect(classify(dir).find((r) => r.findingKey === 'k1').label).toBe('referenced');
  });

  it('does not count a query that preceded the injection', () => {
    record(dir, { kind: 'query', operation: 'get', key: 'k1', sessionId: 's', at: 1 });
    record(dir, { kind: 'inject', anchor: 'a.ts', findingKeys: ['k1'], sessionId: 's', at: 2 });
    expect(classify(dir).find((r) => r.findingKey === 'k1').label).not.toBe('referenced');
  });

  it('excludes unknown from the denominator instead of scoring it a miss', () => {
    record(dir, { kind: 'inject', anchor: 'a.ts', findingKeys: ['k1'], sessionId: 's', at: 1 });
    record(dir, { kind: 'query', operation: 'get', key: 'k1', sessionId: 's', at: 2 });
    record(dir, { kind: 'inject', anchor: 'b.ts', findingKeys: ['k2'], sessionId: 's2', at: 3 });
    const rate = referenceRate(dir);
    expect(rate.denominator).toBeLessThan(classify(dir).length);
  });

  it('returns a null rate rather than 0 when there is no evidence', () => {
    expect(referenceRate(dir).rate).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails** → module not found
- [ ] **Step 3: Implement `usage.mjs`.** For each `tool-outcome` with `joinMethod !== 'none'`, take its `findingIds` and look for a later `query` or `expand` event naming one of them, ordered by `at`. A session with no subsequent tool activity yields `unknown`; a `joinMethod` of `none` increments `unattributable` and enters neither arm.
- [ ] **Step 4: Run to verify it passes** → PASS (4)
- [ ] **Step 5: Measure how much of the join is usable.** Run against this repository's 234 live `tool-outcome` events and report the share with `joinMethod: 'none'`. If most cannot attribute, say so in the report rather than publishing a rate computed from a handful of rows — the same discipline `sufficientData` already applies.
- [ ] **Step 6: Commit**

```bash
npm run sync:hooks
git add hooks-core/usage.mjs tests/hooks/usage.test.mjs plugin integrations
git commit -m "feat(metrics): Layer 1, explicit-reference classification

Deliberately independent of read-suppression: that is Layer 2's estimand, and
using it in both would make the calibration loop compare two spellings of one
quantity. unknown is excluded from the denominator, never counted as a miss.

Built on the injection-to-outcome join recordToolOutcome already performs --
which prefers an exact tool-call-id match and already reports when it cannot
attribute -- rather than a weaker (sessionId, findingKey) join of its own. No
change to inject.mjs was needed: it has recorded findingIds all along."
```

---

## Task 7: Layer 2 — per-finding leave-one-out

**Files:** Create `hooks-core/loo.mjs`; Modify `hooks-core/inject.mjs`; Test `tests/hooks/loo.test.mjs`

**Interfaces:**
- Produces:
  - `withheldFor(findingKeys, sessionId, graph, dir) => string|null` — which single finding to withhold, or null
  - `effects(dir) => Array<{ findingKey, served, withheld, raw, shrunk, published: boolean }>`
  - `LOO_ENABLED() => boolean` — false when `TOKEN_OPTIMIZER_LOO=off`
- Constants: `MIN_PRIOR_INJECTIONS = 4`, `MIN_SERVED = 6`, `MIN_WITHHELD = 3`, `FDR_Q = 0.10`, `EPSILON = 0.10`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/hooks/loo.test.mjs
import { describe, it, expect } from '@jest/globals';
import { withheldFor, effects, MIN_PRIOR_INJECTIONS } from '../../hooks-core/loo.mjs';

describe('Layer 2 guards', () => {
  it('never withholds a pinned or human-origin finding', () => {
    const graph = { nodes: new Map([['f1', { key: 'k1', pinned: true, origin: 'harvested' }]]) };
    expect(withheldFor(['k1'], 's', graph, null)).toBeNull();
  });

  it('withholds at most one finding per touch', () => {
    const chosen = withheldFor(['k1', 'k2', 'k3'], 's', graphWith(['k1', 'k2', 'k3']), dirWithHistory());
    expect(typeof chosen === 'string' || chosen === null).toBe(true);
  });

  it('is stable for a session, so an arm cannot flip mid-session', () => {
    const a = withheldFor(['k1', 'k2'], 'sess', graphWith(['k1', 'k2']), dirWithHistory());
    const b = withheldFor(['k1', 'k2'], 'sess', graphWith(['k1', 'k2']), dirWithHistory());
    expect(a).toBe(b);
  });

  it('does not enter a finding into the experiment before enough prior injections', () => {
    expect(MIN_PRIOR_INJECTIONS).toBeGreaterThanOrEqual(4);
  });

  it('publishes no verdict below the observation floor', () => {
    const rows = effects(dirWithFewObservations());
    expect(rows.every((r) => r.published === false)).toBe(true);
  });

  it('shrinks a low-observation effect toward the population mean', () => {
    const rows = effects(dirWithMixedObservations());
    const low = rows.find((r) => r.served + r.withheld < 10);
    expect(Math.abs(low.shrunk)).toBeLessThan(Math.abs(low.raw));
  });

  it('is disabled by the kill switch', () => {
    process.env.TOKEN_OPTIMIZER_LOO = 'off';
    expect(withheldFor(['k1'], 's', graphWith(['k1']), dirWithHistory())).toBeNull();
    delete process.env.TOKEN_OPTIMIZER_LOO;
  });
});
```

Write the `graphWith` / `dirWithHistory` / `dirWithFewObservations` / `dirWithMixedObservations` helpers at the top of the file as real fixture builders using `record()` — not mocks.

- [ ] **Step 2: Run to verify it fails** → module not found
- [ ] **Step 3: Implement `loo.mjs`**, reading downstream cost through the same `tool-outcome` join Layer 1 uses (never a fresh `(sessionId, findingKey)` join), with:
  - arm from `hash(findingKey + sessionId)`, stable for the session;
  - guards: skip `pinned` and `origin === 'human'`; require `MIN_PRIOR_INJECTIONS`; return at most one key;
  - `effects()`: per-key mean downstream read cost served vs withheld, shrunk by empirical Bayes `(n·observed + k·prior) / (n + k)` toward the population mean;
  - Benjamini–Hochberg at `FDR_Q = 0.10` deciding `published`;
  - `ε = 0.10` of injections ignore the utility ranking so a low-scored finding still accrues observations;
  - the serving-policy version recorded with each observation.
- [ ] **Step 4: Run to verify it passes** → PASS (7)
- [ ] **Step 5: Consult it from `inject.mjs`** when assembling a touch's finding set, withholding the returned key and recording `{ loo: findingKey }` on the inject event.
- [ ] **Step 6: Commit**

```bash
npm run sync:hooks
git add hooks-core/loo.mjs hooks-core/inject.mjs tests/hooks/loo.test.mjs plugin integrations
git commit -m "feat(metrics): Layer 2, per-finding causal utility by leave-one-out

Nobody in this space measures per-item value causally in production -- the
state of the art is offline eval sets. Guarded: never pinned or human-origin,
never more than one withheld per touch, four prior injections before entry,
empirical-Bayes shrinkage, BH-FDR at q=0.10, and 10% exploration so a low score
cannot become self-fulfilling."
```

---

## Task 8: Calibration, report routing, pricing, `consolidationRatio`

**Files:** Modify `hooks-core/metrics.mjs`, `src/tools/analytics/get-optimization-report.ts`; Test `tests/hooks/calibration-loop.test.mjs` **(new)**, `tests/unit/optimization-report.test.ts` **(new)**

**Interfaces:**
- Produces: `calibration(dir) => { gap: number|null, verdict: string, publishable: boolean }`; `balanceSheet()` gains `layer1`, `layer2`, `calibration`, `consolidation`.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/hooks/calibration-loop.test.mjs
it('refuses to publish Layer 1 when its label does not predict Layer 2', () => {
  const dir = dirWhereReferencedFindingsShowNoEffect();
  const result = calibration(dir);
  expect(result.publishable).toBe(false);
  expect(result.verdict).toMatch(/does not predict|uncalibrated/i);
});

it('publishes when referenced findings show a larger causal effect', () => {
  const dir = dirWhereReferencedFindingsShowEffect();
  expect(calibration(dir).publishable).toBe(true);
});
```

```typescript
// tests/unit/optimization-report.test.ts
it('shows the graph balance sheet', async () => {
  const report = await getOptimizationReport({});
  expect(report.data.graph).toBeDefined();
});

it('puts a dollar figure only on measured lines', async () => {
  const report = await getOptimizationReport({});
  expect(report.formatted).toContain('estimate');
  // The estimated-savings line must carry no currency symbol.
  const estimatedLine = report.formatted.split('\n').find((l) => /estimat/i.test(l));
  expect(estimatedLine).not.toMatch(/\$/);
});
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement `calibration()`** comparing mean Layer-2 effect for `referenced` versus `unknown` findings, returning `publishable: false` with a stated reason when the gap is not positive with enough data.
- [ ] **Step 4: Add `layer1`, `layer2`, `calibration` and `consolidation` (from `consolidationRatio`, labelled an estimate) to `balanceSheet()`.**
- [ ] **Step 5: Route `balanceSheet()` into `get-optimization-report.ts`,** replace `approxCost`'s hardcoded `$3/1M` with `pricing.mjs`, and emit currency only on measured-counterfactual lines.
- [ ] **Step 6: Consume `hasOutstandingContradiction` — the gate, not just the predicate**

Plan 1 Task 5 produces `hasOutstandingContradiction`. Without this step it would be an exported predicate that nothing calls — a fresh instance of the exact defect class this work exists to close, and the census in Plan 3 would catch it.

Wherever measured utility influences a finding's standing, consult it first:

```javascript
/**
 * Utility RANKS a finding. It must never raise its confidence.
 *
 * Layer 2 measures whether a finding suppresses reads, and a confidently WRONG
 * finding suppresses reads better than a hedged true one -- so utility alone
 * optimises directly against risk 1, "wrong findings are worse than none".
 * A finding with an outstanding contradiction is ranked on its measured utility
 * like any other, and is never promoted on the strength of it.
 */
function mayPromote(graph, key) {
  return !hasOutstandingContradiction(graph, key);
}
```

Add the test that proves the gate bites:

```javascript
it('does not promote confidence for a finding that something contradicts', () => {
  contradict(dir, { key: 'suppressor', byKey: 'rebuttal', reason: 're-derived differently' });
  const before = findingByKey(dir, 'suppressor').confidence;
  applyUtility(dir, { key: 'suppressor', effect: 5000 });   // a large measured win
  expect(findingByKey(dir, 'suppressor').confidence).toBe(before);
});
```

- [ ] **Step 7: Remove the `consolidationRatio` allowlist entry.**
- [ ] **Step 8: Run** `npm run build && npx jest tests/hooks/calibration-loop.test.mjs tests/unit/optimization-report.test.ts tests/hooks/reachability.test.mjs` → PASS
- [ ] **Step 9: Commit**

```bash
npm run sync:hooks
git add hooks-core/metrics.mjs src/tools/analytics/get-optimization-report.ts tests plugin integrations
git commit -m "feat(metrics): calibration loop, balance sheet in the report, pricing from the table

The report hardcoded \$3/1M and priced estimated savings, contradicting the
project's own rule that no unmeasured saving gets a price. Currency now appears
only on measured-counterfactual lines.

consolidationRatio is wired: cost-to-derive against cost-to-carry, labelled an
estimate, which is the most legible statement of what the graph is for."
```

---

## Task 9: Close the keep-warm loop

**Files:** Modify `hooks-core/keepwarm.mjs`, `hooks-core/adapter.mjs`, `tests/hooks/reachability.test.mjs`; Test `tests/hooks/keepwarm.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
it('lets an observed hit rate change the keep-warm decision', () => {
  const cold = mkdtempSync(join(tmpdir(), 'kw-'));
  for (let i = 0; i < 10; i++) {
    recordRefresh(cold, { tier: '5m', prefixTokens: 20000, expectedValue: 1 });
    recordRefreshOutcome(cold, { tier: '5m', prefixTokens: 20000, hit: false });
  }
  // Ten refreshes that never bought a read must not keep recommending refresh.
  expect(keepWarmDecision(cold, { tier: '5m', prefixTokens: 20000 }).refresh).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails** — the decision ignores outcomes today.
- [ ] **Step 3: Call `recordRefresh` where a refresh is issued and `recordRefreshOutcome` when the next turn arrives before expiry or does not.** The turn-arrival signal comes from the Stop/pre-tool boundary; if no signal is available for a tier, record nothing rather than guessing `hit: false`.
- [ ] **Step 4: Have `keepWarmDecision` read the observed hit rate,** falling back to expected value when observations are below a floor.
- [ ] **Step 5: Remove both allowlist entries.**
- [ ] **Step 6: Run** `npx jest tests/hooks/keepwarm.test.mjs tests/hooks/reachability.test.mjs` → PASS
- [ ] **Step 7: Commit**

```bash
npm run sync:hooks
git add hooks-core tests plugin integrations
git commit -m "feat(keepwarm): close the loop -- refreshes now learn whether they paid off

keepWarmDecision spent money on refreshes and could never check whether one
bought a read, because both recording halves had no call site."
```

---

## Task 10: The recall probe

**Files:** Create `hooks-core/recall.mjs`; Test `tests/hooks/recall.test.mjs`

**Interfaces:**
- Produces: `recallProbe(dir, { limit }) => { probed: number, retrieved: number, rate: number|null, misses: Array<{key, reason}> }`

**Why:** `WIKI_GRAPH.md` says embeddings get added "if measurement shows real recall loss". Nothing measures recall, so the no-embeddings stance is unfalsifiable. For each finding, hide it and ask whether traversal plus BM25 would surface it from its own originating context.

- [ ] **Step 1: Write the failing test**

```javascript
it('retrieves a finding from its own anchor', () => {
  // A finding anchored to a file must be reachable from that file, or traversal
  // is broken rather than merely lossy.
  expect(recallProbe(dir).rate).toBe(1);
});

it('reports a finding reachable by neither traversal nor lexical as a miss', () => {
  putNodeWithEdges(dir, { kind: 'finding', key: 'orphan', claim: 'zqx unrelated' });
  const result = recallProbe(dir);
  expect(result.misses.map((m) => m.key)).toContain('orphan');
});

it('returns a null rate rather than 1 on an empty graph', () => {
  expect(recallProbe(emptyDir).rate).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**
- [ ] **Step 3: Implement.** For each active finding: take its anchors, run `findingsFor` from each; if absent, run `lexical.rank` using the finding's own claim terms against the rest; record a hit if either surfaces it, a miss with a reason otherwise.
- [ ] **Step 4: Run to verify it passes**
- [ ] **Step 5: Report it** alongside the balance sheet, labelled as an offline probe over the current graph.
- [ ] **Step 6: Commit**

```bash
npm run sync:hooks
git add hooks-core/recall.mjs tests/hooks/recall.test.mjs plugin integrations
git commit -m "test(wiki): recall probe, making the no-embeddings stance falsifiable

The design says embeddings get added if measurement shows recall loss, and
nothing measured recall. Now it does."
```

---

## Definition of done for Plan 2

| Check | Command | Expected |
|---|---|---|
| Findings on a default install | one session, then count `kind:"finding"` in `graph.jsonl` | > 0 without `TOKEN_OPTIMIZER_HARVEST` |
| Result events recorded | `grep -c '"kind":"result"' .token-optimizer/wiki/metrics.jsonl` | > 0 |
| Layer 1 has a denominator | `referenceRate(dir).denominator` | > 0 after a session using `wiki_query` |
| Layer 2 refuses early verdicts | `effects(dir).every(r => !r.published)` on a young graph | true |
| Calibration refuses when uncalibrated | `calibration(dir).publishable` | false, with a stated reason |
| No price on an estimate | the estimated line in `get_optimization_report` | no `$` |
| Recall measured | `recallProbe(dir).rate` | a number, or null with a reason |
| Allowlist shrunk | `grep -c "^  \['" tests/hooks/reachability.test.mjs` | 4 (from 9) |

---

## Task 11: A transcript reader for failed tool results

**Added mid-plan, after Task 5 measured why the detectors produced nothing.**

Claude Code **never fires PostToolUse for a failed tool call.** Proved with a deliberately
failing command that produced no event at all, and 2,238 of 2,238 live outcomes on the
measuring machine were `success: true`. So the two highest-confidence detectors — command
failed-then-succeeded (0.90) and test/build red-to-green (0.85) — have **no input on the
primary client**, while working normally on the ten adapter clients.

This task gives them input from the one place the failures do exist: the local transcript
archive, which the correction detector already reads.

**Files:**
- Modify: `hooks-core/derive.mjs`
- Test: `tests/hooks/derive.test.mjs`

**Interfaces:**
- Produces: `failedResultsFromArchive(turns) => Array<{ command, output, at }>`, fed to the
  existing command and test detectors alongside `tool-outcome` events.

**Requirements**

- **Read-only, and reuse the archive already in use.** No new capture path, no new hook, no
  new event kind. The correction detector reads this archive; so does this.
- **The confidence ceilings do not change.** A failure observed in a transcript is the same
  evidence as one observed in an event — the ceilings encode how much the evidence supports,
  not how it arrived. Do not raise or lower them for this source.
- **Deduplicate against `tool-outcome`.** On the ten clients that *do* report failures, a
  failure may appear in both sources. The same failure must not produce two candidates, and
  the pairing must not treat the transcript copy and the event copy as a failed-then-
  succeeded pair with itself.
- **Redact.** Transcript text is not redacted upstream — `recordToolOutcome`'s boundary never
  saw it. Everything derived from it goes through `redact` before storage.
- **The refusals from Task 3 still hold.** Identical command text either side of a failure
  emits nothing, and pairing uses the nearest preceding failure. A transcript source does not
  license a weaker causal claim.
- **Bound the read.** A long session's archive is large; cap what is scanned the way the
  correction detector does, and say what the cap is.

**Two things to determine rather than assume**

1. **Does the archive actually contain failed tool results, and in what shape?** Task 5
   established the archive exists and carries 723 turns on a real session. Confirm that a
   *failed* result is present and identifiable — a tool result block with an error, a
   non-zero exit rendered as text, or a refusal — and report the shape you found. **If failed
   results are not recoverable from the archive, say so plainly and stop**: that would mean
   this task cannot work, and reporting it is worth more than an extractor that finds nothing.
2. **How is a command identified?** `tool-outcome` puts the command text in `anchor`. A
   transcript turn may render it differently. The `attemptKey` grouping (up to three non-flag
   tokens) must produce the same key from both sources, or a failure from the transcript will
   never pair with a success from an event.

**Verification — the deliverable is a measurement, not a claim.** After wiring, run a real
transcript through the Stop path and report how many command and test candidates it yields,
against the zero it yields today. If the answer is still zero, that is the finding.

**Mutation bar as elsewhere**, plus the harness defect Task 5 recorded: mutating `hooks-core/`
without `npm run sync:hooks` leaves spawn-based E2E tests running the old synced copy, so a
mutation reads as survived when it was never applied. Sync between mutation and test.

---

## Task 12: `attemptKey` groups unrelated commands together

**Added mid-plan. This is a correctness bug, not an unlock.**

`attemptKey` groups by up to three non-flag tokens. A leading `cd <repo> &&` therefore
consumes the whole key, and Task 11 measured the consequence in this repository: **539
distinct commands share one key.**

That is not only a Claude Code problem. On the ten clients where the detectors *do* receive
failures, the command detector can pair a failure with a success from a completely unrelated
command and emit a claim at **0.90** — the highest confidence any detector is permitted. The
claim would be false about both halves.

**Files:** Modify `hooks-core/derive.mjs`; Test `tests/hooks/derive.test.mjs`

**Requirements**

- Skip a leading directory-change prefix before computing the key — `cd <path> &&`, and any
  similar shell preamble that carries no information about *what* was run. Report which
  prefixes you chose to skip and why that set and no wider.
- **The two existing refusals must survive.** Identical command text either side of a failure
  still emits nothing, and pairing still uses the nearest preceding failure. A better key must
  not become a licence to pair more loosely.
- **Keys must still agree across sources.** Task 11 established that the transcript reader and
  `recordToolOutcome` agree on 266/266 attempt keys only because both apply the same 120-char
  truncation. Whatever you change must be applied identically on both paths, and verified on a
  real session rather than a fixture.

**Measure it, do not assert it.** This changes grouping for all eleven clients, which is the
kind of shared-behaviour change that has twice needed its own per-client evidence on these
plans. Report, from real transcripts:

- the number of distinct commands sharing the most-populated key, before and after
- how many command/test candidates are produced, before and after
- whether any candidate produced after the change pairs two commands that a reader would
  agree are the same attempt — inspect them, do not just count them

A larger candidate count is **not** success on its own. The question is whether the pairs are
true. If the change produces pairs that are still wrong, say so.

**Mutation bar as elsewhere**, plus: sync `hooks-core/` between mutation and test, or
spawn-based tests run the old copy and a mutation reads as survived.

---

# Execution state and corrections

**Read this before starting or resuming. It is authoritative over the task text above,
which was written before Plan 1 was executed and is wrong in the places named here.**

Plan 1 shipped as **PR #315** (36 commits). Plan 2 runs on `feat/close-wiki-graph-gaps-plan2`,
stacked on Plan 1 because it imports `hooks-core/lexical.mjs`, `hooks-core/pending.mjs` and the
injection join — it cannot compile against `master` until #315 merges.

## Where execution stopped

| Task | State |
|---|---|
| 1 — Redaction | **Complete.** `hooks-core/redact.mjs`, 10 tests. |
| 2 — Extend `tool-outcome` | **Complete through fix round 2.** `output` + `exit` on the event, `isError` read by `toolSucceeded` and `mutationSucceeded`. |
| 3b — `rereadsByAnchor` | Not started. **Run before Task 3** (see ruling). |
| 3 — The four extractors | Not started. Depends on 2 and 3b. |
| 4 | **Complete.** `derive` routes candidates through `selectForConsolidation` (budget 1000 tokens, `TOKEN_OPTIMIZER_DERIVE_BUDGET`) into `writeHarvested` as `ORIGIN_HARVESTED`. `contentAnchor` deleted (issue #319); allowlist 7 -> 5. Three defects fixed on the way: the scorer read `entry.summary` where every other layer writes `claim`, so the budget admitted everything; candidates anchored to the project ROOT, which `indexFile` cannot read, so storage would have been zero; and `derive`'s own evidence boilerplate said "flaky", which `irrecoverability` scores in its top tier. `derive` stays SYNC -- no import cycle, so the brief's async rewrite was unnecessary. See `task-4-report.md`. |
| 5 | Not started. |
| 6 — Layer 1 | Not started. |
| 7 — Layer 2 | Not started. The heaviest task in the plan. |
| 8 | Not started. Depends on 6 and 7. |
| 9, 10 | Not started. |
| 11 -- transcript reader | **Complete.** `failedResultsFromTranscript` in
`hooks-core/transcript.mjs`, read-only, tail-bounded, redacted at the boundary. Yield on
this machine is **0** and that is measured, not shrugged at: 8 of 571 command failures
across 163 transcripts are quotable. Two refusals shipped with it -- `quotable` and
`hasAttemptIdentity`. See `task-11-report.md`. |
| 12 -- `attemptKey` | **Complete.** `commandBody` skips a leading `cd <path>` up to `&&`,
`;` or a newline, applied inside `attemptKey` so both sources get it identically. The
most-populated key fell from **547 distinct commands to 76**; the false-pair exposure a real
quotable failure sat in fell from **222 to 0**. Candidates 0 -> 0, because the binding
constraint is `quotable`, not the key. The identical-text refusal was WIDENED to compare
`commandBody` both sides, or the better key would have claimed `npm test` succeeded where
`cd repo && npm test` failed. Environment assignments, `time`, `bash -c` and `||` are
deliberately NOT stripped, each for a measured reason. See `task-12-report.md`. |

## Corrections to the task text above

1. **The harvest is OPT-OUT, not opt-in.** `harvestMode()` in `hooks-core/harvest.mjs` was
   flipped by #296. `TOKEN_OPTIMIZER_HARVEST` now turns it *off*; the real default gate is
   credential availability (`off:no-key`). So this plan's framing of `derive.mjs` as
   necessary "because the harvest is opt-in" is wrong. The correct framing: **`derive.mjs`
   needs no credential and sends nothing off the machine**, so it is the only finding
   producer on a machine without an API key — CI, corporate machines, subscription-only
   auth. Evidence it still matters: after Plan 1 this repository's own graph held 2,965
   symbol / 904 file / 128 task nodes and **one** finding, because this machine has no key.

2. **`exit` and `output` now exist on `tool-outcome`** (Task 2). They did not when this plan
   was written. `output` is captured **only on failure**, gated on `outcome.success !== true`
   so an unclassified outcome keeps its text; it is redacted and capped at 4 KB at the
   boundary inside `recordToolOutcome`. `exit` is `null` unless the client reports an integer.
   MCP tools return no exit code, so `exitFrom` returns null for them by design.

3. **`derive.mjs` must pass an authoritative `taskId`.** The `answers` edge fires nowhere on a
   default install because its only producer is credential-gated. `derive.mjs` runs in the
   Stop hook where a real session id exists, so it is the producer that finally makes
   `answers` live by default. `taskForAnchors` **requires** an authoritative id and returns
   null without one — an unverified string will not work.

4. **Task 3's churn detector consumes `rereadsByAnchor`** (Task 3b), not `rereadWaste().worst`,
   which does not exist.

5. **Task 2 extends the existing `tool-outcome` event** rather than adding a `kind:'result'`.

## Plan 1 surfaces this plan will collide with

Plan 1 modified every file Plan 2 touches. Read before editing:

- **`hooks-core/staleness.mjs`** — `serve()` emits three disclosures (staleness, dispute,
  derivation), clears stale flags automatically, and **writes to the graph** on a verified
  match (`reindexVerifiedAnchors`). `claimTimeVerdict` is the single shared evidence test;
  do not duplicate it.
- **`hooks-core/inject.mjs`** — `withPendingApplied` drains at four entry points; `disputeNote`
  and `derivationNote` render into the head; `sessionContext` orders blocks via `cacheOrdered`.
  Layer 2 must decide what to withhold *inside* this machinery.
- **`hooks-core/metrics.mjs`** — `recordToolOutcome` already joins each outcome to its
  injection with `injectionId` / `findingIds` / `joinMethod` (preferring an exact
  tool-call-id match). **Layers 1 and 2 build on that join; do not invent another.**
  Also gained `evidenceTruncated`.
- **`hooks-core/decide.mjs`** — `normalizeTool` resolves MCP-prefixed names, so this project's
  own tools now reach the post-tool path; `isReplacementTool` gates the loop hazard;
  `readCostBytes` returns 0 for a replacement.
- **New modules:** `hooks-core/pending.mjs`, `hooks-core/lexical.mjs`, `hooks-core/redact.mjs`.

## Rulings that bind future tasks

- **Run Task 3b before Task 3.** Task 3's churn detector consumes what 3b creates, so the
  plan's numbering would have Task 3 importing something that does not exist. *Cost if wrong:
  none; only the execution order changes.*
- **If Task 9 finds no turn-arrival signal, record observations without letting them change
  the keep-warm decision, and say so.** Do not invent a signal. *Cost if wrong: keep-warm
  still decides on expected value, with the data visible for a later fix.*
- **Every task brief restates the corrections above rather than assuming they were read.**
  Fresh agents per task cannot know them, and Plan 1 lost a round to exactly this. *Cost if
  wrong: a few extra lines per dispatch.*
- **Capture `output` only on failure** (overrides the Task 2 text). A successful `smart_read`
  would otherwise deposit up to 4 KB of file content into the evidence log on every call —
  megabytes per session, and a privacy surface, for a consumer that does not exist. *Cost if
  wrong: a future detector wanting success output must re-add it.*
- **`outputFrom` deliberately still runs on successful calls** with its result discarded by
  the boundary gate. One gate at the boundary beats a defensive second one that can drift.

## The measurement-bias class — check every task against it

Three defects of one shape were found across these plans, and all three would have inflated
this project's own numbers **in its own favour**:

- `readCostBytes` would have charged the A/B holdout a whole file for a call returning a diff.
- `toolSucceeded` ignored MCP `isError`, so every failed `smart_edit` recorded as a success.
- `mutationSucceeded` did the same, inflating edit counts and harvest pressure on six clients.

None was the kind of defect a test suite notices: the code works and the *number* lies. Tasks
6, 7 and 8 are entirely measurement, so this is the class to hunt there.

**A fourth instance is known and unfixed**, found while closing the third: `mutationSucceeded`'s
status read omits the `postToolUse` envelope, so `postToolUse: { status: 'error' }` falls through
to the allowlist and counts as a success. It changes no verdict today — which is why it was not
folded into Task 2 rather than widening a shared classifier silently — but it is the same class
one envelope out, and it wants its own change with its own per-client comparison.

## The verification bar established on Plan 1

Every task on Plan 1 produced at least one test that passed for the wrong reason, and **every
one was found by mutating rather than reading**. So for each test: mutate what it targets,
confirm that test *and only that test* fails, restore, and record the matrix. Also confirm no
pre-existing kill set *shrank* — adding tests to an existing mechanism can silently stop an
older one discriminating.

A shared-classification change needs a **per-client verdict comparison**, not an assertion
that nothing changed. Task 2 set the standard: 1,088 verdicts across 16 clients, with every
change accounted for.
