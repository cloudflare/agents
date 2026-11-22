#!/bin/bash
# Runs every configuration with everystate and compares the result with the
# one expected. A configuration listed with a rule must break that rule: it
# switches a guard off to show the guard is what keeps the rule.
cd "$(dirname "$0")" || exit 1

expected() {
  case "$1" in
    session-before-leftovers.cfg | session-worker-dies.cfg) echo NoLeftovers ;;
    session-before-terminated.cfg) echo TerminatedIsNotServed ;;
    stream-before-lost.cfg) echo ResponseNotLost ;;
    stream-before-open.cfg | stream-replay-unmarked.cfg) echo StreamEndsWithResponse ;;
    worker-transport-before.cfg) echo DeletedStaysDeleted ;;
    *) echo holds ;;
  esac
}

status=0
for cfg in *.cfg; do
  case "$cfg" in
    session*) spec=McpSession ;;
    stream*) spec=McpStream ;;
    *) spec=WorkerTransportSession ;;
  esac
  out=$(everystate -deadlock -config "$cfg" "$spec.tla" 2>&1)
  code=$?
  broken=$(echo "$out" | sed -n 's/.*Invariant \([A-Za-z]*\) is violated.*/\1/p' | head -1)
  if [ "$code" = 0 ]; then got=holds; else got=${broken:-"exit $code"}; fi
  want=$(expected "$cfg")
  if [ "$got" = "$want" ]; then mark=ok; else mark=UNEXPECTED; status=1; fi
  printf '%-11s %-36s %s\n' "$mark" "$cfg" "$got"
done
exit $status
