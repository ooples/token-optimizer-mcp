#!/bin/bash
# user-prompt-inject-context.sh
# EVENT: UserPromptSubmit
# DESCRIPTION: Auto-inject matching docs/learnings/ files based on prompt keywords
#
# Claude Code UserPromptSubmit hook: auto-loads topic docs from docs/learnings/
# based on keywords in the user's prompt. stdout is injected as context Claude
# sees before answering — zero token cost when the file isn't relevant.
#
# INSTALL: cto hooks install user-prompt-inject-context
# Or manually: copy to .claude/hooks/user-prompt-inject-context.sh
#
# CONFIGURE (optional env vars):
#   CTO_LEARNINGS_DIR    — path to learnings dir (default: docs/learnings)
#   CTO_MAX_INJECT_FILES — max files to inject per prompt (default: 3)
#   CTO_MAX_INJECT_WORDS — max total words to inject (default: 1500, ~2000 tokens)

LEARNINGS_DIR="${CTO_LEARNINGS_DIR:-docs/learnings}"
MAX_FILES="${CTO_MAX_INJECT_FILES:-3}"
MAX_WORDS="${CTO_MAX_INJECT_WORDS:-1500}"

# Read stdin JSON to get the user prompt
STDIN_JSON=$(cat)
PROMPT=$(echo "$STDIN_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('prompt', ''))
except:
    pass
" 2>/dev/null)

if [ -z "$PROMPT" ] || [ ! -d "$LEARNINGS_DIR" ]; then
  exit 0
fi

# Find matching topic files using Python for robust matching
INJECTED=$(python3 - "$LEARNINGS_DIR" "$MAX_FILES" "$MAX_WORDS" "$PROMPT" <<'PYEOF'
import sys, os, re

learnings_dir = sys.argv[1]
max_files = int(sys.argv[2])
max_words = int(sys.argv[3])
prompt = sys.argv[4].lower()

# Extract meaningful words from prompt (>4 chars, skip stop words)
stop = {'this','that','with','from','have','will','been','they','what',
        'when','where','which','their','there','about','would','could',
        'should','into','your','more','also','than','then','only','some'}
words = set(w for w in re.findall(r'[a-z][a-z0-9_-]{3,}', prompt) if w not in stop)

if not words:
    sys.exit(0)

# Find .md files in learnings dir
try:
    files = [f for f in os.listdir(learnings_dir) if f.endswith('.md')]
except:
    sys.exit(0)

# Score each file by how many prompt words appear in its stem
def score(filename):
    stem = re.sub(r'\.md$', '', filename).lower().replace('-', ' ').replace('_', ' ')
    stem_words = set(stem.split())
    # Also check individual chars for abbreviations (e.g. "db" matches "database")
    return sum(1 for w in words if w in stem or any(w.startswith(sw) for sw in stem_words))

scored = [(score(f), f) for f in files]
scored = [(s, f) for s, f in scored if s > 0]
scored.sort(key=lambda x: -x[0])
matches = [f for _, f in scored[:max_files]]

if not matches:
    sys.exit(0)

total_words = 0
injected = []
for fname in matches:
    path = os.path.join(learnings_dir, fname)
    try:
        content = open(path).read()
        wcount = len(content.split())
        if total_words + wcount > max_words:
            # Truncate to fit within budget
            words_list = content.split()
            available = max_words - total_words
            if available < 50:
                break
            content = ' '.join(words_list[:available]) + '\n\n[... truncated to fit token budget]'
            wcount = available
        injected.append((fname, path, content, wcount))
        total_words += wcount
    except:
        continue

for fname, path, content, wcount in injected:
    print(f'--- Context loaded from {learnings_dir}/{fname} ---')
    print(content)
    print(f'--- End of {fname} ---')
    print()

# Stderr notice (user sees this, not Claude)
import sys as _sys
for fname, path, content, wcount in injected:
    approx_tokens = int(wcount * 1.3)
    print(f'💡 Auto-loaded: {learnings_dir}/{fname} (~{approx_tokens} tokens)', file=_sys.stderr)
PYEOF
)

if [ -n "$INJECTED" ]; then
  echo "$INJECTED"
fi

exit 0
