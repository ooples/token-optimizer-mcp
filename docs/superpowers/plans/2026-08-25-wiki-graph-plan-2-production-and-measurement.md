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

## Task 2: Capture exit codes and output at post-tool

**Files:** Modify `hooks-core/adapter.mjs`; Test `tests/hooks/capture-results.test.mjs` **(new)**

**Interfaces:**
- Produces: a `kind: 'result'` event per observed command: `{ kind: 'result', command, exit, output, at, sessionId }` where `output` is redacted and capped at 4 KB.

**Why:** `WIKI_GRAPH.md` and #204 both list "commands run and their exit codes, tests and their results" as free structural harvest. Nothing records them — `buildDigest` takes command text from `tool_use` and deliberately skips `tool_result`. The extractors in Task 3 have no data source until this exists.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/hooks/capture-results.test.mjs
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAll } from '../../hooks-core/metrics.mjs';
import { recordResult } from '../../hooks-core/adapter.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'res-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('result capture', () => {
  it('records the command, its exit code and its output', () => {
    recordResult(dir, { command: 'npm test', exit: 1, output: 'FAIL x.test.ts', sessionId: 's' });
    const [event] = readAll(dir).filter((e) => e.kind === 'result');
    expect(event.exit).toBe(1);
    expect(event.command).toBe('npm test');
    expect(event.output).toContain('FAIL');
  });

  it('redacts secrets out of captured output', () => {
    recordResult(dir, { command: 'deploy', exit: 1, output: 'API_TOKEN=abcdef123456 failed' });
    const [event] = readAll(dir).filter((e) => e.kind === 'result');
    expect(event.output).not.toContain('abcdef123456');
  });

  it('caps output so a huge log is never stored whole', () => {
    recordResult(dir, { command: 'build', exit: 0, output: 'x'.repeat(100_000) });
    const [event] = readAll(dir).filter((e) => e.kind === 'result');
    expect(event.output.length).toBeLessThanOrEqual(4096);
  });
});
```

- [ ] **Step 2: Run to verify it fails** → `recordResult is not a function`

- [ ] **Step 3: Implement `recordResult` in `adapter.mjs` and call it from the post-tool branch**

```javascript
/**
 * Records one observed command result.
 *
 * The structural layer promised "commands run and their exit codes, tests and
 * their results" and recorded none of them: buildDigest reads command TEXT from
 * tool_use and deliberately skips tool_result. derive.mjs cannot detect a
 * failed-then-succeeded pair without this.
 *
 * Capped at 4 KB and redacted at the boundary, so a 10 MB test log never lands
 * in the log and a secret in stderr never becomes a stored claim.
 */
export function recordResult(dir, { command, exit, output, sessionId } = {}) {
  try {
    record(dir, {
      kind: 'result',
      command: String(command ?? '').slice(0, 400),
      exit: Number.isInteger(exit) ? exit : null,
      output: redact(String(output ?? ''), { max: 4096 }),
      sessionId: sessionId ?? null,
    });
  } catch {
    /* bookkeeping must never break a completed call */
  }
}
```

Import `redact` from `./redact.mjs` and call `recordResult` in the `event === 'post-tool'` branch, reading exit code and output from the client's post-tool payload. **Client payload shapes differ** — `adapter.mjs:332` already normalises `raw.postToolUse`; extend that normaliser rather than reading raw fields at the call site.

- [ ] **Step 4: Run to verify it passes** → PASS (3)
- [ ] **Step 5: Commit**

```bash
npm run sync:hooks
git add hooks-core/adapter.mjs tests/hooks/capture-results.test.mjs plugin integrations
git commit -m "feat(capture): record command exit codes and output, promised since P1

