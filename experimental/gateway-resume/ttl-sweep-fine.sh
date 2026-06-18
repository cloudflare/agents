#!/usr/bin/env bash
# Finer TTL bracket — the coarse sweep showed expiry between t+180s and t+420s.
# Probe a fresh runId at 30s steps across that window to pin the buffer TTL.
set -u
BASE="http://localhost:8788"
MODEL="openai/gpt-5.4"
LOG=/tmp/ttl-sweep-fine.log
: >"$LOG"

RID=$(curl -s "$BASE/run?model=$MODEL" | python3 -c "import sys,json;print(json.load(sys.stdin)['runId'])")
echo "runId=$RID  start=$(date -u +%H:%M:%S)" | tee -a "$LOG"

MARKS=(210 240 270 300 330 360 390)
PREV=0
for MARK in "${MARKS[@]}"; do
  SLEEP=$((MARK - PREV)); PREV=$MARK
  [ "$SLEEP" -gt 0 ] && sleep "$SLEEP"
  RESP=$(curl -s "$BASE/resume-info?runId=$RID&from=0")
  STATUS=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status'))" 2>/dev/null)
  BYTES=$(echo "$RESP"  | python3 -c "import sys,json;print(json.load(sys.stdin).get('bytes'))"  2>/dev/null)
  echo "t+${MARK}s  status=$STATUS  bytes=$BYTES  ($(date -u +%H:%M:%S))" | tee -a "$LOG"
  if [ "$STATUS" != "200" ]; then
    echo "EXPIRED between t+$((PREV>MARK?PREV:MARK))s probes — TTL ~= ${MARK}s" | tee -a "$LOG"
    echo "SWEEP_DONE_EXPIRED" | tee -a "$LOG"
    exit 0
  fi
done
echo "SWEEP_DONE_ALIVE TTL > ${PREV}s" | tee -a "$LOG"
