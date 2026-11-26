#!/bin/sh
# Build the Remotion sandbox image that renders agent graphics in Docker
# (network off, read-only root; see src/video/editor/agent/remotion.ts).
# The local MCP renders on this machine and does not need it; the desktop
# build and any sandboxed run do. Needs Docker with BuildKit (the default
# since Docker 23). Takes a few minutes and about 1.5 GB.
#
#   tools/build-remotion-sandbox.sh [tag]     default voxtale-remotion-sandbox:2
#   bun run build:sandbox
#
# The tag must match REMOTION_IMAGE in remotion.ts (or set VOXTALE_REMOTION_IMAGE).
set -eu
cd "$(dirname "$0")/.."
TAG=${1:-${VOXTALE_REMOTION_IMAGE:-voxtale-remotion-sandbox:2}}
command -v docker >/dev/null || { echo "no docker on PATH" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running" >&2; exit 1; }
[ -f apps/editor-mcp/fonts/PixelifySans-Regular.ttf ] || { echo "missing apps/editor-mcp/fonts/PixelifySans-Regular.ttf" >&2; exit 1; }
DOCKER_BUILDKIT=1 docker build \
  --build-context fonts=apps/editor-mcp/fonts \
  -t "$TAG" src/video/editor/agent/sandbox/remotion
echo "built $TAG"