WIKI_GRAPH.md lists exit codes and test results as free structural harvest.
Nothing recorded them, so the extractors had no data source."
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
    record(dir, { kind: 'result', command: 'npm run build', exit: 1, output: 'TS2345 error' });
    record(dir, { kind: 'result', command: 'npm run build -- --skipLibCheck', exit: 0, output: 'ok' });

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
    record(dir, { kind: 'result', command: 'deploy', exit: 1, output: 'API_TOKEN=abcdef123456' });
    record(dir, { kind: 'result', command: 'deploy --retry', exit: 0, output: 'ok' });
    const { candidates } = derive(dir, { sessionId: 's', projectRoot: dir });
    expect(JSON.stringify(candidates)).not.toContain('abcdef123456');
  });

  it('writes nothing when there is nothing to derive', () => {
    expect(derive(dir, { sessionId: 's', projectRoot: dir }).candidates).toEqual([]);
  });

  it('never throws, because it runs at session end', () => {
    record(dir, { kind: 'result', command: null, exit: null, output: null });
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

import { readAll, rereadWaste } from './metrics.mjs';
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

  const results = events.filter((e) => e.kind === 'result' && e.command);
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
    const failed = run.find((e) => Number.isInteger(e.exit) && e.exit !== 0);
    if (!failed) continue;
    const fixed = run.find((e) => e.exit === 0 && (e.at ?? 0) > (failed.at ?? 0));
    if (!fixed) continue;

    const isTest = TEST_COMMAND.test(fixed.command);
    const cap = isTest ? CONFIDENCE.test : CONFIDENCE.command;

    candidates.push({
      type: 'command',
      claim: redact(`\`${fixed.command}\` works where \`${failed.command}\` failed`),
      confidence: cap,
      anchors: [projectRoot],
      evidence: redact(`exit ${failed.exit} then exit 0`),
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
  try {
    const waste = rereadWaste(dir, { events });
    for (const row of waste?.worst?.slice(0, 3) ?? []) {
      candidates.push({
        type: 'map',
        claim: `${row.anchor} is a recurring reference point in this project`,
        confidence: CONFIDENCE.churn,
        anchors: [row.anchor],
        evidence: `re-read ${row.rereads ?? 0} times`,
        derivedBy: 'churn',
        at: Date.now(),
      });
    }
  } catch {
    // rereadWaste has its own log window; a failure here costs one detector.
  }

  return { candidates, written: [] };
}
```

Verify `rereadWaste`'s real return shape before relying on `worst`:

```bash
sed -n '451,505p' hooks-core/metrics.mjs
```

Adjust the churn detector to the real shape rather than changing `rereadWaste`.

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

**Interfaces:**
- Consumes: `readAll`, `readBalance` from `metrics.mjs`. Depends on Plan 1's `query` event.
- Produces:
  - `classify(dir) => Array<{ findingKey, sessionId, label: 'referenced'|'not-referenced'|'unknown' }>`
  - `referenceRate(dir) => { referenced: number, denominator: number, rate: number|null }`

**Why Layer 1 uses references and not read-suppression:** read-suppression is Layer 2's estimand. Using it in both would make the calibration loop compare two spellings of one quantity — a strong correlation that means nothing. `unknown` is excluded from the denominator rather than counted as a miss.

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
- [ ] **Step 3: Implement `usage.mjs`.** Join `inject` events to later `query`/`expand` events on `(sessionId, findingKey)` with `at` ordering. A session with no subsequent tool activity yields `unknown`.
- [ ] **Step 4: Run to verify it passes** → PASS (4)
- [ ] **Step 5: Ensure `inject` records `findingKeys`.** If it does not, add it in `inject.mjs` — Layer 1 cannot attribute without it.
- [ ] **Step 6: Commit**

```bash
npm run sync:hooks
git add hooks-core/usage.mjs hooks-core/inject.mjs tests/hooks/usage.test.mjs plugin integrations
git commit -m "feat(metrics): Layer 1, explicit-reference classification

Deliberately independent of read-suppression: that is Layer 2's estimand, and
using it in both would make the calibration loop compare two spellings of one
quantity. unknown is excluded from the denominator, never counted as a miss."
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
- [ ] **Step 3: Implement `loo.mjs`** with:
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
