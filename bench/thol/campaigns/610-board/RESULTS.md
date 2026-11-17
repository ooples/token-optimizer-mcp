# PR #610 board status: blocked by model-account quota

No comparative cost or quality verdict is available.

The pre-registered candidate is product commit `6c3bd71d`, tree
`55cfe5467358a265bf609b4dd232a8e2e8cd9a4c`; master is `1518a5d7`, tree
`8b68d518a20e069fa09bc39c6fffff737ff7edf6`. The same harness changes were
applied to both images. All 17 task prompts and verifier selftests passed
preflight, including the rig-local whole-file rewrite task.

| Image | Completed measurements | Account errors | Recorded cost |
|---|---:|---:|---:|
| Candidate | 0 | 17 | $0.00 |
| Master | 0 | 0 | $0.00 |

Claude returned: "You've hit your weekly limit · resets Nov 20, 12am (UTC)".
The campaign was stopped. An account refusal is not a failed product task and
is not a cheap successful run. These rows do not enter a cost ratio, a success
comparison, or a category decision. The report deliberately emits no aggregate
for the incomplete battery. The PR stays a draft.

The quota resets **2026-11-20 at 00:00 UTC**. An independently funded Anthropic
API route could also run the same model and protocol, but none was configured
in the environment when this run stopped.

## Reproduce and resume

The driver and protocol are committed before measurement. Use Git Bash:

```sh
bash bench/thol/campaigns/610-board/run.sh
python bench/thol/campaigns/610-board/report.py --write
```

The driver pins product heads, alternates images by repetition, uses one
unchanged order-plan checksum, checks spend before and after each image, and
stops above $70. Dedicated v2 volumes preserve earlier setup metadata. The
runner retries failed account attempts instead of treating them as completed
measurements. Do not change the candidate or pool measurements from another
tree without an explicit protocol amendment and separate result identity.

`runs.json` preserves the setup attempt's numerical records; `summary.json`
marks the battery incomplete. No private application prompts or credentials
are included. The report selftest checks incomplete billing, missing runs,
duplicate runs, quality regression, category thresholds and outlier detection.

Once measurements are available, inspect every task ratio outside [0.67, 1.5]
and record its disposition before applying the fixed decision rule. Surveys
or rewrites above 1.03 lose their overrides; unchanged categories above 1.05
need investigation. A headline requires all 170 planned measurements.
