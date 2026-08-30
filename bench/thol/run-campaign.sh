#!/usr/bin/env bash
# Host-side campaign orchestrator (run from Git Bash on Windows).
#
# Why this exists rather than one long `docker run`:
#
# 1. CREDENTIAL EXPIRY. Claude Code's OAuth access token is short-lived (the
#    one staged for this rig had ~2.5h left). THOL copies credentials into a
#    THROWAWAY HOME per run (runner.py:129), so when a sandbox refreshes the
#    token the new value dies with that sandbox -- every later run re-refreshes
#    from the same increasingly stale token. A 4-6h campaign therefore cannot
#    survive on one staging. We re-stage from the host's live credentials
#    between segments, and the host's token stays fresh because the host
#    Claude Code refreshes it in normal use.
#
# 2. RESUMABILITY. runner.py resumes from results.sqlite and skips runs already
#    recorded for the campaign label, so segmenting costs nothing and an
#    interrupted segment can simply be re-run.
#
# 3. COST ORDERING. Tasks run cheapest-first so the signal arrives before the
#    money does. web-research-oss-inventory alone is ~$5.01/run -- over half
#    the battery's cost -- so it is deliberately last and easy to skip.
#
# Runs are SERIAL by design. Parallel containers would contend for rate limits
# and distort both wall-clock and cost, which are two of the three things the
# benchmark measures.

set -euo pipefail

RIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Matches what `npm run bench:build` tags. A version-pinned default here
# silently used a stale image after the build script was added.
IMAGE="${IMAGE:-thol-rig:local}"
CAMPAIGN="${THOL_CAMPAIGN:-2.1.251 (Claude Code)}"
REPS="${REPS:-3}"
ARMS="${ARMS:-control,token-optimizer-mcp,token-optimizer-mcp-off}"
HOST_CREDS="${HOST_CREDS:-$HOME/.claude/.credentials.json}"

# Cheapest first. The last group is the $5/run outlier, isolated so it can be
# dropped with SEGMENTS_MAX=4 without touching the rest.
SEG_1="code-bugfix-py,code-refactor-split-py,log-needle-zh,code-iterate-tests"
SEG_2="code-feature-js,code-migration-py-xl,code-migration-py,code-feature-validate-py"
SEG_3="seo-audit,report-pdf,code-overview-cobra,code-settings-inventory-django"
SEG_4="code-comprehension-django,code-debug-pipeline-py,code-debug-ledger-py,code-debug-cascade-py"
SEG_5="web-research-oss-inventory"
SEGMENTS=("$SEG_1" "$SEG_2" "$SEG_3" "$SEG_4" "$SEG_5")
SEGMENTS_MAX="${SEGMENTS_MAX:-5}"

log() { printf '\n\033[1;36m>> %s\033[0m\n' "$*"; }

stage_credentials() {
  # auth/ is gitignored, so it does not exist on a fresh clone.
  mkdir -p "$RIG_DIR/auth"
  [ -f "$HOST_CREDS" ] || { echo "!! no host credentials at $HOST_CREDS" >&2; exit 1; }
  node -e "
    const fs=require('fs');
    const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
    if(!c.claudeAiOauth) throw new Error('no claudeAiOauth in host credentials');
    // Only the login block leaves the host. MCP OAuth secrets for unrelated
    // servers (github, supabase) stay put.
    fs.writeFileSync(process.argv[2], JSON.stringify({claudeAiOauth:c.claudeAiOauth},null,2)+'\n');
    const left=(c.claudeAiOauth.expiresAt-Date.now())/60000;
    console.log('   token valid for ~'+left.toFixed(0)+' min');
    if(left<20) console.log('   WARNING: token expires soon; open Claude Code on the host to refresh it');
  " "$HOST_CREDS" "$RIG_DIR/auth/credentials.json"
}

for i in "${!SEGMENTS[@]}"; do
  n=$((i+1))
  [ "$n" -le "$SEGMENTS_MAX" ] || { log "Stopping before segment $n (SEGMENTS_MAX=$SEGMENTS_MAX)"; break; }
  tasks="${SEGMENTS[$i]}"

  log "Segment $n/$SEGMENTS_MAX -- re-staging credentials"
  stage_credentials

  log "Segment $n/$SEGMENTS_MAX -- tasks: $tasks"
  MSYS_NO_PATHCONV=1 docker run --rm \
    -v "$RIG_DIR/auth:/auth:ro" \
    -v thol-results:/results \
    -e THOL_CAMPAIGN="$CAMPAIGN" \
    --name thol-campaign "$IMAGE" campaign \
      -c "$ARMS" \
      -t "$tasks" \
      --reps "$REPS" \
      "$@"
done

log "Campaign complete -- building final leaderboard"
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$RIG_DIR/auth:/auth:ro" \
  -v thol-results:/results \
  -e THOL_CAMPAIGN="$CAMPAIGN" \
  "$IMAGE" report
