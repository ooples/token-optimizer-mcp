# Does the system actually work? — verified end to end

Earlier rounds measured findings I pasted into a prompt myself. That is not the
product. This is the product: capture, storage, retrieval, injection.

## Capture

`session-start.mjs`, run as the real hook, emits a 445-token briefing that names
`wiki_write`, states the anchor requirement, and says what is worth recording.

`wiki_write` stores a finding as `origin: agent` with `derived_from` edges to real
file nodes, in the project resolved from the anchor — verified per worktree, and it
routed correctly to five separate project graphs.

## Retrieval — both paths fire, and are selective

**By file anchor.** A fresh agent, given the control prompt and told nothing,
received this unprompted while debugging:

    PreToolUse:Bash hook additional context: Known about .../smart-grep.ts
    (from previous sessions):
    - [failure] A spread of an unbounded array throws RangeError: Maximum call
      stack size exceeded — V8 limits a call to roughly 125,000 arguments...

**By command trigger.** Measured directly against `forCommand`:

| command | result |
| --- | --- |
| `npx jest tests/hooks` | injected, 65 tok |
| `npm test` | injected, 65 tok |
| `ls -la` | nothing |

Selective, not blanket.

## Cost of an injection

| task | injected | anchored file | % of file |
| --- | --- | --- | --- |
| libuv-abort | 165 tok | 2,038 tok | 8.1% |
| v8-spread | 113 tok | 5,556 tok | 2.0% |
| gh-token-suppression | 120 tok | 2,375 tok | 5.1% |
| registry-422 | 101 tok | 228 tok | 44.3% |

## Arm C — live retrieval vs control

| task | control | retrieval | Δ |
| --- | --- | --- | --- |
| v8-spread | 78,061 | 63,515 | **−18.6%** |
| registry-422 | 68,526 | 59,950 | **−12.5%** |
| libuv-abort | 70,459 | 70,858 | +0.6% |
| **mean** | **72,349** | **64,774** | **−10.5%** |

Accuracy 3/3. **Retrieval beat possession** (−10.5% vs −4.4% on the same three
tasks), which is the opposite of what a handed-the-answer upper bound predicts —
worth repeating before it is leaned on.

## Bugs this verification found

Both were found by using the system, not by reading it, and both are fixed:

- **Dot-directories invisible** (#268). `.github/`, `.claude/`, `.husky/` skipped
  entirely. Ten `.yml` files existed, all under `.github/`; the tool returned zero
  and reported success.
- **Read state shared across agents** (#269). An agent was refused a file it had
  never opened because a sibling had read it, and fell back to Bash — costing more
  than the read it replaced, in exactly the workload the optimizer targets.

## Not yet measured

Repeat 3, the three untouched tasks, blind scoring, the built-in token holdout,
and the memory/RAG comparisons. The CLAUDE.md comparison is running.
