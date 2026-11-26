#!/bin/sh
# Subject mask model for text behind the speaker: rembg's U2-Net-p (Apache-2.0, 4.6 MB).
set -eu
dir="$(cd "$(dirname "$0")/.." && pwd)/models"
out="$dir/u2netp.onnx"
sum=309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8
mkdir -p "$dir"
curl -fsSL -o "$out.part" https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx
got=$(shasum -a 256 "$out.part" | cut -d' ' -f1)
[ "$got" = "$sum" ] || { rm -f "$out.part"; echo "checksum mismatch: $got" >&2; exit 1; }
mv "$out.part" "$out"
echo "$out"
