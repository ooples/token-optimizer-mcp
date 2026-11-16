#!/usr/bin/env bash
# Drives PREREGISTRATION.md: 5 reps, images alternating per rep, spend checked
# after every image-rep. Resumable: runner.py skips runs already recorded, so
# re-running this continues where it stopped.
#
# ONE RESULTS VOLUME PER IMAGE. runner.py keys resume on (competitor, task,
# rep) under THOL_CAMPAIGN, which must equal the client version -- the same in
# both images. Both arms are `token-optimizer-mcp`, so in a shared volume the
# second image would find every run "already done" and measure nothing.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RIG="$(cd "$HERE/../.." && pwd)"
STOP_USD=70

export ARM_ORDER_FILE="$HERE/arm-order.json"
export ARMS=token-optimizer-mcp
export SEG_1="code-bugfix-py,code-refactor-split-py,log-needle-zh,code-iterate-tests"
export SEG_2="code-feature-js,code-migration-py-xl,code-migration-py,code-feature-validate-py"
export SEG_3="seo-audit,report-pdf,code-overview-cobra,code-settings-inventory-django"
export SEG_4="code-comprehension-django,code-debug-pipeline-py,code-debug-ledger-py,code-debug-cascade-py,code-rewrite-modernize-py"
export SEGMENTS_MAX=4

volume() { echo "thol-610-board-$1"; }

spent() {
  local total=0 one
  for image in pr610 master; do
    one=$(MSYS_NO_PATHCONV=1 docker run --rm -v "$(volume "$image"):/results" --entrypoint python3 thol-rig:pr610 -c "
import sqlite3
try:
    c = sqlite3.connect('/results/results.sqlite')
    print(c.execute('select coalesce(sum(total_cost_usd),0) from runs').fetchone()[0])
except Exception:
    print(0)
")
    total=$(python -c "print(round($total + $one, 2))")
  done
  echo "$total"
}

for image in pr610 master; do
  head=$(MSYS_NO_PATHCONV=1 docker run --rm --entrypoint cat "thol-rig:$image" /opt/optimizer-provenance.json | grep '"head"')
  echo ">> thol-rig:$image $head"
done

for rep in 1 2 3 4 5; do
  if [ $((rep % 2)) -eq 1 ]; then order="pr610 master"; else order="master pr610"; fi
  for image in $order; do
    echo ">> rep $rep: $image (spent so far \$$(spent))"
    IMAGE="thol-rig:$image" RESULTS_VOLUME="$(volume "$image")" REPS="$rep" bash "$RIG/thol/run-campaign.sh"
    total=$(spent)
    echo ">> after rep $rep $image: \$$total"
    if python -c "import sys; sys.exit(0 if $total > $STOP_USD else 1)"; then
      echo "!! spend \$$total passed the \$$STOP_USD stop; halting" >&2
      exit 3
    fi
  done
done
echo ">> campaign complete: \$$(spent)"
