#!/bin/sh
# DJI's own D-Log M to Rec.709 LUT, from DJI's download page (dji.com/mavic-3-pro/downloads).
# Not bundled: DJI publishes it with no licence that lets us ship it. The editor
# applies it to D-Log M clips at open when the file is here (bd voxtale-editor-bq4).
# Osmo Pocket 4 D-Log: no public link found; pass its .cube by hand (set_look inputLut).
set -eu
dir="$(cd "$(dirname "$0")/.." && pwd)/models/luts"
out="$dir/DJI D-Log M to Rec.709.cube"
sum=b18162854ab47702068410c33afa98a8cb6eef159fc5a04ce0e65fad0fd8947e
mkdir -p "$dir"
curl -fsSL -o "$out.part" "https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/M3/DJI%20Mavic%203%20D-Log%20M%20to%20Rec.709%20V1.cube"
got=$(shasum -a 256 "$out.part" | cut -d' ' -f1)
[ "$got" = "$sum" ] || { rm -f "$out.part"; echo "checksum mismatch: $got" >&2; exit 1; }
mv "$out.part" "$out"
echo "$out"
