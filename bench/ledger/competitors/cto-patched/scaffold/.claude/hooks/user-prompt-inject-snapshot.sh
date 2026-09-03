#!/bin/bash
# user-prompt-inject-snapshot.sh
# EVENT: UserPromptSubmit
# DESCRIPTION: Inject the previous session snapshot into Claude's context on first prompt
#
# Claude Code UserPromptSubmit hook: reads .claude/sessions/snapshot.md (written
# by stop-session-snapshot.sh) and injects it as context Claude sees before
# answering the first prompt of each session. Zero overhead on subsequent prompts.
#
# INSTALL: cto hooks install user-prompt-inject-snapshot
# Or manually: copy to .claude/hooks/user-prompt-inject-snapshot.sh
#
# DEPENDS ON: stop-session-snapshot.sh (must be installed for snapshot to exist)

SNAPSHOT=".claude/sessions/snapshot.md"
MARKER=".claude/sessions/.snapshot-injected-$(date +%Y-%m-%d)"

# Only inject once per session day
if [ -f "$MARKER" ]; then
  exit 0
fi

mkdir -p ".claude/sessions"
touch "$MARKER"

# No snapshot yet — silent exit (first-ever session or hooks just installed)
if [ ! -f "$SNAPSHOT" ]; then
  exit 0
fi

# Check snapshot age
SNAPSHOT_AGE_HOURS=0
if command -v python3 >/dev/null 2>&1; then
  SNAPSHOT_AGE_HOURS=$(python3 -c "
import os, time
mtime = os.path.getmtime('$SNAPSHOT')
age_hours = (time.time() - mtime) / 3600
print(int(age_hours))
" 2>/dev/null || echo "0")
fi

SNAPSHOT_CONTENT=$(cat "$SNAPSHOT")

if [ "$SNAPSHOT_AGE_HOURS" -gt 24 ] 2>/dev/null; then
  # Stale but still useful — inject with caveat
  echo "--- Previous Session Snapshot (${SNAPSHOT_AGE_HOURS}h ago — may be outdated) ---"
  echo "$SNAPSHOT_CONTENT"
  echo "--- End snapshot ---"
  echo ""
  echo "💡 Snapshot injected (~${SNAPSHOT_AGE_HOURS}h old). Run: cto hooks install stop-session-snapshot  to keep it fresh." >&2
else
  # Fresh snapshot — inject cleanly
  echo "--- Previous Session Snapshot ---"
  echo "$SNAPSHOT_CONTENT"
  echo "--- End snapshot ---"
  echo ""
  echo "💡 Session snapshot injected from .claude/sessions/snapshot.md" >&2
fi

exit 0
