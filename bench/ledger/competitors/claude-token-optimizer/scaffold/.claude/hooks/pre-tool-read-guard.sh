#!/bin/bash
# pre-tool-read-guard.sh
# EVENT: PreToolUse
# DESCRIPTION: Block reads of lock files, minified JS, binaries, and oversized files
#
# Claude Code PreToolUse hook: blocks or warns when Claude tries to Read files
# that are too large or obviously wasteful (lock files, minified JS, binaries).
#
# INSTALL: cto hooks install pre-tool-read-guard
# Or manually: copy to .claude/hooks/pre-tool-read-guard.sh
#
# CONFIGURE (optional env vars):
#   CTO_READ_MAX_BYTES      — block threshold in bytes (default: 51200 = 50KB)
#   CTO_READ_WARN_BYTES     — warn threshold in bytes  (default: 10240 = 10KB)
#   CTO_READ_GUARD_DISABLE  — set to 1 to bypass all guards

# Bypass switch
if [ "${CTO_READ_GUARD_DISABLE:-0}" = "1" ]; then
  exit 0
fi

# Only fire on Read tool
TOOL_NAME="${CLAUDE_TOOL_NAME:-}"
if [ "$TOOL_NAME" != "Read" ]; then
  exit 0
fi

READ_MAX_BYTES="${CTO_READ_MAX_BYTES:-51200}"
READ_WARN_BYTES="${CTO_READ_WARN_BYTES:-10240}"

# Extract file_path from stdin JSON
FILE_PATH=$(cat | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('tool_input', {}).get('file_path', ''))
except:
    pass
" 2>/dev/null)

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# --- Extension-based block rules (fast, no disk access) ---
BASENAME=$(basename "$FILE_PATH")
EXT="${BASENAME##*.}"

case "$BASENAME" in
  package-lock.json|yarn.lock|pnpm-lock.yaml|Cargo.lock|poetry.lock|Gemfile.lock|composer.lock)
    echo "🚫 Read blocked: '$FILE_PATH' is a lock file (~10,000–50,000 tokens)." >&2
    echo "   Lock files are auto-generated and wasteful to read directly." >&2
    echo "   Use: cat package.json | python3 -m json.tool  for dependency info" >&2
    echo "   Override: CTO_READ_GUARD_DISABLE=1" >&2
    exit 2
    ;;
esac

case "$EXT" in
  min.js|min.css)
    echo "🚫 Read blocked: '$FILE_PATH' is a minified file (~high token count)." >&2
    echo "   Read the source file instead." >&2
    exit 2
    ;;
  snap)
    echo "🚫 Read blocked: '$FILE_PATH' is a test snapshot file." >&2
    echo "   Snapshots are generated output — read the test source instead." >&2
    exit 2
    ;;
  pb.go|pb)
    echo "🚫 Read blocked: '$FILE_PATH' appears to be a protobuf-generated file." >&2
    echo "   Read the .proto source file instead." >&2
    exit 2
    ;;
  pyc|pyo|class|o|a|so|dylib|dll|exe|wasm)
    echo "🚫 Read blocked: '$FILE_PATH' is a compiled binary file." >&2
    exit 2
    ;;
esac

# --- Size-based rules (requires file to exist) ---
if [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

FILE_BYTES=$(wc -c < "$FILE_PATH" 2>/dev/null || echo "0")

if [ "$FILE_BYTES" -ge "$READ_MAX_BYTES" ] 2>/dev/null; then
  FILE_KB=$((FILE_BYTES / 1024))
  APPROX_TOKENS=$((FILE_BYTES / 4))
  echo "🚫 Read blocked: '$FILE_PATH' is ${FILE_KB}KB (~${APPROX_TOKENS} tokens, limit: $((READ_MAX_BYTES / 1024))KB)." >&2
  echo "   Use Read with offset/limit params, or: head -100 '$FILE_PATH'" >&2
  echo "   Override: CTO_READ_GUARD_DISABLE=1  or raise CTO_READ_MAX_BYTES" >&2
  exit 2
elif [ "$FILE_BYTES" -ge "$READ_WARN_BYTES" ] 2>/dev/null; then
  FILE_KB=$((FILE_BYTES / 1024))
  APPROX_TOKENS=$((FILE_BYTES / 4))
  echo "⚠️  Large file: '$FILE_PATH' is ${FILE_KB}KB (~${APPROX_TOKENS} tokens). Reading..." >&2
  echo "   Consider: Read with offset/limit to read only the relevant section." >&2
fi

exit 0
