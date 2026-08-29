# Security Policy

## Supported Versions

Only the latest published minor line receives security fixes. This project
releases from `master` with Release Please, and there are no maintenance
branches, so a fix ships as a new patch release rather than a backport.

| Version | Supported          |
| ------- | ------------------ |
| 6.0.x   | :white_check_mark: |
| < 6.0   | :x:                |

If you are pinned to an older line, the upgrade path is `npm install -g token-optimizer-mcp@latest`.

## Reporting a Vulnerability

Use GitHub's private vulnerability reporting, which is enabled on this
repository: **[Report a vulnerability](https://github.com/ooples/token-optimizer-mcp/security/advisories/new)**.
That opens a private advisory visible only to the maintainers.

Please do not open a public issue for something you believe is exploitable.

What to expect:

- **Acknowledgement** within a few days.
- **An assessment** — accepted, or declined with the reasoning — once the
  report has been read against the source.
- **A fix released** as a patch version if accepted, with credit in the
  release notes unless you ask otherwise.

Static-analysis output, audits and hardening suggestions that are *not*
exploitable are welcome as ordinary public issues; [#343](https://github.com/ooples/token-optimizer-mcp/issues/343)
is the model for that.

## Trust model

This is a local MCP server. It runs as the user who starts it, on that user's
machine, and its tools act with that user's full privileges. Two consequences
are worth stating plainly, because a tool name does not convey them:

- **`smart_process` (`start` operation) launches an arbitrary executable** of
  the caller's choosing, with caller-supplied arguments, working directory and
  environment. It runs in argv mode with no shell, so there is no command
  injection — but granting it is equivalent to granting local command
  execution. Operators who want monitoring only should expose `smart_processes`
  instead.
- **The file tools (`smart_read`, `smart_write`, `smart_edit`, `smart_glob`,
  `smart_grep`) take arbitrary paths** and are not confined to a project root.
  They can read and write anywhere the user can.

Neither is a vulnerability; both are the point of the respective tools. They
are listed here so the decision to wire this server into an autonomous agent is
made with the scope visible.

Process execution inside the tool surface goes through `src/utils/safe-exec.ts`,
which is argv-mode and `shell: false` by construction. String-concatenated
commands, `shell: true`, and interpolated `execSync` must not be reintroduced in
tool code.
