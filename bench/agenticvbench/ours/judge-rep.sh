#!/bin/bash
# usage: judge-rep.sh <id>. Keys are read from .env into this process only.
set -u; id=$1
REPO=${REPO:-$(cd "$(dirname "$0")/../../.." && pwd)}
B=${AGENTICVBENCH:-$REPO/data/generate/_bench/agenticvbench}
S=${BENCH_SCRATCH:-$REPO/data/generate/_bench/scratch}
W=$B/results/ours/$id/ws
cd $W && rm -f usage.jsonl
export ANTHROPIC_API_KEY="$(grep '^ANTHROPIC_API_KEY=' $REPO/.env | cut -d= -f2- | tr -d '"')"
export GEMINI_API_KEY="$(grep '^GEMINI_API_KEY=' $REPO/.env | cut -d= -f2- | tr -d '"')"
export CUTBENCH_REPURPOSE_ONLY=1
$S/jvenv/bin/python $REPO/bench/agenticvbench/ours/meter.py $B/judges/$id/judge.py runs/r source.mp4 r > judge.log 2>&1
echo "judge exit $?" >> judge.log
$S/jvenv/bin/python $B/judges/$id/aggregate.py results r reward.json breakdown.json >> judge.log 2>&1
echo "aggregate exit $?" >> judge.log
