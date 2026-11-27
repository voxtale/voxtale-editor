#!/bin/sh
# Object picks in the subject mask (voxtale_native/objects.py): MobileSAM as ONNX, 44 MB, not in git.
# Licence: MobileSAM code and weights Apache-2.0 (github.com/ChaoningZhang/MobileSAM); this ONNX export MIT
# (huggingface.co/Acly/MobileSAM). Pinned to the commit below; sha256 checked before the file lands.
set -eu
dir="$(cd "$(dirname "$0")/.." && pwd)/models"
rev=0d3b403339b4674a82493d5e97964dd78089ddc8
base="https://huggingface.co/Acly/MobileSAM/resolve/$rev"
mkdir -p "$dir"
fetch() {
  name=$1 sum=$2 out="$dir/$1"
  if [ -f "$out" ] && [ "$(shasum -a 256 "$out" | cut -d' ' -f1)" = "$sum" ]; then echo "$out"; return; fi
  curl -fsSL -o "$out.part" "$base/$name"
  got=$(shasum -a 256 "$out.part" | cut -d' ' -f1)
  [ "$got" = "$sum" ] || { rm -f "$out.part"; echo "checksum mismatch for $name: $got" >&2; exit 1; }
  mv "$out.part" "$out"
  echo "$out"
}
fetch mobile_sam_image_encoder.onnx 580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749
fetch sam_mask_decoder_single.onnx 93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d
