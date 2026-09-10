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

# THE RESULTS VOLUME IS A KNOB because the knowledge arm needs two passes and
# only ONE of them is evidence.
#
# The proxy loads the graph once, at startup, since a block that changes
# mid-session cannot live in a cached prefix. So a first pass against an empty
# graph injects nothing and measures exactly the plain proxy arm. It exists to
# WRITE the graph, and its run rows are not results -- they are the warm-up.
#
# Keeping them out of the real database is not tidiness: runner.py resumes by
# skipping runs already recorded for a campaign label, so warm-up rows in the
# real volume would make the measured pass a no-op that reports the cold
# numbers as if they were warm.
RESULTS_VOLUME="${RESULTS_VOLUME:-thol-results}"

# ...and the graph itself is a HOST directory, mounted into whichever results
# volume is in play, so it is the one thing that survives from the warm-up pass
# into the measured one.
PROXY_GRAPH_DIR="${PROXY_GRAPH_DIR:-$RIG_DIR/thol/proxy-graph}"

# Cheapest first. The last group is the $5/run outlier, isolated so it can be
# dropped with SEGMENTS_MAX=4 without touching the rest.
SEG_1="${SEG_1:-code-bugfix-py,code-refactor-split-py,log-needle-zh,code-iterate-tests}"
SEG_2="${SEG_2:-code-feature-js,code-migration-py-xl,code-migration-py,code-feature-validate-py}"
SEG_3="${SEG_3:-seo-audit,report-pdf,code-overview-cobra,code-settings-inventory-django}"
SEG_4="${SEG_4:-code-comprehension-django,code-debug-pipeline-py,code-debug-ledger-py,code-debug-cascade-py}"
SEG_5="${SEG_5:-web-research-oss-inventory}"
SEGMENTS=("$SEG_1" "$SEG_2" "$SEG_3" "$SEG_4" "$SEG_5")
SEGMENTS_MAX="${SEGMENTS_MAX:-5}"

log() { printf '\n\033[1;36m>> %s\033[0m\n' "$*"; }

stage_credentials() {
  # auth/ is gitignored, so it does not exist on a fresh clone. 0700 so the
  # directory cannot be listed by other local users even before the file lands.
  mkdir -p "$RIG_DIR/auth"
  chmod 700 "$RIG_DIR/auth" 2>/dev/null || true
  [ -f "$HOST_CREDS" ] || { echo "!! no host credentials at $HOST_CREDS" >&2; exit 1; }
  node -e "
    const fs=require('fs');
    const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
    if(!c.claudeAiOauth) throw new Error('no claudeAiOauth in host credentials');
    // Only the login block leaves the host. MCP OAuth secrets for unrelated
    // servers (github, supabase) stay put.
    //
    // MODE 0600, AND CREATED THAT WAY RATHER THAN CHMODDED AFTERWARDS. The
    // default is 0666 masked by umask, so on a multi-user host every local
    // account could read a live OAuth access and refresh token. Passing the
    // mode to writeFileSync closes the window in which a world-readable file
    // exists at all; chmod after the write leaves one.
    //
    // The mode only applies on creation, so an existing loose file is fixed
    // explicitly below.
    const out = process.argv[2];
    fs.writeFileSync(out, JSON.stringify({claudeAiOauth:c.claudeAiOauth},null,2)+'\n', { mode: 0o600 });
    try { fs.chmodSync(out, 0o600); } catch { /* Windows has no POSIX modes */ }
    const left=(c.claudeAiOauth.expiresAt-Date.now())/60000;
    console.log('   token valid for ~'+left.toFixed(0)+' min');
    if(left<20) console.log('   WARNING: token expires soon; open Claude Code on the host to refresh it');
  " "$HOST_CREDS" "$RIG_DIR/auth/credentials.json"
}

# The staged copy is a live credential. Remove it when the campaign ends, however
# it ends -- an earlier version left it lying in the working tree, where a later
# `git add -A` on a branch without bench/.gitignore committed it to a public
# repository.
cleanup_credentials() {
  rm -f "$RIG_DIR/auth/credentials.json" 2>/dev/null || true
}
trap cleanup_credentials EXIT INT TERM

mkdir -p "$PROXY_GRAPH_DIR/.token-optimizer/wiki"

log "Results volume: $RESULTS_VOLUME"
log "Proxy graph:    $PROXY_GRAPH_DIR"

for i in "${!SEGMENTS[@]}"; do
  n=$((i+1))
  [ "$n" -le "$SEGMENTS_MAX" ] || { log "Stopping before segment $n (SEGMENTS_MAX=$SEGMENTS_MAX)"; break; }
  tasks="${SEGMENTS[$i]}"

  log "Segment $n/$SEGMENTS_MAX -- re-staging credentials"
  stage_credentials

  log "Segment $n/$SEGMENTS_MAX -- tasks: $tasks"
  MSYS_NO_PATHCONV=1 docker run --rm \
    -v "$RIG_DIR/auth:/auth:ro" \
    -v "$RESULTS_VOLUME:/results" \
    -v "$PROXY_GRAPH_DIR:/results/proxy-graph" \
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
  -v "$RESULTS_VOLUME:/results" \
  -v "$PROXY_GRAPH_DIR:/results/proxy-graph" \
  -e THOL_CAMPAIGN="$CAMPAIGN" \
  "$IMAGE" report
