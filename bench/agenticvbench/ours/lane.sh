#!/bin/bash
S=/private/tmp/claude-501/-Users-zokov-code-super-tale/263aa54c-693e-4781-ab67-e9ca1c8f8f85/scratchpad/bench
R=/Users/zokov/code/super-tale/data/generate/_bench/agenticvbench/results/ours
for t in "$@"; do id=${t%%:*}
  $S/run-task.sh $id ${t##*:}
  if grep -q "hit your .*limit" $R/$id/session.jsonl; then echo "[$(date +%H:%M:%S)] LIMIT at $id; lane stops" >> $S/driver.log; exit 3; fi
done
echo "[$(date +%H:%M:%S)] lane done: $*" >> $S/driver.log
