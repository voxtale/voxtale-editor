#!/bin/sh
# Local transcription model: NVIDIA Parakeet TDT 0.6B v3 (CC-BY-4.0), into
# models/parakeet/ (gitignored). Pinned versions, sha256 checked.
#
#   tools/fetch-parakeet.sh          the model for this machine
#   tools/fetch-parakeet.sh --mlx    Apple Silicon: MLX weights (2.5 GB)
#   tools/fetch-parakeet.sh --onnx   CPU (Windows, Linux, Intel Mac, VOXTALE_EDITOR_ASR=cpu): int8 ONNX (490 MB)
#
# Safe to run again: skips a model already there.
set -eu
dir="$(cd "$(dirname "$0")/.." && pwd)/models/parakeet"

want=${1:-}
if [ -z "$want" ]; then
  if [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]; then want=--mlx; else want=--onnx; fi
fi

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
get() { # url out sha256
  curl -fL --retry 3 -o "$2.part" "$1"
  got=$(sha "$2.part")
  [ "$got" = "$3" ] || { rm -f "$2.part"; echo "checksum mismatch for $2: $got" >&2; exit 1; }
  mv "$2.part" "$2"
}

mkdir -p "$dir"
case "$want" in
  --mlx)
    # mlx-community/parakeet-tdt-0.6b-v3 at a pinned commit (same model REDACTED uses).
    rev=ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15
    out="$dir/parakeet-tdt-0.6b-v3-mlx"
    base="https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3/resolve/$rev"
    mkdir -p "$out"
    [ -f "$out/config.json" ] || get "$base/config.json" "$out/config.json" f320f1292511f34ec47f513755fe20fd01dbfc09a925d42730e66059a6e1ef4c
    [ -f "$out/model.safetensors" ] || get "$base/model.safetensors" "$out/model.safetensors" 05e01c7f396c298cf7d23f61da7b504adeab698f0aaeafd9c82d198625464592
    echo "$out"
    ;;
  --onnx)
    # k2-fsa/sherpa-onnx release asr-models, int8 export of the same model.
    name=sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8
    out="$dir/$name"
    if [ ! -f "$out/tokens.txt" ]; then
      get "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$name.tar.bz2" "$dir/$name.tar.bz2" \
        1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9
      rm -rf "$dir/$name.tmp" "$out"
      mkdir -p "$dir/$name.tmp"
      tar -xjf "$dir/$name.tar.bz2" -C "$dir/$name.tmp"
      mv "$dir/$name.tmp/$name" "$out"
      rm -rf "$dir/$name.tmp" "$dir/$name.tar.bz2"
    fi
    echo "$out"
    ;;
  *) echo "usage: $0 [--mlx|--onnx]" >&2; exit 2 ;;
esac
