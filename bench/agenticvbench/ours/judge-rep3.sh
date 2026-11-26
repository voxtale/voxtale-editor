#!/bin/bash
# usage: judge-rep3.sh <id>. Run 3: re-judge only errored gemini-audio items in ws3 (copy of ws2). Keys from .env, this process only.
set -u; id=$1
REPO=/Users/zokov/code/super-tale; B=$REPO/data/generate/_bench/agenticvbench
S=/private/tmp/claude-501/-Users-zokov-code-super-tale/263aa54c-693e-4781-ab67-e9ca1c8f8f85/scratchpad/bench
D=$B/results/ours/$id; W=$D/ws3; J=$D/judge-v1beta
cd $W
export ANTHROPIC_API_KEY="$(grep '^ANTHROPIC_API_KEY=' $REPO/.env | tail -1 | cut -d= -f2- | tr -d '"')"
export GEMINI_API_KEY="$(grep '^GEMINI_API_KEY=' $REPO/.env | tail -1 | cut -d= -f2- | tr -d '"')"
export CUTBENCH_REPURPOSE_ONLY=1
$S/jvenv/bin/python -W ignore $S/meter.py $S/rejudge_audio.py $J/judge.py runs/r r > judge.log 2>&1
echo "rejudge exit $?" >> judge.log
$S/jvenv/bin/python $J/aggregate.py results r reward.json breakdown.json >> judge.log 2>&1
echo "aggregate exit $?" >> judge.log
