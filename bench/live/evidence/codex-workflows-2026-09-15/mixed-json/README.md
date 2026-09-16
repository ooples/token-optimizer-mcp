# Mixed JSON shell output: cost-focused comparison

Fixed build 09b3fcf5; Codex 0.154.0, gpt-6-astra, installed HeadRoom 0.37.0.
Refresh seeds 34–35, two repetitions, reversed arm order. Both arms were asked
to print AGENTS.md and the complete routes.json in one initial shell command.
All four passed the independent task grader, exact mixed-read exposure check,
and provider/client usage reconciliation. No attempts were discarded.

| Mean per attempt | Our proxy | HeadRoom |
| --- | ---: | ---: |
| Input tokens | 74,580.5 | 131,734.5 |
| Uncached input | 12,244.5 | 17,558.5 |
| Output tokens | 650.5 | 853.5 |
| Requests | 5.5 | 9 |
| Agent seconds | 34.9 | 47.4 |
| Standard-rate cost scenario | $0.217306 | $0.332436 |

The proxy cost scenario was 34.6% lower and was lower in both matched pairs.
Input was 43.4% lower, requests 38.9% lower, and mean agent time 26.4% lower.
Cost uses the previously verified Codex Enterprise standard rates and is not
an account invoice. Small samples, differing agent choices, and provider cache
variability limit the conclusion. HeadRoom had one shell failure in round one.

The codec handles complete, column-zero JSON documents inside mixed text,
preserving surrounding text. It refuses malformed/partial documents and keeps
explicitly truncated output on the existing exact-fragment path. Replay of the
previous missed capture changed 29,386 characters to 698 while preserving its
instruction text and disabled-route ID. Twelve focused checks passed, including
fragment routing; build and targeted lint passed. No broad suite was repeated.

This is a controlled-read competitor screen. It is not evidence that the
previous natural-read 47.8% cost loss is resolved, and there is no old-build live
arm to isolate causality. The prior losing screen remains in output-cache-live/.
