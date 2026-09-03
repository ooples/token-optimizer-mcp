#!/bin/bash
# notification-token-display.sh
# EVENT: Notification
# DESCRIPTION: Show auto-loaded token estimate once per session on first notification
#
# Claude Code Notification hook: appends a token budget summary to the first
# notification of each session. Subsequent notifications exit silently.
# Cached in .claude/sessions/.notification-token-cache to avoid recomputing.

CACHE_FILE=".claude/sessions/.notification-token-cache"
SESSION_MARKER=".claude/sessions/.notification-shown-$(date +%Y-%m-%d)"

# Already shown today — stay silent
if [ -f "$SESSION_MARKER" ]; then
  exit 0
fi

mkdir -p ".claude/sessions"

# Compute token estimate if cache missing or stale (older than today)
if [ ! -f "$CACHE_FILE" ] || [ "$(find "$CACHE_FILE" -mtime +0 2>/dev/null)" ]; then
  WORD_COUNT=$(find . -maxdepth 3 \
    \( -name "*.md" -path "./.claude/*.md" -o -path "./CLAUDE.md" -o -path "./docs/INDEX.md" \) \
    -not -path "./.claude/completions/*" \
    -not -path "./.claude/sessions/*" \
    2>/dev/null | xargs wc -w 2>/dev/null | tail -1 | awk '{print $1}')
  WORD_COUNT="${WORD_COUNT:-0}"
  APPROX_TOKENS=$(echo "$WORD_COUNT * 13 / 10" | bc 2>/dev/null || echo "0")
  echo "$APPROX_TOKENS" > "$CACHE_FILE"
else
  APPROX_TOKENS=$(cat "$CACHE_FILE")
fi

touch "$SESSION_MARKER"

# Format with thousands separator via awk
FORMATTED=$(echo "$APPROX_TOKENS" | awk '{
  n = $1; s = ""
  while (n > 999) { s = "," sprintf("%03d", n % 1000) s; n = int(n/1000) }
  print n s
}')

echo "📊 Session context: ~${FORMATTED} tokens in auto-loaded files" >&2

exit 0
