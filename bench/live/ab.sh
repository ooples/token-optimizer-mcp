#!/usr/bin/env bash
# What each part of the proxy costs on REAL traffic, measured live.
#
# Every other instrument here is offline. This one drives an actual agent
# through an actual proxy against the actual API, and reads the provider's own
# usage numbers out of the ledger. It exists because offline measurement misled
# this project repeatedly:
#
#   - byte counts scored tool deferral as a REGRESSION, because deferral marks
#     definitions rather than removing them; it makes the request 0.4% larger
#     while halving what is billed;
#   - session transcripts store `thinking: ""`, so every offline evaluation of
#     history substitution measured the removal of signatures;
#   - a fixture built to match an assumption about the wire cannot falsify that
#     assumption, and one here did not.
#
# THREE DEFECTS THIS HARNESS HAD, all of which produced confident wrong answers
# before they were found. They are fixed below and called out because each is
# easy to reintroduce:
#
#   1. `${base:+ANTHROPIC_BASE_URL=$base}` does NOT set a variable. Bash parses
#      the expanded word as a COMMAND and fails with "No such file or
#      directory", so the arm ran unconfigured -- silently becoming a second
#      copy of the control. `env` is used instead.
#   2. Proxy stderr went to /dev/null, so a proxy that never bound its port left
#      no trace and (1) stayed invisible.
#   3. Nothing confirmed the proxy was answering before a run was spent on it.
#      There is a liveness probe now, and an arm whose proxy never comes up is
#      reported as SKIP rather than scored.
#
# Correctness is taken from re-running the test suite, never from the agent's
# own report: an agent that says it succeeded and did not is exactly what this
# has to catch.
#
# Usage:
#   bash bench/live/ab.sh
#     ARMS=control,proxy,substitute   which arms to run
#     REPS=3                          repetitions per arm
#     OUT=/path                       where to write results

set -uo pipefail

PKG="${PKG:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
OUT="${OUT:-${TEMP:-/tmp}/live-ab}"
REPS="${REPS:-1}"
ARMS="${ARMS:-control,proxy,substitute}"
PORT_BASE="${PORT_BASE:-8830}"

command -v claude >/dev/null 2>&1 || { echo "claude CLI not found" >&2; exit 2; }
python -m pytest --version >/dev/null 2>&1 || { echo "pytest not available" >&2; exit 2; }

rm -rf "$OUT"; mkdir -p "$OUT"
echo "arm,rep,verdict,seconds,weighted_input,output" > "$OUT/results.csv"

seed() {
  printf 'def add(a, b):\n    return a - b\n\ndef mul(a, b):\n    return a + b\n' > "$1/calc.py"
  printf 'from calc import add, mul\n\ndef test_add():\n    assert add(2, 3) == 5\n\ndef test_mul():\n    assert mul(2, 3) == 6\n' > "$1/test_calc.py"
}

# Each arm's proxy environment, one line per arm. Empty means "no proxy".
proxy_env_for() {
  case "$1" in
    proxy)      echo "" ;;
    nodefer)    echo "TOKEN_OPTIMIZER_PROXY_DEFER_TOOLS=0" ;;
    substitute) echo "TOKEN_OPTIMIZER_PROXY_SUBSTITUTE=1" ;;
    *)          echo "" ;;
  esac
}

port_for() { # deterministic per arm, so two arms never collide
  case "$1" in
    proxy) echo $((PORT_BASE));;
    nodefer) echo $((PORT_BASE+1));;
    substitute) echo $((PORT_BASE+2));;
    *) echo 0;;
  esac
}

alive() { # port -- does anything answer?
  node -e "
    fetch('http://127.0.0.1:$1/v1/messages',{method:'POST',
      headers:{'content-type':'application/json'},body:'{}'})
      .then(()=>process.exit(0)).catch(()=>process.exit(1));
  " >/dev/null 2>&1
}

