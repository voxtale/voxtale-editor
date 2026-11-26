#!/bin/bash
S=${BENCH_SCRATCH:-$REPO/data/generate/_bench/scratch}
REPO=${REPO:-$(cd "$(dirname "$0")/../../.." && pwd)}
B=${AGENTICVBENCH:-$REPO/data/generate/_bench/agenticvbench}
R=$B/results/ours
for t in "$@"; do id=${t%%:*}
  $REPO/bench/agenticvbench/ours/run-task.sh $id ${t##*:}
  if grep -q "hit your .*limit" $R/$id/session.jsonl; then echo "[$(date +%H:%M:%S)] LIMIT at $id; lane stops" >> $S/driver.log; exit 3; fi
done
echo "[$(date +%H:%M:%S)] lane done: $*" >> $S/driver.log
