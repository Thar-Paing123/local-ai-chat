#!/usr/bin/env bash
# Control the launchd-managed vLLM server (job: com.line-translator.vllm, port 8001).
#
#   ./vllm-ctl.sh status    is it alive AND actually able to generate?
#   ./vllm-ctl.sh restart   hard-restart via launchd (fixes the wedged state)
#   ./vllm-ctl.sh logs      follow the job's log
#
# Why this exists: the job has KeepAlive, so `kill` only respawns it. And after a
# sleep/wake the API server can stay up while its engine core is dead — /v1/models
# still answers but generation hangs forever. `status` catches exactly that by
# sending a real 1-token completion, not just a health ping.

set -uo pipefail

JOB="com.line-translator.vllm"
LABEL="gui/$(id -u)/$JOB"
PORT="${PORT:-8001}"
API_KEY="${API_KEY:-local}"
MODEL="${MODEL:-mlx-community/Qwen2.5-7B-Instruct-4bit}"
BASE="http://127.0.0.1:$PORT/v1"
PLIST="$HOME/Library/LaunchAgents/$JOB.plist"

auth=(-H "Authorization: Bearer $API_KEY")

generate_ok() {   # real generation, short timeout — a wedged engine will not answer
  curl -sf -m "${1:-25}" "${auth[@]}" -H 'content-type: application/json' \
    "$BASE/chat/completions" \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1,\"temperature\":0}" \
    >/dev/null 2>&1
}

case "${1:-status}" in
  status)
    pid=$(launchctl list "$JOB" 2>/dev/null | awk '/"PID"/{gsub(/[^0-9]/,"");print}')
    if [[ -z "$pid" ]]; then
      echo "launchd job : not running"
    else
      echo "launchd job : pid $pid  (up $(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' '))"
      # Deliberately no memory check: MLX holds the weights in Metal buffers, so
      # even a healthy engine reports only ~30 MB RSS. Resident size says nothing
      # about whether the model is loaded — only a real completion does.
      if pgrep -qf 'VLLM::EngineCore'; then
        echo "engine core : present"
      else
        echo "engine core : MISSING — api may answer while generation hangs"
      fi
    fi

    if curl -sf -m 3 "${auth[@]}" "$BASE/models" >/dev/null 2>&1; then
      echo "http api    : responding on $BASE"
    else
      echo "http api    : NOT responding on $BASE"
      exit 1
    fi

    [[ -t 1 ]] && printf 'generation  : testing'   # progress hint only on a terminal
    t0=$(python3 -c 'import time;print(time.time())')
    if generate_ok 25; then
      echo $'\r'"generation  : OK ($(python3 -c "import time;print(f'{time.time()-$t0:.1f}s to first token')"))"
    else
      echo $'\rgeneration  : WEDGED (api up, engine dead) — run: ./vllm-ctl.sh restart'
      exit 1
    fi
    ;;

  restart)
    if [[ ! -f "$PLIST" ]]; then
      echo "no plist at $PLIST" >&2
      exit 1
    fi
    echo "restarting ${JOB}…"
    launchctl kickstart -k "$LABEL" || { echo "kickstart failed" >&2; exit 1; }

    printf 'waiting for model'
    for _ in $(seq 1 90); do
      if generate_ok 10; then echo " ready → $BASE"; exit 0; fi
      printf '.'
      sleep 2
    done
    echo " timed out — check ./vllm-ctl.sh logs" >&2
    exit 1
    ;;

  logs)
    out=$(/usr/libexec/PlistBuddy -c 'Print :StandardOutPath' "$PLIST" 2>/dev/null || true)
    err=$(/usr/libexec/PlistBuddy -c 'Print :StandardErrorPath' "$PLIST" 2>/dev/null || true)
    files=$(printf '%s\n%s\n' "$out" "$err" | sort -u | grep -v '^$')
    if [[ -z "$files" ]]; then
      echo "plist declares no log paths; run scripts/start_vllm.sh in a terminal to see output" >&2
      exit 1
    fi
    # shellcheck disable=SC2086
    tail -f $files
    ;;

  *)
    echo "usage: $0 {status|restart|logs}" >&2
    exit 2
    ;;
esac