run_arm() { # arm rep
  local arm="$1" rep="$2"
  local work="$OUT/$arm-$rep"; mkdir -p "$work"; seed "$work"
  local ledger="$OUT/$arm-$rep.jsonl"
  local pid="" base="" port
  port=$(port_for "$arm")

  if [ "$arm" != "control" ]; then
    # Stderr to a file, never /dev/null: defect 2.
    env TOKEN_OPTIMIZER_PROXY=1 \
        TOKEN_OPTIMIZER_PROXY_ACCOUNTING="$ledger" \
        $(proxy_env_for "$arm") \
        node "$PKG/dist/proxy/cli.js" --port "$port" --quiet \
        >/dev/null 2>"$OUT/$arm-$rep.proxy.err" &
    pid=$!
    base="http://127.0.0.1:$port"

    # Defect 3: prove it answers before spending a run on it.
    local up=1
    for _ in $(seq 1 15); do alive "$port" && { up=0; break; }; sleep 2; done
    if [ "$up" != "0" ]; then
      kill "$pid" 2>/dev/null
      printf '%-11s rep%-2s %-5s  proxy never came up -- see %s\n' \
        "$arm" "$rep" "SKIP" "$OUT/$arm-$rep.proxy.err"
      echo "$arm,$rep,SKIP,0,," >> "$OUT/results.csv"
      return
    fi
  fi

  local start; start=$(date +%s)
  # Defect 1: `env`, because `${base:+VAR=$base}` is parsed as a command.
  ( cd "$work" && env ${base:+ANTHROPIC_BASE_URL="$base"} \
      timeout 420 claude -p "Run the tests here with python -m pytest. Fix the source so every test passes. Re-run until green." \
      --permission-mode bypassPermissions > "$work/agent.log" 2>&1 )
  local secs=$(( $(date +%s) - start ))
  [ -n "$pid" ] && kill "$pid" 2>/dev/null

  local verdict="FAIL"
  ( cd "$work" && timeout 120 python -m pytest -q >/dev/null 2>&1 ) && verdict="PASS"

  local wi="" out=""
  if [ -f "$ledger" ]; then
    read -r wi out <<< "$(node -e "
      const fs=require('fs');let i=0,o=0,w=0,r=0;
      for(const l of fs.readFileSync(process.argv[1],'utf8').split('\n')){
        if(!l.trim())continue; let j; try{j=JSON.parse(l)}catch{continue}
        const u=j.usage||{};
        i+=u.input_tokens||0; o+=u.output_tokens||0;
        w+=u.cache_creation_input_tokens||0; r+=u.cache_read_input_tokens||0;
      }
      // Weighted the way the provider bills: write 1.25x, read 0.1x.
      process.stdout.write(Math.round(i + w*1.25 + r*0.1) + ' ' + o);
    " "$ledger" 2>/dev/null)"
  fi

  printf '%-11s rep%-2s %-5s %4ss  weighted-input=%-9s output=%s\n' \
    "$arm" "$rep" "$verdict" "$secs" "${wi:-n/a}" "${out:-n/a}"
  echo "$arm,$rep,$verdict,$secs,$wi,$out" >> "$OUT/results.csv"
}

echo "arm         rep  verdict  time   billed"
echo "------------------------------------------------------------"
for rep in $(seq 1 "$REPS"); do
  IFS=',' read -ra list <<< "$ARMS"
  for arm in "${list[@]}"; do run_arm "$arm" "$rep"; done
done

echo
echo "=== summary (weighted input = input + 1.25*cache_write + 0.1*cache_read) ==="
node -e "
  const fs=require('fs');
  const rows=fs.readFileSync(process.argv[1],'utf8').trim().split('\n').slice(1)
    .map(l=>l.split(',')).filter(r=>r[2]!=='SKIP');
  const by={};
  for(const [arm,,verdict,secs,wi,out] of rows){
    (by[arm] ||= {n:0,pass:0,secs:0,wi:0,out:0,wiN:0});
    by[arm].n++; if(verdict==='PASS') by[arm].pass++;
    by[arm].secs+=Number(secs)||0;
    if(wi){by[arm].wi+=Number(wi); by[arm].out+=Number(out)||0; by[arm].wiN++;}
  }
  for(const [arm,v] of Object.entries(by)){
    const wi = v.wiN ? Math.round(v.wi/v.wiN) : null;
    console.log('  '+arm.padEnd(12)+'passed '+v.pass+'/'+v.n+
      '  mean '+Math.round(v.secs/v.n)+'s'+
      (wi!==null ? '  weighted-input '+wi+'  output '+Math.round(v.out/v.wiN) : '  (no ledger)'));
  }
" "$OUT/results.csv"
echo
echo "results: $OUT/results.csv"
