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
  # A graph left over from an earlier screen would make pass 1 pointless and pass 2
  # unattributable -- the injected findings would come from a run nobody recorded.
  #
  # THE WARM-UP VOLUME GOES WITH IT, and that pairing is load-bearing. runner.py
  # resumes by skipping runs already recorded for a campaign label, so clearing the
  # graph while keeping the volume gives a pass 1 with nothing to run and a graph
  # nothing refills -- pass 2 would then start cold under a name that says warm. The
  # gate below catches it, but only after the operator has waited for a pass that did
  # nothing.
  log "Clearing the proxy graph and the warm-up volume so pass 1 genuinely refills it"
  rm -rf "$PROXY_GRAPH_DIR"
  docker volume rm "$WARMUP_VOLUME" >/dev/null 2>&1 || true
fi
mkdir -p "$PROXY_GRAPH_DIR/.token-optimizer/wiki"

log "PASS 1 of 2 -- warm-up. These runs are NOT results; they fill the graph."
RESULTS_VOLUME="$WARMUP_VOLUME" \
PROXY_GRAPH_DIR="$PROXY_GRAPH_DIR" \
ARMS="token-optimizer-proxy-knowledge" \
REPS="$REPS" \
SEG_1="$TASKS" SEGMENTS_MAX=1 \
  bash "$RIG_DIR/thol/run-campaign.sh" "$@"

# PROVE THE WARM-UP WROTE THE THING THAT GETS INJECTED, not merely that it wrote.
#
# COUNTING FILES WAS NOT ENOUGH, and this gate passed while measuring nothing. The
# warm-up produced 9 files and 445KB across graph/evidence/metrics/snapshots -- and
# zero nodes carrying a `claim`, which is the only field `loadFindings` keeps. The
# knowledge arm therefore injected an empty block, was byte-for-byte the plain proxy
# arm, and returned identical turn counts on all four tasks. A null result that was
# really an unrun experiment.
#
# Structure is not findings. The graph captures files, symbols and edges from ordinary
# tool use; a FINDING is written by the semantic harvest when a model concludes
# something durable, and short benchmark tasks do not produce any.
findings=$(node -e '
  const fs = require("fs");
  const dir = process.argv[1];
  let active = 0;
  try {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
      for (const line of fs.readFileSync(dir + "/" + f, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const node = JSON.parse(line);
          if (typeof node.claim === "string" && !node.retired) active += 1;
        } catch {}
      }
    }
  } catch {}
  process.stdout.write(String(active));
' "$PROXY_GRAPH_DIR/.token-optimizer/wiki" 2>/dev/null || echo 0)

log "Graph after warm-up: $findings active finding(s) with a claim"
if [ "${findings:-0}" = "0" ]; then
  echo "!! The warm-up produced no FINDINGS, only graph structure, so the measured" >&2
  echo "   pass would inject an empty block and report the plain proxy arm's numbers" >&2
  echo "   as the knowledge arm's -- an unrun experiment that looks like a null." >&2
  echo "" >&2
  echo "   Findings come from the semantic harvest, not from tool use. Benchmark" >&2
  echo "   tasks are short and produce none. Seed the graph from a project graph" >&2
  echo "   that has them, and make sure they are ABOUT the repository the tasks" >&2
  echo "   touch -- findings about another project are pure injected cost." >&2
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
