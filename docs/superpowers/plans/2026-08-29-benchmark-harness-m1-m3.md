# Benchmark Harness M1–M3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop shipping a default measured at 1.687× vanilla Claude Code, move the benchmark harness into this repo so every later claim is reproducible, confirm the screening numbers at `--reps 3`, and answer the one feasibility question that gates the work which actually wins the board.

**Architecture:** Three independent deliverables plus a spike. The default flip is a one-function change in `hooks-core/policy.mjs` plus the test changes it forces. The harness migrates from an unversioned sibling directory (`../thol-rig`) into `bench/`, keeping its Docker isolation and adding npm entry points. The confirmation run and the graph-disabled arm are campaigns executed with the migrated harness. The spike answers whether a `PostToolUse` hook can rewrite built-in tool results, which decides the design of M4.

**Tech Stack:** Node 22 ESM (`hooks-core/*.mjs`, no build step), Jest with `--experimental-vm-modules`, Docker (`node:22-bookworm`), Python 3 stdlib (THOL's harness), SQLite.

**Spec:** `docs/superpowers/specs/2026-08-29-benchmark-harness-and-competitive-program-design.md`

## Global Constraints

- Node >= 22. `hooks-core/` and `plugin/` are plain ESM executed with no build step.
- **`hooks-core/` is the source of truth.** Never edit `plugin/hooks/lib/*` or `integrations/*/hooks/lib/*` directly. Edit `hooks-core/<file>.mjs`, then run `node scripts/sync-hook-core.mjs`. `tests/hooks/clients.test.mjs` fails on drift.
- Never use the null-forgiving operator (`!`). Never use `string` where a closed set of values belongs in an enum.
- Feature branches only; never commit to `master`.
- Run tests with `node --experimental-vm-modules node_modules/jest/bin/jest.js <path>`.
- `bench/` must be excluded from the npm `files` list in `package.json` so users never download it.
- Docker on Windows: always `MSYS_NO_PATHCONV=1` before `docker run` with absolute paths, and use the named volume `thol-results`, never a Windows bind mount for `/results`.

---

### Task 1: Flip the default mode to `off`

**Files:**
- Modify: `hooks-core/policy.mjs` (the `mode()` function, ~line 55-66, and the doc comment at ~line 27)
- Modify: `tests/hooks/enforcement.test.mjs` (the `run()` helper's `env` block)
- Test: `tests/hooks/default-mode.test.mjs` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `mode()` returns `'off'` when `TOKEN_OPTIMIZER_MODE` is unset or unrecognised, `'enforce'` only on the exact string `enforce`, `'advise'` only on `advise`. Later tasks and the harness rely on `TOKEN_OPTIMIZER_MODE=enforce` being the way to get the old behaviour.

- [ ] **Step 1: Write the failing test**

Create `tests/hooks/default-mode.test.mjs`:

```javascript
/**
 * The shipped default is measured, not assumed.
 *
 * A local campaign over 16 THOL tasks measured the enforcing default at 1.687x
 * vanilla Claude Code with correctness falling from 0.994 to 0.956, while the
 * same build with enforcement off measured 0.904. Until the zero-turn refusal
 * actually fires (see the spec's section 6.2), off is the honest default.
 *
 * `enforce` remains reachable by exact opt-in, and the harness depends on that.
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
  test('is off when the variable is unset', () => {
    expect(withEnv(undefined, mode)).toBe('off');
  });

  test('is off when the variable is empty', () => {
    expect(withEnv('', mode)).toBe('off');
  });

  test('is off for an unrecognised value, so a typo cannot silently enforce', () => {
    expect(withEnv('enfroce', mode)).toBe('off');
  });

  test('enforce is still reachable by exact opt-in', () => {
    expect(withEnv('enforce', mode)).toBe('enforce');
    expect(withEnv('ENFORCE', mode)).toBe('enforce');
  });

  test('advise is still reachable by exact opt-in', () => {
    expect(withEnv('advise', mode)).toBe('advise');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/hooks/default-mode.test.mjs`
Expected: FAIL — the first three tests receive `'enforce'` instead of `'off'`. The last two pass, which confirms the test discriminates rather than failing for an unrelated reason.

- [ ] **Step 3: Flip the fallback in `hooks-core/policy.mjs`**

Replace the body of `mode()`:

```javascript
export function mode() {
  const raw = (process.env.TOKEN_OPTIMIZER_MODE || '').trim().toLowerCase();
  if (raw === MODE_ENFORCE) return MODE_ENFORCE;
  if (raw === MODE_ADVISE) return MODE_ADVISE;
  return MODE_OFF;
}
```

Then replace the doc comment above it, which currently argues for the opposite default, with:

```javascript
/**
 * Which posture the hooks take: enforce, advise, or off.
 *
 * THE DEFAULT IS OFF, AND THAT IS A MEASURED DECISION rather than caution. A
 * campaign over 16 THOL tasks put the enforcing default at 1.687x vanilla
 * Claude Code -- last of fifteen against the published board -- because a
 * refusal that redirects costs a round trip: enforcement added 107 tool calls
 * and took turns from 12.6 to 20.9, about one extra turn per refusal.
 * Correctness fell too, 0.994 -> 0.956, so there was no benefit column to
 * trade against. The same build with enforcement off measured 0.904.
 *
 * Enforcement returns as the default once the zero-turn refusal actually fires
 * (`refusalPayload` needs a file-node snapshot it does not currently get), at
 * which point a refusal answers in place and costs no turn. The gate is an
 * invariant the harness can check: with enforcement on, turns and own tool
 * calls must not rise above the off arm.
 *
 * An unrecognised value now falls back to OFF. The previous fallback was
 * enforce, on the reasoning that a typo must not silently disable the product;
 * with enforce measured as the more expensive state, a typo silently enabling
 * it is the more costly mistake.
 */
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/hooks/default-mode.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Make the existing enforcement suite explicit about the mode it tests**

`tests/hooks/enforcement.test.mjs` never set `TOKEN_OPTIMIZER_MODE`, so it relied on the old default. It is a suite *about enforcement*, so it must now opt in explicitly. In its `run()` helper, inside the `env` object, add the variable immediately before the `...env` spread so individual tests can still override it:

```javascript
      TOKEN_OPTIMIZER_WIKI_DIR: ISOLATED_GRAPH,
      TOKEN_OPTIMIZER_SHARED_DIR: ISOLATED_GRAPH,
      // This suite is ABOUT enforcement, so it opts in explicitly. The default
      // is now off (see tests/hooks/default-mode.test.mjs); without this line
      // every deny assertion here would receive an allow.
      TOKEN_OPTIMIZER_MODE: 'enforce',
      ...env,
```

- [ ] **Step 6: Propagate to the vendored copies**

Run: `node scripts/sync-hook-core.mjs`
Expected: `synced NN core file(s) to 11 client integration(s)`

- [ ] **Step 7: Run the full hook suite for regressions**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/hooks`
Expected: PASS. Every suite green, including `clients.test.mjs`'s vendored-core drift check. If any suite fails with an unexpected `allow`, it was relying on the old default — make its opt-in explicit the same way as Step 5 rather than reverting the default.

- [ ] **Step 8: Commit**

```bash
git add hooks-core/policy.mjs plugin/hooks/lib/policy.mjs integrations tests/hooks/default-mode.test.mjs tests/hooks/enforcement.test.mjs
git commit -m "fix(policy): default to off, which is the measured cheaper state

A campaign over 16 THOL tasks measured the enforcing default at 1.687x vanilla
Claude Code and correctness at 0.956 against 0.994, while the same build with
enforcement off measured 0.904. Enforcement returns as the default once the
zero-turn refusal fires and a refusal stops costing a round trip."
```

---

### Task 2: Correct the positioning the flip invalidates

**Files:**
- Modify: `README.md` (the badge row near line 20, the "30-second version" numbered point 1 near line 40, and the "Trust: we ship hooks that refuse your tool calls" section near line 428)

**Interfaces:**
- Consumes: Task 1's default.
- Produces: nothing code-level.

- [ ] **Step 1: Replace the enforcement badge**

`README.md` currently carries `<img src="https://img.shields.io/badge/enforced-by%20default-2ea043" alt="Enforced by default">`. Replace that single line with:

```html
  <img src="https://img.shields.io/badge/measured-against%20a%20control-2ea043" alt="Measured against a control">
```

- [ ] **Step 2: Rewrite the claim in "The 30-second version"**

Point 1 currently opens `**1. It makes the expensive call impossible.**` and states that a built-in `Read` of a large file is denied with no setting to turn on. Replace that whole numbered point with:

```markdown
**1. It measures itself against a control, and changes when the number says
so.** Enforcement — refusing an expensive built-in call and naming the cached
replacement — ships **off by default** as of 6.1.0, because we measured it. On
16 tasks from a public benchmark, enforcing cost 1.687× vanilla Claude Code and
dropped task correctness from 0.994 to 0.956; the same build with enforcement
off cost 0.904. A refusal that redirects buys a smaller tool result and pays a
whole round trip for it. Turn it on with `TOKEN_OPTIMIZER_MODE=enforce`; it
returns as the default when a refusal answers in place instead of redirecting.
```

- [ ] **Step 3: Correct the "Trust" section's framing**

That section is headed `## Trust: we ship hooks that refuse your tool calls`. Change the heading to `## Trust: we publish the number that made us turn enforcement off` and add this paragraph directly beneath it, before the existing content:

```markdown
The strongest thing we can say about our own hooks is that we measured them
against a control and did not like the answer. Enforcement is off by default
because it lost: 1.687× the cost of running nothing, with worse correctness.
The raw per-run data is in `bench/`, and you can reproduce it.
```

- [ ] **Step 4: Verify no other file still promises enforcement by default**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/hooks tests/unit 2>&1 | tail -5`
Expected: PASS. Then manually check `plugin/skills/` for any skill description asserting enforcement is automatic, and correct the wording in the same way if found.

- [ ] **Step 5: Commit**

```bash
git add README.md plugin/skills
git commit -m "docs: state that enforcement is off by default and why

The badge and the 30-second version promised enforcement with no setting to
turn on. It is now opt-in, and the reason is a measurement rather than a
retreat, so the README leads with the number."
```

---

### Task 3: Move the harness into `bench/`

**Files:**
- Create: `bench/README.md`, `bench/thol/Dockerfile`, `bench/thol/entrypoint.sh`, `bench/thol/run-campaign.sh`, `bench/thol/manifests/token-optimizer-mcp/manifest.json`, `bench/thol/manifests/token-optimizer-mcp-off/manifest.json`, `bench/.gitignore`
- Modify: `package.json` (the `files` array and the `scripts` block)
- Source of the copied files: `../thol-rig/` relative to the repo root

**Interfaces:**
- Consumes: Task 1's `TOKEN_OPTIMIZER_MODE=enforce` opt-in, which the enforcing manifest must now set explicitly.
- Produces: `npm run bench:screen` and `npm run bench:confirm`; a `thol-results` Docker volume holding `results.sqlite` with the row shape the spec's §5.1 defines.

- [ ] **Step 1: Copy the working rig in**

```bash
mkdir -p bench/thol/manifests
cp ../thol-rig/Dockerfile bench/thol/Dockerfile
cp ../thol-rig/scripts/entrypoint.sh bench/thol/entrypoint.sh
cp ../thol-rig/scripts/run-campaign.sh bench/thol/run-campaign.sh
cp -r ../thol-rig/manifests/token-optimizer-mcp bench/thol/manifests/
cp -r ../thol-rig/manifests/token-optimizer-mcp-off bench/thol/manifests/
printf 'auth/\nresults/\n*.sqlite\n' > bench/.gitignore
```

- [ ] **Step 2: Fix the paths the copy broke**

`bench/thol/Dockerfile` has `COPY scripts/ /home/bench/scripts/` and `COPY manifests/ /home/bench/manifests/`, which assumed the rig's layout. Change those two lines to:

```dockerfile
COPY --chown=bench:bench thol/entrypoint.sh /home/bench/scripts/entrypoint.sh
COPY --chown=bench:bench thol/manifests/ /home/bench/manifests/
```

The build context is now `bench/`, so build with `docker build -f bench/thol/Dockerfile bench/`.

In `bench/thol/run-campaign.sh`, `RIG_DIR` resolves one level up from the script. Change it to resolve the `bench/` directory:

```bash
RIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
```

That already yields `bench/`, so `$RIG_DIR/auth` is `bench/auth` — matching `bench/.gitignore`. No further change needed.

- [ ] **Step 3: Make the enforcing manifest opt in explicitly**

Task 1 changed the default, so the arm named `token-optimizer-mcp` would now measure *off* and the two arms would be identical. In `bench/thol/manifests/token-optimizer-mcp/manifest.json`, add the variable to **both** env blocks — `mcp.mcpServers.token-optimizer.env` and `settings.env`:

```json
"TOKEN_OPTIMIZER_MODE": "enforce"
```

Leave `token-optimizer-mcp-off` alone: it already sets `"TOKEN_OPTIMIZER_MODE": "off"`, which is now also the default, so it measures the shipped configuration.

- [ ] **Step 4: Add the npm entry points**

In `package.json`, add to `scripts`:

```json
    "bench:build": "docker build -f bench/thol/Dockerfile -t thol-rig:local bench/",
    "bench:screen": "bash bench/thol/run-campaign.sh",
    "bench:confirm": "REPS=3 bash bench/thol/run-campaign.sh"
```

And confirm the `files` array does **not** contain `bench`. It currently lists `dist/**/*`, `hooks/**/*`, `plugin/**/*` and others explicitly, so `bench/` is excluded by omission — verify rather than assume.

- [ ] **Step 5: Write `bench/README.md`**

```markdown
# bench/

The harness that grades this project, living beside the code it grades so a
behaviour change and its measured effect land in the same commit.

## Run it

    npm run bench:build
    REPS=1 SEGMENTS_MAX=4 npm run bench:screen    # ~48 runs, ~$13, ~1h
    npm run bench:confirm                          # --reps 3, for published claims

Authentication: the campaign stages a trimmed copy of your Claude Code
credentials (the `claudeAiOauth` key only) into `bench/auth/`, which is
gitignored. Credentials are re-staged between segments because THOL gives every
run a throwaway HOME, so a token refresh inside a sandbox dies with it.

## What the numbers mean

Cost ratio is a task's cost divided by the same task's cost on the `control`
arm of the same campaign. Ratios are comparable across campaigns; absolute
dollars are not, because campaigns pin different Claude Code versions.

`score` is the task verifier's 0-1 correctness. **A cost figure without its
paired score is not a result** — a compressor that eats the answer looks
excellent on cost alone.

## What it does not measure

Every run gets a throwaway HOME and a fresh workspace, so the knowledge graph
starts empty and a finding harvested at Stop cannot help the session that
produced it. Single-shot ratios are therefore the graph's worst case, not a
measurement of it. `bench/recall/` exists to measure that properly.
```

- [ ] **Step 6: Verify the migrated harness still passes its own gate**

```bash
npm run bench:build
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd)/bench/auth:/auth:ro" -v thol-results:/results thol-rig:local selftest
```
Expected: `selftest PASSED` with all 17 verifiers `ok`, then a competitor list including `token-optimizer-mcp` and `token-optimizer-mcp-off` **without** the `[unverified manifest]` suffix.

- [ ] **Step 7: Commit**

```bash
git add bench package.json
git commit -m "test(bench): move the benchmark harness into the repo

It graded this project from an unversioned sibling directory that git never
saw. In bench/ it is versioned with the code it grades, so a rule change and
its measured effect can land in one commit, and anyone can reproduce a
published claim."
```

---

### Task 4: Add the graph-disabled arm

**Files:**
- Create: `bench/thol/manifests/token-optimizer-mcp-nograph/manifest.json`
- Modify: `bench/thol/run-campaign.sh` (the `ARMS` default)

**Interfaces:**
- Consumes: Task 3's manifest directory and orchestrator.
- Produces: an arm named `token-optimizer-mcp-nograph` whose rows isolate the empty graph's overhead.

- [ ] **Step 1: Derive the manifest programmatically**

The arm must differ from `token-optimizer-mcp-off` in exactly one variable, or it measures something else. Derive it rather than hand-copying:

```bash
node -e "
const fs=require('fs');
const p='bench/thol/manifests/token-optimizer-mcp-off/manifest.json';
const m=JSON.parse(fs.readFileSync(p,'utf8'));
m.name='token-optimizer-mcp-nograph';
m.display_name='Token Optimizer MCP (no graph)';
m.install_doc='ISOLATES THE KNOWLEDGE GRAPH. Identical to token-optimizer-mcp-off except TOKEN_OPTIMIZER_WIKI_DISABLED=1. Because every THOL run gets a throwaway HOME, the graph is empty on every run and can deliver nothing; this arm therefore measures its OVERHEAD alone -- SessionStart injection and Stop harvest -- which is the only part of the graph a single-shot benchmark can see.';
m.settings.env.TOKEN_OPTIMIZER_WIKI_DISABLED='1';
m.mcp.mcpServers['token-optimizer'].env.TOKEN_OPTIMIZER_WIKI_DISABLED='1';
fs.mkdirSync('bench/thol/manifests/token-optimizer-mcp-nograph',{recursive:true});
fs.writeFileSync('bench/thol/manifests/token-optimizer-mcp-nograph/manifest.json',JSON.stringify(m,null,2)+'\n');
console.log('written');
"
```

- [ ] **Step 2: Prove it differs in exactly one variable**

```bash
diff <(node -e "const m=require('./bench/thol/manifests/token-optimizer-mcp-off/manifest.json');delete m.install_doc;delete m.name;delete m.display_name;console.log(JSON.stringify(m,null,2))") \
     <(node -e "const m=require('./bench/thol/manifests/token-optimizer-mcp-nograph/manifest.json');delete m.install_doc;delete m.name;delete m.display_name;console.log(JSON.stringify(m,null,2))")
```
Expected: exactly two hunks, each adding only `TOKEN_OPTIMIZER_WIKI_DISABLED`. Any other difference invalidates the arm — fix it before running anything.

- [ ] **Step 3: Confirm the variable is actually honoured**

`TOKEN_OPTIMIZER_WIKI_DISABLED` must genuinely disable graph reads and writes. Verify before spending money:

```bash
node -e "
process.env.TOKEN_OPTIMIZER_WIKI_DISABLED='1';
const w=await import('./hooks-core/wiki.mjs');
console.log(Object.keys(w).filter(k=>/disabled|enabled/i.test(k)));
" --input-type=module
```

If no such switch exists, **stop and add one** in `hooks-core/wiki.mjs` as its own committed change with a unit test, then return here. Do not approximate it by pointing `TOKEN_OPTIMIZER_WIKI_DIR` at an empty directory — that disables delivery but leaves harvest writing, so it would measure a different thing than the manifest claims.

- [ ] **Step 4: Add the arm to the default set**

In `bench/thol/run-campaign.sh`:

```bash
ARMS="${ARMS:-control,token-optimizer-mcp,token-optimizer-mcp-off,token-optimizer-mcp-nograph}"
```

- [ ] **Step 5: Commit**

```bash
git add bench/thol
git commit -m "test(bench): add a graph-disabled arm to isolate empty-graph overhead

Every run gets a throwaway HOME, so the graph is empty and can deliver nothing.
This arm measures what it costs anyway -- the only part of the graph a
single-shot benchmark can see -- against an otherwise identical build."
```

---

### Task 5: Confirm the screen at `--reps 3`

**Files:**
- Create: `bench/results/2026-08-29-confirmation.md`

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces: the confirmed figures every later milestone's exit criterion is compared against.

- [ ] **Step 1: Run the confirmation campaign**

Four arms × 16 tasks × 3 reps = 192 runs, roughly $55 and several hours. Run it segmented so it survives credential expiry:

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

Write `bench/results/2026-08-29-confirmation.md` containing: the four arms' mean cost, turns, own/all tool calls and score; the per-task ratio table; the campaign's Claude Code version and product version; and an explicit statement of whether the `--reps 1` screen's headline figures (enforcing 1.687, off 0.904) held.

**If the confirmation contradicts the screen, that is the result.** Record it, and open an issue to revisit Task 1 rather than quietly re-running until the numbers agree.

- [ ] **Step 4: Commit**

```bash
git add bench/results
git commit -m "test(bench): confirmation campaign at --reps 3

Replaces the single-rep screen's point estimates with means over three
repetitions, and records the empty-graph overhead the nograph arm isolates."
```

---

### Task 6: Spike — can a PostToolUse hook rewrite a built-in tool result?

**Files:**
- Create: `docs/superpowers/spikes/2026-08-29-posttooluse-rewrite.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a documented yes/no per tool, which decides M4's design.

This is a **spike**: the output is an answer, not code we keep. Anything built here is labelled throwaway.

- [ ] **Step 1: Establish what the hook contract allows**

Read `anthropics/claude-code#32105` and the current PostToolUse hook documentation. Record what the documented contract says about modifying a tool's result before it reaches context.

- [ ] **Step 2: Probe each tool empirically**

For each of `Bash`, `Read`, `Grep`, `WebFetch`: register a throwaway `PostToolUse` hook that emits a JSON response attempting to replace the tool output with a short marker string, run a real call against a file with known large content, and record whether the model's context receives the marker or the original output.

- [ ] **Step 3: Write the findings**

Create `docs/superpowers/spikes/2026-08-29-posttooluse-rewrite.md` with a four-row table — tool, rewrite possible (yes/no), evidence (the exact observed behaviour) — plus a recommendation for M4's design.

The decision this feeds: debug loops are our worst family (1.248 against tokenade's 0.611) and the mechanism is repeated test output. **If `Bash` output can be rewritten in place, M4 is viable as designed.** If it cannot, M4 must instead compact via the optimizer's own tool results — the one surface we fully control — and the spec's P0 needs revising before any implementation.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/spikes
git commit -m "docs(spike): whether PostToolUse can rewrite built-in tool results

Decides whether M4's debug-loop compaction can work on Bash output in place or
must route through our own tool results."
```

---

## Self-Review

**Spec coverage.** M1 → Tasks 1–2. M2 → Task 3. M3 → Tasks 4–5. The P0 spike that gates M4 → Task 6. Spec §5.1's row shape, §5.2's encoded lessons and §5.3's impartiality rules travel with the copied harness in Task 3 and are documented in `bench/README.md`. Not covered here, by design: M4–M9, whose exit criteria are numbers Task 5 produces.

**Placeholders.** None. Every code step carries the actual content. Task 4 Step 3 is a genuine conditional — verify a switch exists, and if it does not, stop and add it — rather than a deferred decision, because the arm is invalid without it.

**Type consistency.** `mode()` returns the same three string values throughout, and Task 3 Step 3 depends on Task 1's `enforce` opt-in remaining exact-match. Arm names (`token-optimizer-mcp`, `token-optimizer-mcp-off`, `token-optimizer-mcp-nograph`) are used identically in Tasks 3, 4 and 5.

**One risk worth stating.** Task 1 and Task 3 Step 3 are coupled: flipping the default without adding `TOKEN_OPTIMIZER_MODE=enforce` to the enforcing manifest would make two arms identical and silently produce a meaningless campaign. Task 3 Step 3 exists to prevent exactly that.
