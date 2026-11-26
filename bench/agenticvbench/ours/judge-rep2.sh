#!/bin/bash
# usage: judge-rep2.sh <id>. Re-judge in ws2 with the v1beta judge copy. Keys from .env, this process only.
set -u; id=$1
REPO=/Users/zokov/code/super-tale; B=$REPO/data/generate/_bench/agenticvbench
S=/private/tmp/claude-501/-Users-zokov-code-super-tale/263aa54c-693e-4781-ab67-e9ca1c8f8f85/scratchpad/bench
D=$B/results/ours/$id; W=$D/ws2; J=$D/judge-v1beta
cd $W && rm -f usage.jsonl
export ANTHROPIC_API_KEY="$(grep '^ANTHROPIC_API_KEY=' $REPO/.env | tail -1 | cut -d= -f2- | tr -d '"')"
export GEMINI_API_KEY="$(grep '^GEMINI_API_KEY=' $REPO/.env | tail -1 | cut -d= -f2- | tr -d '"')"
export CUTBENCH_REPURPOSE_ONLY=1
$S/jvenv/bin/python -W ignore $S/meter.py $J/judge.py runs/r source.mp4 r > judge.log 2>&1
echo "judge exit $?" >> judge.log
$S/jvenv/bin/python $J/aggregate.py results r reward.json breakdown.json >> judge.log 2>&1
echo "aggregate exit $?" >> judge.log
