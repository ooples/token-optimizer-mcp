# Local THOL tasks

Tasks this rig runs **in addition to** the pinned upstream THOL task set. They
are not on the public THOL board, and any result that includes them must say so.

Why they exist: upstream's 17 tasks contain nothing in some category this
product handles differently. The first is **REWRITE**: a whole file restated,
behaviour unchanged. That category turns outline substitution off
(`src/hooks-core/task-settings.mjs`), and without a task in it, the setting has
no board evidence either way.

| Task | Category | What it measures |
|---|---|---|
| `code-rewrite-modernize-py` | rewrite | Modernise a 120-function, ~21 KB legacy module (f-strings, `is None`, no `object` base, full type hints), with frozen tests that must stay green. The file is past the outline floor, so outline substitution is in play. |

Rules, following upstream's CONTRIBUTING.md:

- `verify.py` scores 0-1 from truth the agent never sees (`fixtures/truth`).
- An untouched workspace scores exactly 0.
- A task is frozen before the campaign that first uses it.
- `gen_local_fixtures.py` is deterministic and writes only what is absent.
- The entrypoint runs it after upstream's generators.

Contributing a task upstream is a separate, deliberate step: a PR to THOL.
