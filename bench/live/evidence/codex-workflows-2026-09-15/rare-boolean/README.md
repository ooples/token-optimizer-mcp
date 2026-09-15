# Rare boolean preservation: local Codex versus shipped HeadRoom

Fixed build e4550423, Codex 0.154.0, gpt-6-astra, installed HeadRoom 0.37.0.
Natural refresh, seeds 29–31, three rotated positions. All nine attempts passed
the independent artifact grader and provider/client usage reconciliation.

| Mean per attempt | Our proxy | HeadRoom | Control |
| --- | ---: | ---: | ---: |
| Total input tokens | 80,948 | 109,171 | 142,531 |
| Uncached input tokens | 10,292 | 17,822 | 21,742 |
| Output tokens | 652 | 698 | 552 |
| Provider requests | 6 | 7.67 | 6.67 |
| Agent seconds (excludes startup) | 38.67 | 46.13 | 37.60 |
| Seconds including startup | 39.57 | 65.40 | 38.47 |

Our proxy used 25.9% less input than HeadRoom, with a 32.3% lower standard-rate
token-cost scenario, 21.7% fewer requests, and 16.2% lower mean agent time.
It was slower than HeadRoom in round two and 2.8% slower than control on mean
agent time. Three attempts per arm do not establish statistical superiority.
Cost is a published-rate scenario, not actual billing; see cost-scenario.json.

Capture replay found the complete initial array compressed from 29,285
characters to 592–593 while retaining the pre-existing disabled route in all
three proxy attempts. The agent still reread data programmatically. This proves
visibility of that record, not causal elimination of recovery calls. There was
no old-build live arm. No broad test suite was rerun for this screen.

Inspection also found a remaining gap: a combined AGENTS.md plus routes.json
shell output bypassed JSON compression. This was observed in a control capture
and replay, not counted as a live proxy failure. The subsequent output cache
performance change is not part of this fixed-build result.
