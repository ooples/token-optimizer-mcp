#!/bin/bash
# pre-tool-bash-guard.sh
# EVENT: PreToolUse
# DESCRIPTION: Block dangerous Bash patterns that fill context (find /, cat node_modules, etc.)
#
# Claude Code PreToolUse hook: intercepts Bash tool calls and blocks or warns
# on commands likely to produce massive output and exhaust context.
#
# Blocked (exit 2): find from /, cat node_modules, bare recursive grep with no path
# Warned (exit 0 + stderr): log file globs, glob cat, unscoped find without -maxdepth
#
# CONFIGURE:
#   CTO_BASH_GUARD_DISABLE=1  — bypass all checks

if [ "${CTO_BASH_GUARD_DISABLE:-0}" = "1" ]; then
  exit 0
fi

# Only intercept Bash tool calls
TOOL_NAME="${CLAUDE_TOOL_NAME:-}"
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

CMD=$(cat | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('tool_input', {}).get('command', ''))
except Exception:
    pass
" 2>/dev/null)

if [ -z "$CMD" ]; then
  exit 0
fi

# ── BLOCKED PATTERNS (exit 2) ────────────────────────────────────────────

if echo "$CMD" | grep -qE 'find\s+/(\s|$)'; then
  echo "🚫 Bash scope guard: 'find /' searches the full filesystem." >&2
  echo "   This produces thousands of results and fills your context." >&2
  echo "   Use: find . -maxdepth 3 ...  instead." >&2
  exit 2
fi

if echo "$CMD" | grep -qE 'cat\s+.*node_modules/'; then
  echo "🚫 Bash scope guard: reading node_modules/ files wastes significant context." >&2
  echo "   Check package docs or use: npm info <package>  instead." >&2
  exit 2
fi

# bare grep -r "pattern" with no path (pattern ends the command)
if echo "$CMD" | grep -qP '(?:^|\|)\s*grep\s+(?:-\w*[rR]\w*|-[^\s]*[rR])\s+"[^"]+"\s*$' 2>/dev/null; then
  echo "🚫 Bash scope guard: 'grep -r' without a path scope scans the entire tree." >&2
  echo "   Add a path: grep -r \"pattern\" src/  or  grep -r \"pattern\" ." >&2
  exit 2
fi

# ── WARNED PATTERNS (exit 0 + stderr) ────────────────────────────────────

if echo "$CMD" | grep -qE 'find\s+.*-name\s+['\''"]?\*\.log'; then
  echo "⚠️  Large output possible: log files can be very large." >&2
  echo "   Add | head -50  to cap output, or use: tail -100 <logfile>" >&2
fi

if echo "$CMD" | grep -qE '\bcat\s+\*\.'; then
  echo "⚠️  Large output possible: 'cat *.<ext>' may expand to many files." >&2
  echo "   Add | head -100  to cap output if you don't need everything." >&2
fi

# find . without -maxdepth
if echo "$CMD" | grep -qE '\bfind\s+\.' && ! echo "$CMD" | grep -q '\-maxdepth'; then
  echo "⚠️  Broad find: consider adding -maxdepth 3 to limit recursion depth." >&2
fi

exit 0
