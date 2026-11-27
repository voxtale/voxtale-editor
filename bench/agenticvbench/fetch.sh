#!/bin/zsh
# Fetch the 14 AgenticVBench tasks of the bench plan (B1–B14).
# Usage: bench/agenticvbench/fetch.sh [task-id ...]   (default: all)
#
# Layout under data/generate/_bench/agenticvbench/ (gitignored):
#   repo/                     shallow clone of PhiloLabs/agentic-vbench (holds answer keys)
#   tasks/<id>/instruction.md the brief the agent sees
#   tasks/<id>/materials/     clips (Sequencing/Assembly) or source.mp4 (Repurpose)
#   judges/<id>/              the task's tests/ folder. Holds the answer key:
#                             never point an agent at judges/ or repo/.
set -euo pipefail
ROOT=${0:A:h:h:h}/data/generate/_bench/agenticvbench
REPO=$ROOT/repo
[[ -d $REPO ]] || git clone --depth 1 https://github.com/PhiloLabs/agentic-vbench "$REPO"
T=$REPO/tasks

ALL=(rep-ted rep-comedy-knead
     seq-5 seq-17 seq-14 seq-7 seq-9 seq-3 seq-18 seq-16 seq-8 seq-11
     asm-11 asm-16 asm-15 asm-14)
ids=(${@:-$ALL})

for id in $ids; do
  fam=${id%%-*}; n=${id#*-}
  case $fam in
    rep) src=$T/agentic_vbench_repurpose/$n ;;
    seq) src=$T/agentic_vbench_sequencing/agentic-vbench-sequencing-task$n ;;
    asm) src=$T/agentic_vbench_assembly/agentic-vbench-assembly-task$n ;;
    *) echo "unknown id $id" >&2; exit 1 ;;
  esac
  dst=$ROOT/tasks/$id
  mkdir -p $dst/materials $ROOT/judges/$id
  cp $src/steps/solve/instruction.md $dst/
  [[ -f $src/environment/brief.md ]] && cp $src/environment/brief.md $dst/
  rsync -a --delete $src/steps/solve/tests/ $ROOT/judges/$id/

  df=$src/environment/Dockerfile
  url=$(sed -nE 's/^ARG MATERIALS_URL=(.*)$/\1/p' $df)
  sha=$(sed -nE 's/^ARG MATERIALS_SHA256=(.*)$/\1/p' $df)
  if [[ -n $(ls -A $dst/materials) ]]; then echo "$id: materials present, skip"; continue; fi
  tmp=$ROOT/.dl-$id; mkdir -p $tmp
  f=$tmp/${url:t}
  curl --fail --silent --show-error --location --retry 5 --retry-delay 3 "$url" -o "$f"
  if [[ -n $sha ]]; then echo "$sha  $f" | shasum -a 256 -c - >/dev/null || { echo "$id: sha mismatch" >&2; exit 1; }; fi
  case $f in
    *.zip) unzip -q "$f" -d $dst/materials ;;
    *.mp4) mv "$f" $dst/materials/source.mp4 ;;
  esac
  rm -rf $tmp
  echo "$id: $(du -sh $dst/materials | cut -f1) ${sha:+(sha ok)}"
done
