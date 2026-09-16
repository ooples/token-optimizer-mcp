# Bounded discovery development screen

All four refresh attempts passed independent artifact and MCP cache audits.
Both arms retain our proxy. The explicit prompt carries the same bounded
discovery guidance added to integrations/AGENTS.md. This is a development
screen, not a HeadRoom comparison or a controlled before/after experiment.

Core averaged 149,543 input tokens; files averaged 169,634 (13.4% more).
Files had a 10.1% lower standard-rate cost scenario because of its cache mix.
The smaller profile therefore remains experimental, not the default.

The earlier initialization-only guidance screen is retained in ../init-guidance.
Its capture audit found that the extra initialization guidance did not reach
the model. Do not attribute its results to that guidance.

The subsequent rare-boolean-row preservation change was made after this run;
these results do not validate that change or establish reduced recovery reads.
The planned 54-run campaign remains deferred while product work takes priority.
