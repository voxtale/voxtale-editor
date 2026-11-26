# Usage

## MCP server

`bun run mcp` starts the stdio server. Setup per client: [apps/editor-mcp/README.md](../apps/editor-mcp/README.md).

## Staged CLI

`bun run editor --help` runs the core video module. See [video module](../src/video/README.md) for the
staged workflow and injected API. Existing transcripts can be reused:
```sh
bun run editor select-takes edit.json --transcript production-v1/transcript.json --out data/video/takes-v2
bun run editor graphics data/video/takes-v2/edit.json --transcript production-v1/transcript.json --out data/video/graphics-v2
bun run editor preview data/video/graphics-v2/edit.json --out data/video/preview-v2
```
