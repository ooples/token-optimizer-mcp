#!/usr/bin/env bash
# THOL rig entrypoint. Modes: selftest | calibrate | campaign | report | shell
#
# Everything that must be true before a single dollar of inference is spent
# happens in prepare(): credentials in place, our manifests registered,
# fixtures generated deterministically, verifiers passing. runner.py selftest
# is the gate -- it proves each verifier awards no credit on an empty
# workspace, which is what stops a broken task silently scoring every arm the
# same.

set -euo pipefail

MODE="${1:-selftest}"
shift || true

log() { printf '\n\033[1;36m>> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

prepare() {
  log "Authenticating"
  if [ -f /auth/credentials.json ]; then
    mkdir -p "$HOME/.claude"
    cp /auth/credentials.json "$HOME/.claude/.credentials.json"
    chmod 600 "$HOME/.claude/.credentials.json"
    # runner.py copies this file into every throwaway sandbox HOME
    # (runner.py:129), which is what makes subscription auth survive isolation.
    echo "   subscription credentials staged for sandbox copy"
  elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    echo "   using ANTHROPIC_API_KEY from environment"
  else
    die "No auth. Mount a trimmed credentials file at /auth/credentials.json or set ANTHROPIC_API_KEY."
  fi

  log "Registering our manifests in the THOL competitor registry"
  for d in /home/bench/manifests/*/; do
    name="$(basename "$d")"
    mkdir -p "$THOL_HOME/competitors/$name"
    cp "$d/manifest.json" "$THOL_HOME/competitors/$name/manifest.json"
    echo "   + $name"
  done

  cd "$THOL_HOME"

  # Persist the results DB and per-run artifacts outside the container, or a
  # --rm run throws away everything it just paid for. runner.py resumes from
  # results.sqlite, so this is also what makes the campaign restartable after
  # a credential expiry or an interrupted segment.
  if [ -d /results ] && [ -w /results ]; then
    log "Persisting results to the mounted volume"
    mkdir -p /results/runs
    python3 - <<'PY'
import json, pathlib
cfg = pathlib.Path("bench.config.json")
data = json.loads(cfg.read_text())
data["runs_root"] = "/results/runs"
cfg.write_text(json.dumps(data, indent=1) + "\n")
print("   runs_root -> /results/runs")
PY
    [ -e /results/results.sqlite ] || : > /results/results.sqlite
    ln -sf /results/results.sqlite "$THOL_HOME/results.sqlite"
    echo "   results.sqlite -> /results/results.sqlite"

    # runner.py caches cloned benchmark repos under ROOT/.cache/repos
    # (runner.py:32) and npm/uv/hf caches beside them. Without persisting this,
    # every segment re-clones django and cobra from scratch -- minutes of wall
    # time per segment, repeated, for bytes that never change (repos.lock.json
    # pins exact commits).
    mkdir -p /results/.cache
    rm -rf "$THOL_HOME/.cache"
    ln -sfn /results/.cache "$THOL_HOME/.cache"
    echo "   .cache -> /results/.cache (repo + npm caches persist across segments)"
  else
    echo "   WARNING: /results not mounted -- run data will be lost when the container exits"
  fi

  # runner.py selftest builds scratch workspaces at runs_root/selftest/<task>
  # with shutil.copytree, which refuses a directory that already exists. Once
  # runs_root is persistent (above), the second segment dies with
  # FileExistsError before spending anything. These are throwaway workspaces,
  # not results, so clearing them is safe and required.
  rm -rf /results/runs/selftest 2>/dev/null || true

  log "Generating deterministic fixtures"
  # Seed of record is 42 for every campaign up to 2.1.183; THOL_FIXTURE_SEED
  # overrides it. Byte-identical across regenerations for a given seed.
  #
  # THOL's CONTRIBUTING.md documents only generate_fixtures.py, but that is
  # incomplete: the long- and mega-task generators produce ledger-debug,
  # code-debug, cascade-debug and pipeline-debug, and `runner.py selftest`
  # aborts with "fixture 'cascade-debug' missing" without them. All three must
  # run, in this order.
  #
  # GENERATE ONCE, THEN REUSE. Regeneration is not reliably reproducible in
  # practice: two runs of gen_megatasks.py in this image produced
  # "cascade-debug: shipped RED 30/44" and then "25/44" despite its fixed
  # random.Random(20260619) seed, so something outside the seed (dict/set
  # iteration order under hash randomisation is the usual culprit) reaches the
  # output. That is survivable within one segment, where every arm sees the
  # same files, but a SEGMENTED campaign would hand different segments
  # different fixtures and quietly make the arms incomparable. Persisting the
  # first generation removes the question entirely.
  #
  # PYTHONHASHSEED is pinned as well, so a fresh /results also regenerates the
  # same way rather than merely being self-consistent.
  export PYTHONHASHSEED=0
  if [ -d /results/fixtures/out ] && [ -d /results/fixtures/truth ]; then
    echo "   reusing the persisted fixture set (identical across segments)"
    rm -rf fixtures/out fixtures/truth
    ln -sfn /results/fixtures/out fixtures/out
    ln -sfn /results/fixtures/truth fixtures/truth
  else
    python3 fixtures/generate_fixtures.py
    python3 fixtures/gen_longtasks.py
    python3 fixtures/gen_megatasks.py
    if [ -d /results ] && [ -w /results ]; then
      mkdir -p /results/fixtures
      cp -r fixtures/out /results/fixtures/out
      cp -r fixtures/truth /results/fixtures/truth
      echo "   fixture set persisted for later segments"
    fi
  fi

  log "Verifier selftest (gate: must PASS before any spend)"
  python3 runner.py selftest || die "selftest failed -- do not spend money on a harness whose verifiers are broken"
}

case "$MODE" in
  selftest)
    prepare
    log "Rig is ready. Competitors available:"
    cd "$THOL_HOME" && python3 runner.py list
    ;;

  calibrate)
    # Measure the control's own variance before comparing anything to it.
    # THOL's protocol step 1: no competitor delta smaller than the control
    # noise floor may be presented as a real effect.
    prepare
    cd "$THOL_HOME"
    log "Calibrating control noise floor"
    python3 runner.py stabilize -c control -t all "$@"
    ;;

  campaign)
    prepare
    cd "$THOL_HOME"
    : "${THOL_CAMPAIGN:?set THOL_CAMPAIGN to the Claude Code version label}"
    log "Campaign: $THOL_CAMPAIGN"
    python3 runner.py run "$@"
    log "Building leaderboard"
    python3 leaderboard.py || true
    if [ -d /results ] && [ -w /results ]; then
      mkdir -p /results/leaderboard
      cp -f docs/data/results.json /results/leaderboard/ 2>/dev/null || true
      echo "   leaderboard JSON copied to /results/leaderboard/"
    fi
    ;;

  report)
    cd "$THOL_HOME"
    python3 leaderboard.py
    ;;

  shell)
    exec /bin/bash
    ;;

  *)
    die "Unknown mode '$MODE'. Use: selftest | calibrate | campaign | report | shell"
    ;;
esac
