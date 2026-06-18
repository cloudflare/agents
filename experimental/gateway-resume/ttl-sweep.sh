#!/usr/bin/env bash
# Risk #4 — find the AI Gateway resume buffer TTL and capture the exact expiry
# contract. Capture one runId, then resume it at growing elapsed times until the
# buffer is gone, logging status + bytes + body snippet at each step.
set -u
BASE="http://localhost:8788"
MODEL="openai/gpt-5.4"
LOG=/tmp/ttl-sweep.log
: >"$LOG"

RID=$(curl -s "$BASE/run?model=$MODEL" | python3 -c "import sys,json;print(json.load(sys.stdin)['runId'])")
echo "runId=$RID  start=$(date -u +%H:%M:%S)" | tee -a "$LOG"

# Cumulative elapsed seconds to probe at.
MARKS=(0 60 180 420 900 1800 3600)
PREV=0
for MARK in "${MARKS[@]}"; do
  SLEEP=$((MARK - PREV)); PREV=$MARK
  [ "$SLEEP" -gt 0 ] && sleep "$SLEEP"
  RESP=$(curl -s "$BASE/resume-info?runId=$RID&from=0")
  STATUS=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status'))" 2>/dev/null)
  BYTES=$(echo "$RESP"  | python3 -c "import sys,json;print(json.load(sys.stdin).get('bytes'))"  2>/dev/null)
  echo "t+${MARK}s  status=$STATUS  bytes=$BYTES  ($(date -u +%H:%M:%S))" | tee -a "$LOG"
  if [ "$STATUS" != "200" ] || [ "$BYTES" = "0" ]; then
    echo "EXPIRED at t+${MARK}s — contract:" | tee -a "$LOG"
    echo "$RESP" | python3 -m json.tool | tee -a "$LOG"
    echo "SWEEP_DONE_EXPIRED" | tee -a "$LOG"
    exit 0
  fi
done
echo "SWEEP_DONE_ALIVE buffer still replaying at t+${PREV}s (TTL >= ${PREV}s)" | tee -a "$LOG"
