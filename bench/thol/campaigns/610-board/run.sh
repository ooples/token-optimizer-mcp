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
RIG="$(cd "$HERE/../.." && pwd)"  # bench/thol
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
from pathlib import Path
if not Path('/results/results.sqlite').exists():
    print(0)
    raise SystemExit(0)
try:
    c = sqlite3.connect('file:/results/results.sqlite?mode=ro', uri=True)
    if not c.execute(\"select 1 from sqlite_master where type='table' and name='runs'\").fetchone():
        print(0)
        raise SystemExit(0)
    print(c.execute('select coalesce(sum(total_cost_usd),0) from runs').fetchone()[0])
finally:
    c.close()
") || return $?
    total=$(python -c "print(round($total + $one, 2))") || return $?
  done
  echo "$total"
}

for image in pr610 master; do
  case "$image" in
    pr610) expected=6c3bd71d52e7ae65d496e9b0100f474bcada5c3b ;;
    master) expected=1518a5d7c41f342e65dd10c89ee2595826607828 ;;
  esac
  MSYS_NO_PATHCONV=1 docker run --rm --entrypoint python3 "thol-rig:$image" -c \
    'import json,sys; p=json.load(open("/opt/optimizer-provenance.json")); assert p["head"] == sys.argv[1] and not p["dirty"], p; print(p)' "$expected"
done

for rep in 1 2 3 4 5; do
  if [ $((rep % 2)) -eq 1 ]; then order="pr610 master"; else order="master pr610"; fi
  for image in $order; do
    before=$(spent)
    echo ">> rep $rep: $image (spent so far \$$before)"
    if python -c "import sys; sys.exit(0 if $before > $STOP_USD else 1)"; then
      echo "!! recorded spend already passed the stop; halting" >&2
      exit 3
    fi
    # The runner plans reps 1..REPS and resumes past finished ones, and
    # ordered_campaign.py requires the plan to hold exactly REPS orders. So each
    # call gets the first $rep orders of the committed arm-order.json: a prefix,
    # never a reordering (the first launch failed here, before any run).
    prefix="$HERE/arm-order.rep$rep.json"
    python -c "
import json, sys
plan = json.load(open(sys.argv[1]))
plan['orders'] = plan['orders'][:int(sys.argv[2])]
assert len(plan['orders']) == int(sys.argv[2])
open(sys.argv[3], 'w').write(json.dumps(plan, indent=2) + '\n')" "$HERE/arm-order.json" "$rep" "$prefix"
    ARM_ORDER_FILE="$prefix" IMAGE="thol-rig:$image" RESULTS_VOLUME="$(volume "$image")" REPS="$rep" bash "$RIG/run-campaign.sh"
    total=$(spent)
    echo ">> after rep $rep $image: \$$total"
    if python -c "import sys; sys.exit(0 if $total > $STOP_USD else 1)"; then
      echo "!! spend \$$total passed the \$$STOP_USD stop; halting" >&2
      exit 3
    fi
  done
done
echo ">> campaign complete: \$$(spent)"
