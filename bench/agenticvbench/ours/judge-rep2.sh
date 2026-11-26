#!/bin/bash
# usage: judge-rep2.sh <id>. Re-judge in ws2 with the v1beta judge copy. Keys from .env, this process only.
set -u; id=$1
REPO=${REPO:-$(cd "$(dirname "$0")/../../.." && pwd)}
B=${AGENTICVBENCH:-$REPO/data/generate/_bench/agenticvbench}
S=${BENCH_SCRATCH:-$REPO/data/generate/_bench/scratch}
D=$B/results/ours/$id; W=$D/ws2; J=$D/judge-v1beta
cd $W && rm -f usage.jsonl
export ANTHROPIC_API_KEY="$(grep '^ANTHROPIC_API_KEY=' $REPO/.env | tail -1 | cut -d= -f2- | tr -d '"')"
export GEMINI_API_KEY="$(grep '^GEMINI_API_KEY=' $REPO/.env | tail -1 | cut -d= -f2- | tr -d '"')"
export CUTBENCH_REPURPOSE_ONLY=1
$S/jvenv/bin/python -W ignore $REPO/bench/agenticvbench/ours/meter.py $J/judge.py runs/r source.mp4 r > judge.log 2>&1
echo "judge exit $?" >> judge.log
$S/jvenv/bin/python $J/aggregate.py results r reward.json breakdown.json >> judge.log 2>&1
echo "aggregate exit $?" >> judge.log
