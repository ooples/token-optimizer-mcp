#!/usr/bin/env bash
# Screen the knowledge-injection hypothesis: does putting what this project
# already worked out into the cached prefix save the model TURNS?
#
# TWO PASSES, AND THE FIRST ONE IS NOT EVIDENCE.
#
# The proxy loads the graph once, at startup, because a block that changes
# mid-session cannot live in a cached prefix -- re-reading per request would
# spend I/O to produce a value the cache rules immediately discard. So a
# campaign run against an empty graph injects nothing and measures exactly the
# plain proxy arm, while looking like a real comparison. That is the failure
# this script exists to prevent, and it is silent: nothing errors, the numbers
# come out plausible, and the conclusion is "the graph does nothing".
#
#   pass 1  warm-up   knowledge arm, throwaway results volume, shared graph dir
#   pass 2  measured  knowledge arm and plain proxy arm, real results volume
#
# The graph is a HOST directory mounted into both, so it is the one thing that
# survives between them. The warm-up's run rows go to a separate volume for a
# reason that is not tidiness: runner.py resumes by skipping runs already
# recorded for a campaign label, so leaving them in the real volume would make
# the measured pass a no-op reporting the COLD numbers as warm.
#
# Usage:
#   bash bench/thol/screen-knowledge.sh
#   TASKS=code-bugfix-py bash bench/thol/screen-knowledge.sh   # cheaper still

set -euo pipefail

RIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Segment 1 of the full battery: the four cheapest tasks, which is where a
# turn-count effect is easiest to see -- a saved turn is a larger fraction of a
# short task. The $5.01/run web-research outlier is deliberately not here.
TASKS="${TASKS:-code-bugfix-py,code-refactor-split-py,log-needle-zh,code-iterate-tests}"
REPS="${REPS:-1}"
WARMUP_VOLUME="${WARMUP_VOLUME:-thol-knowledge-warmup}"
MEASURED_VOLUME="${MEASURED_VOLUME:-thol-knowledge-screen}"
PROXY_GRAPH_DIR="${PROXY_GRAPH_DIR:-$RIG_DIR/thol/proxy-graph}"

log() { printf '\n\033[1;36m>> %s\033[0m\n' "$*"; }

if [ "${FRESH_GRAPH:-1}" = "1" ]; then
  # A graph left over from an earlier screen would make pass 1 pointless and
  # pass 2 unattributable -- the injected findings would come from a run
  # nobody recorded.
  log "Clearing the proxy graph so the warm-up is the only thing that fills it"
  rm -rf "$PROXY_GRAPH_DIR"
fi
mkdir -p "$PROXY_GRAPH_DIR/.token-optimizer/wiki"

log "PASS 1 of 2 -- warm-up. These runs are NOT results; they fill the graph."
RESULTS_VOLUME="$WARMUP_VOLUME" \
PROXY_GRAPH_DIR="$PROXY_GRAPH_DIR" \
ARMS="token-optimizer-proxy-knowledge" \
REPS="$REPS" \
SEG_1="$TASKS" SEGMENTS_MAX=1 \
  bash "$RIG_DIR/thol/run-campaign.sh" "$@"

# PROVE THE WARM-UP ACTUALLY WROTE SOMETHING before paying for pass 2. An empty
# graph here means pass 2 would measure the plain proxy arm twice under two
# different names, which is the exact silent failure described above.
nodes=$(find "$PROXY_GRAPH_DIR/.token-optimizer/wiki" -type f 2>/dev/null | wc -l | tr -d ' ')
log "Graph after warm-up: $nodes file(s) under $PROXY_GRAPH_DIR/.token-optimizer/wiki"
if [ "$nodes" = "0" ]; then
  echo "!! The warm-up wrote no graph, so the measured pass would inject nothing" >&2
  echo "   and report the plain proxy arm's numbers as the knowledge arm's." >&2
  echo "   Check that the arm's TOKEN_OPTIMIZER_WIKI_DIR points inside" >&2
  echo "   /results/proxy-graph and that the hooks ran." >&2
  exit 1
fi

log "PASS 2 of 2 -- measured. Knowledge arm now starts against a warm graph."
RESULTS_VOLUME="$MEASURED_VOLUME" \
PROXY_GRAPH_DIR="$PROXY_GRAPH_DIR" \
ARMS="control,token-optimizer-proxy,token-optimizer-proxy-knowledge" \
REPS="$REPS" \
SEG_1="$TASKS" SEGMENTS_MAX=1 \
  bash "$RIG_DIR/thol/run-campaign.sh" "$@"

log "Screen complete. Compare token-optimizer-proxy-knowledge against"
log "token-optimizer-proxy: the difference between them IS the injection."
log "Against control it is the injection plus the compression plus the hooks."
