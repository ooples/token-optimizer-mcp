#!/bin/bash
# stop-path-guard.sh
# EVENT: Stop
# DESCRIPTION: Exit 2 if the last assistant turn references file paths that don't exist
#
# Claude Code Stop hook: scans the last assistant turn for backtick-wrapped
# file paths and verifies they exist on disk. If any mentioned path is missing,
# exits 2 — forcing Claude to self-correct before the turn completes.
#
# INSTALL: cto hooks install stop-path-guard
# Or manually: copy to .claude/hooks/stop-path-guard.sh
#
# CONFIGURE (optional):
#   CTO_PATH_GUARD_DISABLE=1  — bypass all checks

if [ "${CTO_PATH_GUARD_DISABLE:-0}" = "1" ]; then
  exit 0
fi

# Read transcript path from stdin JSON
STDIN_JSON=$(cat)
TRANSCRIPT=$(echo "$STDIN_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('transcript_path', ''))
except:
    pass
" 2>/dev/null)

if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  exit 0
fi

# Extract and check paths via Python
RESULT=$(python3 - "$TRANSCRIPT" <<'PYEOF'
import sys, os, re, json

transcript_path = sys.argv[1]

# File extensions that represent real source/config files (not URLs or identifiers)
SOURCE_EXTS = {
    'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
    'sh', 'bash', 'zsh',
    'json', 'yaml', 'yml', 'toml', 'env',
    'md', 'txt', 'csv',
    'html', 'css', 'scss', 'sass',
    'sql', 'graphql',
    'Dockerfile', 'Makefile',
}

# Get last assistant turn text only
last_assistant_text = ""
try:
    with open(transcript_path) as f:
        for line in f:
            try:
                entry = json.loads(line.strip())
                if entry.get('type') == 'assistant':
                    text_parts = []
                    for block in entry.get('message', {}).get('content', []):
                        if isinstance(block, dict) and block.get('type') == 'text':
                            text_parts.append(block.get('text', ''))
                    if text_parts:
                        last_assistant_text = '\n'.join(text_parts)
            except:
                continue
except:
    sys.exit(0)

if not last_assistant_text:
    sys.exit(0)

# Extract backtick-wrapped paths: `path/to/file.ext` or `./path`
# Exclude: URLs (http/https), absolute system paths (/usr/, /etc/, ~/), template placeholders
path_pattern = re.compile(r'`([a-zA-Z0-9._/@-][a-zA-Z0-9._/\\@: -]*\.[a-zA-Z0-9]+)`')
candidates = path_pattern.findall(last_assistant_text)

missing = []
for candidate in candidates:
    # Skip URLs and system paths
    if candidate.startswith(('http://', 'https://', '/usr/', '/etc/', '/bin/', '/lib/', '~/')):
        continue
    # Skip paths with spaces (likely prose, not file paths)
    if ' ' in candidate:
        continue
    # Check extension is a known source file type
    ext = candidate.rsplit('.', 1)[-1].lower() if '.' in candidate else ''
    basename = os.path.basename(candidate)
    known = ext in SOURCE_EXTS or basename in {'Dockerfile', 'Makefile', '.env', '.gitignore', '.claudeignore'}
    if not known:
        continue
    # Skip very short paths that are likely inline code references, not file paths
    if len(candidate) < 5 or '/' not in candidate and not candidate.startswith('.'):
        continue
    # Check existence relative to cwd
    if not os.path.exists(candidate):
        missing.append(candidate)

if missing:
    print('MISSING:' + '|'.join(missing))
else:
    print('OK')
PYEOF
)

if echo "$RESULT" | grep -q '^MISSING:'; then
  MISSING_PATHS=$(echo "$RESULT" | sed 's/^MISSING://' | tr '|' '\n')
  echo "Path check failed — the following file paths were mentioned but do not exist:" >&2
  echo "$MISSING_PATHS" | while read -r p; do
    echo "  ✗ $p" >&2
  done
  echo "Please verify these paths and correct your response." >&2
  exit 2
fi

exit 0
