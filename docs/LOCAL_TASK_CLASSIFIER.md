# Optional local task classifier

The default classifier uses bounded rules. An opt-in learned model handles
requests those rules leave unknown. Clear requests, numbered choices,
cancellations and explicit environment overrides retain their precedence.

The model uses word/bigram TF-IDF features and a linear classifier. Inference
runs in Node inside the prompt hook, with no network request, Python process,
embedding download or additional language-model call. Python and scikit-learn
are required only when training a model.

## Train and enable

```sh
python -m pip install 'scikit-learn>=1.4,<2'
token-optimizer-task-classifier train --input labels.jsonl --output /absolute/path/task-model.json
token-optimizer-task-classifier inspect --model /absolute/path/task-model.json
```

Use `--python /path/to/python` to select an existing Python environment. With no
`--input`, training uses the shipped synthetic examples as a starter model.
Those examples do not establish accuracy on your work.

Each input line contains the requested work, the preceding assistant response
when needed, and your intended task category:

```json
{"prompt":"Fix the cache error","before":"","label":"fix"}
{"prompt":"yes, do that","before":"I can add a health endpoint.","label":"build"}
```

Categories are `fix`, `build`, `rewrite`, `survey`, `locate`, `explain` and
`unknown`. Label the intended deliverable, using context for approvals. A
benchmark-and-report request is a survey; a benchmark request that requires
implemented improvements can be build or fix. A method such as adversarial
review does not, by itself, establish the intended deliverable.

Set `TOKEN_OPTIMIZER_TASK_CLASSIFIER_MODEL` to the model's **absolute path** in
the coding client's environment. For example, in PowerShell:

```powershell
$env:TOKEN_OPTIMIZER_TASK_CLASSIFIER_MODEL = 'C:/Users/me/.token-optimizer/models/task-classifier.json'
```

Remove that variable to return to the rule classifier. Training does not edit
client settings or enable the model globally. The doctor reports the active
model's fingerprint and feature count, or warns that the configured model is
unavailable and the rules are being used.

## Behavior and limits

- Inputs retain at most 4,000 UTF-16 units from the current request and recent
  assistant context. The existing transcript reader enforces its 64 KiB limit.
- A weak prediction that would change task settings retains the rule fallback.
  This also protects transitions back to defaults from a rewrite or survey.
- A model posterior is a score, not a guaranteed accuracy. The trainer's
  default minimum score is 0.25; setting-changing transitions need at least
  0.85 and a 0.15 lead. Explicit output/outline settings still win.
- Missing, unreadable, oversized or incompatible models retain the fallback.
  The data-only format is dimension-checked and capped at 8 MiB.
- Models contain learned vocabulary. Keep personal models and training data
  outside your repository. Classification telemetry stores category and model
  fingerprint, never input text, vocabulary or training records.

## Validation

The development study compared a lightweight learned classifier, MiniLM
embeddings and a combined model before implementing the runtime. The smaller
word/bigram model was selected using a development split and penalizing wrong
setting changes; those development figures are not independent validation.

The 39 maintainer-labelled examples are development data. Fresh validation
must exclude their entire sessions and all training/development sessions,
freeze the model and implementation before labelling, and report both task
category accuracy and the settings actually selected. A category mistake
between fix and build currently selects the same settings; a false rewrite or
survey can change behavior.

Python/Node numerical parity, model-schema failures, deterministic guards,
shipped-hook behavior, environment overrides and telemetry privacy are checked
separately from task accuracy. Runtime classification does not establish token
savings. The product cost comparison remains subject to its pre-registered
benchmark and the model account's available quota.
