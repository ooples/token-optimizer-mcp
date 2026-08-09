# Live model evaluation

This report records the August 9, 2026 live validation of automatic graph
capture and retrieval. It separates model-observed evidence from deterministic
fixtures so that dashboard claims are not based on seeded data alone.

## Scope

- Model: `gpt-5.6-sol`, invoked through Codex CLI 0.147.0 in fresh sessions.
- Product under test: the current local plugin and shared hook adapter.
- Treated arm: graph command retrieval enabled with
  `TOKEN_OPTIMIZER_HOLDOUT=0`.
- Holdout arm: the same hook and prompt with
  `TOKEN_OPTIMIZER_HOLDOUT=1`.
- Isolation: A/B command trials used `--ignore-user-config` and one explicit
  hook configuration so unrelated installed plugins could not affect the arm.
- Token measure: the CLI's `tokens used` value, which is uncached input plus
  output. It is not the sum of every cached prefix replayed during the session.

## Active-model semantic harvest

The production Codex plugin fired `SessionStart`, `PreToolUse`, `PostToolUse`,
and `Stop`. The model first attempted to finish without writing a finding. The
`Stop` hook then continued the same model turn with the semantic-harvest
instruction. Only after that continuation did the active model call
`wiki_write`; no delegated model generated the finding.

The captured finding says to run `npm test` from the project root rather than
running `node verify.mjs` from `scripts/`. It has a real `RUNBOOK.md` anchor, a
command trigger, and `origin: "agent"` in the graph. A second `Stop` pass
completed without looping.

- Full-plugin session: `019fe500-be70-79a2-a49f-2a5373f95f34`
- Stop-causal isolation session: `019fe504-8a68-7800-918b-955f2434f094`

Codex requires users to review a new plugin hook hash before it will run. The
automated local validation used the CLI's explicit hook-trust bypass against a
locally built artifact. That flag is for controlled automation, not the normal
installation path.

## Matched command-recovery experiment

Each fresh session received the same task: run
`cd scripts && node verify.mjs` exactly once, recover without opening the
runbook, run the supported command once, and report the result. The broken
command is intentionally represented by the harvested finding.

| Pair | Treated tokens | Holdout tokens | Both correct |
| ---: | ---: | ---: | :---: |
| 1 | 12,250 | 26,672 | yes |
| 2 | 13,306 | 16,464 | yes |
| 3 | 8,250 | 13,797 | yes |
| **Mean** | **11,269** | **18,978** | **3/3 per arm** |

The treated mean was 7,709 tokens lower, a **40.6% reduction** on this task.
All treated sessions recovered directly from the injected graph finding. The
holdout sessions had to rediscover the supported command from repository
evidence. Graph telemetry independently recorded non-empty command context for
the treated sessions and zero delivered tokens for holdouts.

This is directionally strong evidence, not a statistical conclusion: there are
only three pairs, one task shape, and one model/client combination.

## Negative control

A separate file-anchor task forced the first command to read `scripts/verify.mjs`.
The treated session received the exact graph finding but still opened
`package.json`, just as the holdout did. Both arms used three shell calls.

| Arm | Tokens | Shell calls | Behavioral improvement |
| --- | ---: | ---: | :---: |
| Treated | 12,903 | 3 | no |
| Holdout | 4,031 | 3 | baseline |

For this single pair, injection did not make the model more efficient and the
treated session paid a substantial cache/context penalty. This result is why
the dashboard must retain a sufficiency gate and must not label every retrieval
as savings.

## Context-window theory

First-turn no-tool probes did not support the theory that this MCP server
consumes most of the Codex context window:

| Configuration | Input tokens |
| --- | ---: |
| Core 18-tool profile | 14,227 |
| Full 98-tool profile | 14,227 |
| Installed plugins disabled | 14,228 |
| `--ignore-user-config` | 13,686 |

The observed difference between ordinary user configuration and an ignored
configuration was about 542 tokens. Core and full MCP profiles were identical
on this probe, consistent with lazy tool-schema exposure. Tool-heavy sessions
still require separate measurement; the first-turn result must not be
generalized to every workflow.

## Dashboard interpretation

The live dashboard was pointed at the stop-causal experiment graph and verified
through `/api/wiki/status`, `/api/wiki/search`, and `/api/wiki/balance`. It
showed the active-model finding and real command injection/holdout events.

The live graph's file-anchor causal balance correctly remained `insufficient`:
it had four treated file injections and no file holdouts, below the 20/5 gate.
Command events are reported separately because command anchors cannot currently
be joined reliably to downstream file-read outcomes. The deterministic
end-to-end verifier separately passed its seeded 26-treated/8-holdout balance;
that verifies the calculation and UI, but is not presented as live-model proof.

## Client coverage exercised in CI

The shared adapter and generated native integrations are validated for Codex,
Claude Code, Gemini CLI, Qwen Code, GitHub Copilot CLI, Cursor, Cline, OpenCode,
Kilo Code, and Windsurf. Roo Code, Zed, Amp, Continue, Crush, and Factory Droid
receive the same MCP and active-model harvesting policy through their supported
rules/configuration surface. See [Client support](CLIENT_SUPPORT.md) for the
capability-by-capability matrix.

The native-client verifier checks actual manifests, entry scripts, Windows and
POSIX wrappers, protocol rendering, stop-loop guards, graph delivery, and
active-model harvest instructions. Passing a configuration check is evidence
of wiring correctness; only the live experiments above are evidence about
model behavior and token efficiency.
