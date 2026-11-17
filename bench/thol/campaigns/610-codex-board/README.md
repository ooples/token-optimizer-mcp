# Codex task-category campaign

This replaces the Claude-only execution dependency following the maintainer's
clarification. Read `PREREGISTRATION.md` for the frozen products, live-hook
preflight, paired task order, metrics, decision rules and exposure cap.

Build `thol-codex:pr610` and `thol-codex:master` using `Dockerfile`, passing
the corresponding `thol-rig` image as `BASE`. Those base images and the shared
`thol-610-board-v2-pr610` volume are from the recorded `610-board` setup.
Both derived images add the same Codex CLI version. No credentials are built
into either image.

Run from PowerShell with a private evidence directory and your existing local
Codex authentication file:

```powershell
python bench/thol/campaigns/610-codex-board/report.py --selftest
python bench/thol/campaigns/610-codex-board/campaign.py --output C:/private/codex-board --auth C:/Users/me/.codex/auth.json
```

The driver fingerprints both images, every task/fixture/truth file and the
pinned repository heads before starting. It refuses mismatched inputs, changed
harnesses, unfinished attempts and invalid results. `--max-new-runs 2` permits
an initial pair; invoking the same command later resumes the frozen plan.
It never retries a failed attempt automatically. Raw evidence stays outside
the repository, including transcripts, hook audits and independent grading.

Every scored task uses the actual native Codex hooks composed by the package's
documented installer and the product's MCP launch path. The candidate's prompt
classification must appear in its ledger. The settings selected from its saved
state are recorded separately. Probe runs must demonstrate both changed rows
before scoring; they are not part of the 170-task aggregate.

`summary.json` withholds an aggregate while incomplete or invalid. After all
runs, review the recorded task outliers and required category dispositions
before making a ship decision. Report raw usage and rate-card credits as
estimates, never an account invoice. The old Claude account-refusal records
remain separate.
