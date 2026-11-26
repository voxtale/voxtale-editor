#!/usr/bin/env bash
# Bundle the local video editor engine (voxtale-editor/video/editor/local) for the
# desktop's local build: one Node ESM file plus the graphics sandbox kit it
# reads at run time. The output is private and gitignored in the desktop repo.
# Also copies the model keys from this repo's .env into the local build's
# keys.json (this machine only; never into the bundle).
# Usage: tools/build-video-engine.sh [desktop repo]   (default ../voxtale-desktop)
set -euo pipefail
cd "$(dirname "$0")/.."
DESKTOP=${1:-../voxtale-desktop}
OUT="$DESKTOP/apps/desktop/resources/engine"
rm -rf "$OUT"
mkdir -p "$OUT/sandbox"
bun build src/video/editor/local.ts --target node --format esm \
  --minify-syntax --minify-whitespace --outfile "$OUT/engine.mjs"
cp src/video/graphics/sandbox/kit.tsx "$OUT/sandbox/kit.tsx"
echo "engine → $OUT ($(git rev-parse --short HEAD)$(git diff --quiet || echo '+dirty'))" | tee "$OUT/BUILD.txt"

KEYS="$HOME/Library/Application Support/VoxTale Local/voxtale/keys.json"
if [ -f .env ]; then
  mkdir -p "$(dirname "$KEYS")"
  python3 - "$KEYS" <<'PY'
import json, os, sys
env = {}
for line in open(".env"):
    k, _, v = line.strip().partition("=")
    if k in ("OPENROUTER_API_KEY", "ASSEMBLYAI_API_KEY", "ASSEMBLYAI_REGION") and v:
        env[k] = v.strip().strip('"').strip("'")
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f: json.dump(env, f, indent=2)
print(f"keys → {sys.argv[1]} ({', '.join(sorted(env)) or 'none found in .env'})")
PY
fi

# Motion graphics render in Docker (model-written code runs only in the locked sandbox).
if ! docker image inspect voxtale-graphics-sandbox:1 >/dev/null 2>&1; then
  echo "note: no voxtale-graphics-sandbox:1 image (or Docker is off); cuts will have no motion graphics."
  echo "      build it: docker build -t voxtale-graphics-sandbox:1 src/video/graphics/sandbox"
fi
