# Benchmark Harness M2 → M3 → M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the benchmark harness into this repo, measure the `assist` posture that M0 just built, and only then ship it as the default — replacing a default measured at 1.687× vanilla Claude Code.

**Architecture:** The harness migrates from an unversioned sibling directory (`../thol-rig`) into `bench/`, keeping its Docker isolation and gaining npm entry points. New benchmark arms measure `assist` and an empty graph. The default flip is a one-line change in `hooks-core/policy.mjs` that ships **last**, gated on the number M3 produces.

**Tech Stack:** Node 22 ESM (`hooks-core/*.mjs`, no build step), Jest with `--experimental-vm-modules`, Docker (`node:22-bookworm`), Python 3 stdlib (THOL's harness), SQLite.

**Spec:** `docs/superpowers/specs/2026-08-29-benchmark-harness-and-competitive-program-design.md`

## Why the order changed

An earlier version of this plan opened by flipping the default to `off` as a one-line "interim safety measure". That was wrong twice over, and both corrections are load-bearing:

- **`off` is a kill switch.** `hooks-core/adapter.mjs` runs `if (mode() === MODE_OFF) process.exit(0);` before any event handling, so it disables the graph, injection and harvest too. Flipping the default to it turned 90 tests across 20 suites red — in harvest and injection suites, not refusal suites.
- **0.904 is that kill switch's number**, not "our product without enforcement". The posture worth shipping had to be built first.

**M0 is done** — `assist` (refusals off, graph on) landed in PR #352, deliberately *without* changing the default. This plan measures it, then ships it.

## Global Constraints

- Node >= 22. `hooks-core/` and `plugin/` are plain ESM executed with no build step.
- **`hooks-core/` is the source of truth.** Never edit `plugin/hooks/lib/*` or `integrations/*/hooks/lib/*` directly. Edit `hooks-core/<file>.mjs`, then run `node scripts/sync-hook-core.mjs`. `tests/hooks/clients.test.mjs` fails on drift.
- Never use the null-forgiving operator (`!`). Never use `string` where a closed set of values belongs in an enum.
- Feature branches only; never commit to `master`.
- Run tests with `node --experimental-vm-modules node_modules/jest/bin/jest.js <path>`.
- Commit subjects must be entirely lower-case: `subject-case` rejects capitalized identifiers such as `Write` or `MCP`. Paraphrase them.
- `bench/` must stay out of the npm `files` list so users never download it.
- Docker on Windows: prefix `docker run` with `MSYS_NO_PATHCONV=1`, and use the named volume `thol-results` — **never** a Windows bind mount for `/results`, which cannot delete deep trees.

---

### Task 1: Move the harness into `bench/` (M2)

**Files:**
- Create: `bench/README.md`, `bench/thol/Dockerfile`, `bench/thol/entrypoint.sh`, `bench/thol/run-campaign.sh`, `bench/thol/manifests/{token-optimizer-mcp,token-optimizer-mcp-off}/manifest.json`, `bench/.gitignore`
- Modify: `package.json` (`scripts`; verify `files` excludes `bench`)
- Source: `../thol-rig/`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `npm run bench:build`, `npm run bench:screen`, `npm run bench:confirm`; a `thol-results` Docker volume holding `results.sqlite`.

- [ ] **Step 1: Copy the working rig in**

```bash
mkdir -p bench/thol/manifests
cp ../thol-rig/Dockerfile bench/thol/Dockerfile
cp ../thol-rig/scripts/entrypoint.sh bench/thol/entrypoint.sh
cp ../thol-rig/scripts/run-campaign.sh bench/thol/run-campaign.sh
cp -r ../thol-rig/manifests/token-optimizer-mcp bench/thol/manifests/
cp -r ../thol-rig/manifests/token-optimizer-mcp-off bench/thol/manifests/
# results/ itself is NOT ignored: Task 3 commits a report there, and a number
# nobody can trace to the versions that produced it is not evidence. Only the
# large machine-written run data is excluded.
printf 'auth/\nthol/pkg/\nresults/runs/\n*.sqlite\n' > bench/.gitignore
```

- [ ] **Step 2: Fix the paths the copy broke**

In `bench/thol/Dockerfile`, replace the two `COPY` lines (which assumed the rig's layout) with:

```dockerfile
COPY --chown=bench:bench thol/entrypoint.sh /home/bench/scripts/entrypoint.sh
COPY --chown=bench:bench thol/manifests/ /home/bench/manifests/
```

The build context becomes `bench/`, so builds run as `docker build -f bench/thol/Dockerfile bench/`.

`bench/thol/run-campaign.sh` resolves `RIG_DIR` one level up from the script, which now yields `bench/` — so `$RIG_DIR/auth` is `bench/auth`, matching `bench/.gitignore`. No change needed; verify it rather than assume.

- [ ] **Step 3: Add the npm entry points**

In `package.json` `scripts`:

```json
    "bench:build": "docker build -f bench/thol/Dockerfile -t thol-rig:local bench/",
    "bench:screen": "bash bench/thol/run-campaign.sh",
    "bench:confirm": "REPS=3 bash bench/thol/run-campaign.sh"
```

Then confirm the `files` array does **not** contain `bench` — it lists entries explicitly, so `bench/` is excluded by omission. Verify, do not assume.

- [ ] **Step 4: Write `bench/README.md`**

```markdown
# bench/

The harness that grades this project, beside the code it grades, so a behaviour
change and its measured effect land in the same commit.

## Run it

    npm run bench:build
    REPS=1 SEGMENTS_MAX=4 npm run bench:screen    # ~48 runs, ~$13, ~1h
    npm run bench:confirm                          # --reps 3, for published claims

Authentication stages a trimmed copy of your Claude Code credentials (the
`claudeAiOauth` key only) into `bench/auth/`, which is gitignored. Credentials
are re-staged between segments because THOL gives every run a throwaway HOME,
so a token refresh inside a sandbox dies with it.

## What the numbers mean

Cost ratio is a task's cost divided by the same task's cost on the `control` arm
of the same campaign. Ratios are comparable across campaigns; absolute dollars
are not, because campaigns pin different Claude Code versions.

`score` is the verifier's 0-1 correctness. **A cost figure without its paired
score is not a result** — a compressor that eats the answer looks excellent on
cost alone.

## What it does not measure

Every run gets a throwaway HOME and a fresh workspace, so the knowledge graph
starts empty and a finding harvested at Stop cannot help the session that
produced it. Single-shot ratios are the graph's worst case, not a measurement of
it.
```

- [ ] **Step 5: Verify the migrated harness passes its own gate**

```bash
npm run bench:build
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd)/bench/auth:/auth:ro" -v thol-results:/results thol-rig:local selftest
```
Expected: `selftest PASSED` with all 17 verifiers `ok`, then a competitor list including `token-optimizer-mcp` and `token-optimizer-mcp-off` **without** the `[unverified manifest]` suffix.

- [ ] **Step 6: Commit**

```bash
git add bench package.json
git commit -m "test(bench): move the benchmark harness into the repo

It graded this project from an unversioned sibling directory that git never saw.
In bench/ it is versioned with the code it grades, so a rule change and its
measured effect can land in one commit."
```

---

### Task 2: Add the `assist` and graph-disabled arms (M3 setup)

**Files:**
- Create: `bench/thol/manifests/token-optimizer-mcp-assist/manifest.json`, `bench/thol/manifests/token-optimizer-mcp-nograph/manifest.json`
- Modify: `bench/thol/run-campaign.sh` (`ARMS` default)

**Interfaces:**
- Consumes: Task 1's manifest directory and orchestrator.
- Produces: arms `token-optimizer-mcp-assist` and `token-optimizer-mcp-nograph`.

**Prerequisites, both landed.** This task declares `TOKEN_OPTIMIZER_MODE=assist`
and `TOKEN_OPTIMIZER_WIKI_DISABLED=1`, neither of which existed when this plan
was first written — `mode()` mapped `assist` to `enforce`, so the arm would have
silently measured the enforcing build and produced two identical arms. Both now
exist: `assist` in PR #352, the graph switch in PR #355.

**They do not have to be merged first — but they must be IN THE TREE you build
from.** Those are different requirements, and the difference matters: merge
status is a proxy for behaviour, and the harness now checks the behaviour
directly. Build from any tree that contains both (a local integration branch is
fine), and:

- `bench:pack` records that tree's **git tree hash**, which is folded into the
  campaign label and stored on every run row — so the result is attributable to
  exact content regardless of branch or merge state, and a dirty tree is flagged
  rather than silently attributed to a commit that does not contain it;
- the preflight **exercises each arm's declared configuration** against the
  packaged build — the mode must round-trip, and a declared graph switch must
  leave the writers inert.

An arm whose capability is missing fails loudly before any spend, naming what it
would otherwise have measured. Waiting for a merge would not have caught a
capability that merged but did not work.

Task 1's preflight enforces the mode half of that ordering: the campaign refuses
to start when an arm declares a mode the packed build does not recognise, naming
the arm and what it would actually have measured. Step 3 below covers the graph
half, which the preflight cannot see.

- [ ] **Step 1: Derive both manifests programmatically**

Each arm must differ from its base in exactly one variable, or it measures something else. Derive rather than hand-copy:

```bash
node -e "
const fs=require('fs');
const base=JSON.parse(fs.readFileSync('bench/thol/manifests/token-optimizer-mcp/manifest.json','utf8'));

const assist=JSON.parse(JSON.stringify(base));
assist.name='token-optimizer-mcp-assist';
assist.display_name='Token Optimizer MCP (assist)';
assist.install_doc='THE CANDIDATE DEFAULT. Identical to token-optimizer-mcp except TOKEN_OPTIMIZER_MODE=assist, which disables refusals while leaving the MCP server, the knowledge graph, SessionStart injection and Stop harvest running. This is the posture the default flip would ship; the off arm is NOT a proxy for it, because off exits the hook process.';
assist.settings.env.TOKEN_OPTIMIZER_MODE='assist';
assist.mcp.mcpServers['token-optimizer'].env.TOKEN_OPTIMIZER_MODE='assist';
fs.mkdirSync('bench/thol/manifests/token-optimizer-mcp-assist',{recursive:true});
fs.writeFileSync('bench/thol/manifests/token-optimizer-mcp-assist/manifest.json',JSON.stringify(assist,null,2)+'\n');

const nograph=JSON.parse(JSON.stringify(assist));
nograph.name='token-optimizer-mcp-nograph';
nograph.display_name='Token Optimizer MCP (assist, no graph)';
nograph.install_doc='ISOLATES THE GRAPH AGAINST THE ASSIST ARM. Identical to token-optimizer-mcp-assist except the graph is disabled. Because every THOL run gets a throwaway HOME the graph is empty and can deliver nothing, so the difference between these two arms is the graph OVERHEAD alone -- the only part of it a single-shot benchmark can see.';
fs.mkdirSync('bench/thol/manifests/token-optimizer-mcp-nograph',{recursive:true});
fs.writeFileSync('bench/thol/manifests/token-optimizer-mcp-nograph/manifest.json',JSON.stringify(nograph,null,2)+'\n');
console.log('written');
"
```

- [ ] **Step 2: Prove the assist arm differs in exactly one variable**

```bash
diff <(node -e "const m=require('./bench/thol/manifests/token-optimizer-mcp/manifest.json');delete m.install_doc;delete m.name;delete m.display_name;console.log(JSON.stringify(m,null,2))") \
     <(node -e "const m=require('./bench/thol/manifests/token-optimizer-mcp-assist/manifest.json');delete m.install_doc;delete m.name;delete m.display_name;console.log(JSON.stringify(m,null,2))")
```
Expected: exactly two hunks, each changing only `TOKEN_OPTIMIZER_MODE`. Anything else invalidates the arm — fix it before spending money.

- [ ] **Step 3: Confirm the disable switch behaves as the arm claims**

`TOKEN_OPTIMIZER_WIKI_DISABLED` now exists (PR #355) and gates `load`, `putNode`
and `putEdge` in `hooks-core/wiki.mjs`. Confirm its **behaviour**, not merely
that an export is present — a module-scope read or a private helper would not
appear in the export list, and an export that exists but does not gate the
writers would leave the arm quietly harvesting:

```bash
node --input-type=module -e "
import { mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dir = mkdtempSync(join(tmpdir(), 'nograph-probe-'));
process.env.TOKEN_OPTIMIZER_WIKI_DISABLED = '1';
const w = await import('./hooks-core/wiki.mjs');
w.putNode(dir, { kind: 'file', key: '/tmp/a.ts', hash: 'x', bytes: 1 });
w.putEdge(dir, 'a', 'related', 'b');
const wrote = readdirSync(dir);
console.log('files written while disabled:', wrote.length, wrote);
console.log(wrote.length === 0 ? 'OK: inert' : 'BROKEN: still writing');
"
```

Expected: `OK: inert`. Anything else means the arm would measure a graph that is
still running, so stop and fix the gate before spending on a campaign.

If that prints an empty array, **stop and add the switch** in `hooks-core/wiki.mjs` as its own committed change with a unit test, then return here. Do **not** approximate it by pointing `TOKEN_OPTIMIZER_WIKI_DIR` at an empty directory: that disables delivery but leaves harvest writing, so the arm would measure something other than what its `install_doc` claims.

Once the switch exists, set it in both env blocks of the nograph manifest and re-run the Step 2 diff against the assist arm.

- [ ] **Step 4: Add both arms to the default set**

```bash
ARMS="${ARMS:-control,token-optimizer-mcp,token-optimizer-mcp-assist,token-optimizer-mcp-off,token-optimizer-mcp-nograph}"
```

- [ ] **Step 5: Commit**

```bash
git add bench/thol
git commit -m "test(bench): add assist and graph-disabled arms

assist is the posture the default flip would ship, and the off arm is not a
proxy for it: off exits the hook process, so it measures the product with the
graph switched off. The nograph arm isolates what an empty graph costs."
```

---

### Task 3: Measure (M3)

**Files:**
- Create: `bench/results/2026-08-29-confirmation.md`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: the number Task 4 ships on, plus confidence intervals for the spec's §2.

- [ ] **Step 1: Run the confirmation campaign**

Five arms × 16 tasks × 3 reps = 240 runs, roughly $70 and several hours. Segmented so it survives credential expiry:

```bash
REPS=3 SEGMENTS_MAX=4 npm run bench:screen
```

- [ ] **Step 2: Extract the per-arm aggregates**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v thol-results:/results --entrypoint /bin/bash thol-rig:local -c \
'sqlite3 -column -header /results/results.sqlite "
select competitor, count(*) n, round(avg(total_cost_usd),4) mean_cost,
       round(avg(num_turns),1) turns, sum(competitor_tool_calls) own,
       sum(tool_calls) all_calls, round(avg(score),3) score
from runs where status=\"ok\" group by competitor;"'
```

- [ ] **Step 3: Record the result**

Write `bench/results/2026-08-29-confirmation.md` with: each arm's mean cost, turns, own/all tool calls and score; the per-task ratio table; the pinned Claude Code and product versions; and explicit answers to three questions —

1. Does `assist` beat `control`? (If not, Task 4 must not ship it.)
2. Where does `assist` sit relative to `off` (0.904) and `enforce` (1.687)?
3. What does the empty graph cost, from `assist` minus `nograph`?

**If `assist` does not beat control, that is the result.** Record it and stop; do not re-run until the numbers agree.

- [ ] **Step 4: Commit**

```bash
git add bench/results
git commit -m "test(bench): confirmation campaign at --reps 3

Gives the candidate default a measured number, which the off arm's 0.904 was
never a substitute for, and isolates the empty graph's overhead."
```

---

### Task 4: Ship `assist` as the default (M1)

**Do not start this task until Task 3 Step 3 shows `assist` beating `control`.**

**Files:**
- Modify: `hooks-core/policy.mjs` (`mode()`), `README.md`
- Test: `tests/hooks/default-mode.test.mjs` (create)

**Interfaces:**
- Consumes: Task 3's measurement.
- Produces: `mode()` returns `'assist'` when `TOKEN_OPTIMIZER_MODE` is unset or unrecognised.

- [ ] **Step 1: Write the failing test**

Create `tests/hooks/default-mode.test.mjs`:

```javascript
/**
 * The shipped default is measured, not assumed.
 *
 * `enforce` measured 1.687x vanilla Claude Code with correctness falling from
 * 0.994 to 0.956. `assist` -- refusals off, graph on -- is the posture that
 * replaces it, and it ships only because bench/results carries its number.
 */
import { mode } from '../../hooks-core/policy.mjs';

const withEnv = (value, fn) => {
  const had = Object.hasOwn(process.env, 'TOKEN_OPTIMIZER_MODE');
  const prev = process.env.TOKEN_OPTIMIZER_MODE;
  if (value === undefined) delete process.env.TOKEN_OPTIMIZER_MODE;
  else process.env.TOKEN_OPTIMIZER_MODE = value;
  try {
    return fn();
  } finally {
    if (had) process.env.TOKEN_OPTIMIZER_MODE = prev;
    else delete process.env.TOKEN_OPTIMIZER_MODE;
  }
};

describe('default mode', () => {
  test('is assist when the variable is unset', () => {
    expect(withEnv(undefined, mode)).toBe('assist');
  });

  test('is assist for an unrecognised value, so a typo cannot silently enforce', () => {
    expect(withEnv('enfroce', mode)).toBe('assist');
  });

  test('enforce is still reachable by exact opt-in', () => {
    expect(withEnv('enforce', mode)).toBe('enforce');
  });

  test('off is still the complete escape hatch', () => {
    expect(withEnv('off', mode)).toBe('off');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/hooks/default-mode.test.mjs`
Expected: the first two tests FAIL with `"enforce"`; the last two PASS, which confirms the suite discriminates.

- [ ] **Step 3: Change the fallback**

In `hooks-core/policy.mjs`, `mode()` returns `MODE_ASSIST` instead of `MODE_ENFORCE`, and its doc comment states the measured reason with the number from `bench/results`.

- [ ] **Step 4: Make the enforcement suite explicit**

`tests/hooks/enforcement.test.mjs` relies on the default being `enforce`. In its `run()` helper's `env` block, before the `...env` spread:

```javascript
      // This suite is ABOUT enforcement, so it opts in explicitly. Without this
      // line every deny assertion would receive an allow and pass vacuously.
      TOKEN_OPTIMIZER_MODE: 'enforce',
```

- [ ] **Step 5: Propagate and check for regressions**

```bash
node scripts/sync-hook-core.mjs
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/hooks
```
Expected: all suites green. A suite failing with an unexpected `allow` was relying on the old default — make its opt-in explicit as in Step 4 rather than reverting the default.

- [ ] **Step 6: Correct the README**

Replace the `enforced-by-default` badge with `measured-against-a-control`, and rewrite the "30-second version" point 1 to state that enforcement is opt-in via `TOKEN_OPTIMIZER_MODE=enforce`, with the measured figures and a pointer to `bench/results`.

- [ ] **Step 7: Commit**

```bash
git add hooks-core plugin integrations tests README.md
git commit -m "fix(policy): default to assist, the measured posture

enforce measured 1.687x vanilla Claude Code with correctness falling to 0.956.
assist keeps the graph and drops the refusals, and ships as the default on the
number in bench/results rather than on an assumption."
```

---

### Task 5: Spike — can a PostToolUse hook rewrite a built-in tool result?

**Files:**
- Create: `docs/superpowers/spikes/2026-08-29-posttooluse-rewrite.md`

This is a **spike**: the output is an answer, not code we keep. Anything built is throwaway.

- [ ] **Step 1: Establish what the contract allows**

Read `anthropics/claude-code#32105` and the current PostToolUse hook documentation. Record what the documented contract says about modifying a tool result before it reaches context.

- [ ] **Step 2: Probe each tool empirically, in the sandbox**

For each of `Bash`, `Read`, `Grep`, `WebFetch`: register a throwaway `PostToolUse` hook that replaces the tool output with a short marker, run a real call against known-large content, and record whether context receives the marker or the original.

Run this **inside the Docker sandbox**, not in a working session — registering a throwaway hook in a live session modifies the settings the session is running under.

- [ ] **Step 3: Write the findings**

Create the spike doc with a four-row table — tool, rewrite possible (yes/no), observed behaviour — plus a recommendation.

The decision it feeds: debug loops are our worst family (1.248 vs tokenade's 0.611) and the mechanism is repeated test output. **If `Bash` output can be rewritten in place, the debug-loop lever is viable as designed.** If not, it must route through the optimizer's own tool results — the one surface we fully control — and the spec's P0 needs revising before implementation.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/spikes
git commit -m "docs(spike): whether posttooluse can rewrite built-in tool results"
```

---

## Self-Review

**Spec coverage.** M2 → Task 1. M3 → Tasks 2–3. M1 → Task 4. The P0 spike gating M4 → Task 5. M0 is complete (PR #352) and is therefore not a task here. Not covered by design: M4-M9. Task 3 produces the M3 confirmation only; every later milestone is gated on its own campaign, which is why each gets its own plan.

**Placeholders.** None. Task 2 Step 3 is a genuine conditional — verify a switch exists, and if it does not, stop and add it — because the arm is invalid without it, not because the decision is deferred.

**Type consistency.** `mode()` returns the same four string values throughout. Arm names (`token-optimizer-mcp`, `-assist`, `-off`, `-nograph`) are used identically in Tasks 2, 3 and 4.

**Two risks worth stating.**

1. Task 4 is **gated on a measurement that may not favour it**. If `assist` does not beat control, the correct outcome is to stop and revisit the spec, not to ship it anyway. Task 3 Step 3 says so explicitly.
2. Task 1 and Task 2 are coupled: the enforcing arm's manifest must keep `TOKEN_OPTIMIZER_MODE=enforce` once the default changes in Task 4, or two arms become identical and the campaign silently produces a meaningless comparison rather than an error.
