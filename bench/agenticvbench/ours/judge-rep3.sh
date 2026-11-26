#!/bin/bash
# usage: judge-rep3.sh <id>. Run 3: re-judge only errored gemini-audio items in ws3 (copy of ws2). Keys from .env, this process only.
set -u; id=$1
REPO=${REPO:-$(cd "$(dirname "$0")/../../.." && pwd)}
B=${AGENTICVBENCH:-$REPO/data/generate/_bench/agenticvbench}
S=${BENCH_SCRATCH:-$REPO/data/generate/_bench/scratch}
D=$B/results/ours/$id; W=$D/ws3; J=$D/judge-v1beta
cd $W
export ANTHROPIC_API_KEY="$(grep '^ANTHROPIC_API_KEY=' $REPO/.env | tail -1 | cut -d= -f2- | tr -d '"')"
export GEMINI_API_KEY="$(grep '^GEMINI_API_KEY=' $REPO/.env | tail -1 | cut -d= -f2- | tr -d '"')"
export CUTBENCH_REPURPOSE_ONLY=1
$S/jvenv/bin/python -W ignore $REPO/bench/agenticvbench/ours/meter.py $REPO/bench/agenticvbench/ours/rejudge_audio.py $J/judge.py runs/r r > judge.log 2>&1
echo "rejudge exit $?" >> judge.log
$S/jvenv/bin/python $J/aggregate.py results r reward.json breakdown.json >> judge.log 2>&1
echo "aggregate exit $?" >> judge.log
