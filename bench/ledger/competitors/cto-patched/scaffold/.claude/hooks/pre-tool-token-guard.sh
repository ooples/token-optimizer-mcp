#!/bin/bash
# pre-tool-token-guard.sh
# EVENT: PreToolUse
# DESCRIPTION: Warn/block when auto-loaded files exceed token thresholds
#
# Claude Code PreToolUse hook: warns when auto-loaded files exceed token thresholds.
# Fires once per session (marker file prevents per-call overhead).
#
# INSTALL: cto hooks install pre-tool-token-guard
# Or manually: copy to .claude/hooks/pre-tool-token-guard.sh
#
# CONFIGURE (optional env vars in Claude Code settings):
#   CTO_WARN_TOKENS  — token count that triggers a warning  (default: 2000)
#   CTO_BLOCK_TOKENS — token count that blocks the tool call (default: 8000)

MARKER=".claude/sessions/.token-guard-checked"
WARN_TOKENS="${CTO_WARN_TOKENS:-2000}"
BLOCK_TOKENS="${CTO_BLOCK_TOKENS:-8000}"

# Only run once per session to avoid per-call latency
if [ -f "$MARKER" ]; then
  exit 0
fi

mkdir -p ".claude/sessions"

# Estimate tokens from auto-loaded files (word count × 1.3)
WORD_COUNT=$(find . -maxdepth 3 \
  \( -name "*.md" -path "./.claude/*.md" -o -path "./CLAUDE.md" -o -path "./docs/INDEX.md" \) \
  -not -path "./.claude/completions/*" \
  -not -path "./.claude/sessions/*" \
  2>/dev/null | xargs wc -w 2>/dev/null | tail -1 | awk '{print $1}')

# Mark checked so subsequent tool calls skip this
touch "$MARKER"

WORD_COUNT="${WORD_COUNT:-0}"
APPROX_TOKENS=$(echo "$WORD_COUNT * 13 / 10" | bc 2>/dev/null || echo "0")

if [ "$APPROX_TOKENS" -ge "$BLOCK_TOKENS" ] 2>/dev/null; then
  echo "🚫 Token guard: ~${APPROX_TOKENS} tokens in auto-loaded files (limit: ${BLOCK_TOKENS})" >&2
  echo "   Run: cto measure  to identify what's loading" >&2
  echo "   Run: cto audit   to find structural issues" >&2
  exit 2
elif [ "$APPROX_TOKENS" -ge "$WARN_TOKENS" ] 2>/dev/null; then
  echo "⚠️  Token warning: ~${APPROX_TOKENS} tokens in auto-loaded files (target: <${WARN_TOKENS})" >&2
  echo "   Run: cto measure  to see the breakdown" >&2
fi

exit 0
