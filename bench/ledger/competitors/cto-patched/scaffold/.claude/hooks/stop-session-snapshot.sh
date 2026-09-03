#!/bin/bash
# stop-session-snapshot.sh
# EVENT: Stop
# DESCRIPTION: Write a session snapshot to .claude/sessions/snapshot.md after each turn
#
# Claude Code Stop hook: captures changed files, recent commits, and token
# estimate into a compact snapshot. The snapshot is injected at the start of
# the next session by user-prompt-inject-snapshot.sh (or via CLAUDE.md @ import).
#
# INSTALL: cto hooks install stop-session-snapshot
# Or manually: copy to .claude/hooks/stop-session-snapshot.sh

SNAPSHOT=".claude/sessions/snapshot.md"
DATE=$(date +"%Y-%m-%d %H:%M")

mkdir -p ".claude/sessions"

# --- Changed files (unstaged + staged + last commit) ---
CHANGED_FILES=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  # Uncommitted changes
  UNSTAGED=$(git diff --name-only 2>/dev/null)
  STAGED=$(git diff --cached --name-only 2>/dev/null)
  # Files changed in last commit
  LAST_COMMIT=$(git diff --name-only HEAD~1 2>/dev/null)

  ALL_CHANGED=$(printf '%s\n%s\n%s\n' "$UNSTAGED" "$STAGED" "$LAST_COMMIT" \
    | sort -u | grep -v '^$' | head -10)

  if [ -n "$ALL_CHANGED" ]; then
    CHANGED_FILES=$(echo "$ALL_CHANGED" | awk '{print "- " $0}')
  fi
fi

# --- Recent commits ---
GIT_LOG=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  GIT_LOG=$(git log --oneline -5 2>/dev/null | head -5)
fi

# --- Token estimate for auto-loaded files ---
WORD_COUNT=$(find . -maxdepth 3 \
  \( -name "*.md" -path "./.claude/*.md" -o -path "./CLAUDE.md" -o -path "./docs/INDEX.md" \) \
  -not -path "./.claude/completions/*" \
  -not -path "./.claude/sessions/*" \
  2>/dev/null | xargs wc -w 2>/dev/null | tail -1 | awk '{print $1}')
WORD_COUNT="${WORD_COUNT:-0}"
APPROX_TOKENS=$(echo "$WORD_COUNT * 13 / 10" | bc 2>/dev/null || echo "?")

# --- Last task context from transcript ---
LAST_TASK=""
STDIN_JSON=$(cat)
TRANSCRIPT=$(echo "$STDIN_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('transcript_path', ''))
except:
    pass
" 2>/dev/null)

if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  # Extract last assistant message text (last 120 chars of last assistant turn)
  LAST_TASK=$(python3 - "$TRANSCRIPT" <<'PYEOF'
import sys, json

transcript_path = sys.argv[1]
last_text = ""
try:
    with open(transcript_path) as f:
        for line in f:
            try:
                entry = json.loads(line)
                if entry.get('type') == 'assistant':
                    for block in entry.get('message', {}).get('content', []):
                        if isinstance(block, dict) and block.get('type') == 'text':
                            last_text = block.get('text', '')
            except:
                continue
except:
    pass

# Take the last meaningful line (skip blank lines)
lines = [l.strip() for l in last_text.strip().splitlines() if l.strip()]
if lines:
    summary = lines[-1][:120]
    print(summary)
PYEOF
)
fi

# --- Write snapshot ---
{
  echo "# Session Snapshot — ${DATE}"
  echo ""

  if [ -n "$CHANGED_FILES" ]; then
    echo "## Files Changed"
    echo "$CHANGED_FILES"
    echo ""
  fi

  if [ -n "$GIT_LOG" ]; then
    echo "## Recent Commits"
    echo "$GIT_LOG" | awk '{print "- " $0}'
    echo ""
  fi

  echo "## Token Estimate"
  echo "~${APPROX_TOKENS} tokens in auto-loaded files"
  echo ""

  if [ -n "$LAST_TASK" ]; then
    echo "## Last Turn"
    echo "$LAST_TASK"
    echo ""
  fi
} > "$SNAPSHOT"

exit 0
