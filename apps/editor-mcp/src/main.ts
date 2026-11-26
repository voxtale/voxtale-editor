// VoxTale editor MCP server (stdio) on this machine. All the logic is in core
// (supertale/video/editor/mcp); this file only points it at the fonts.
//
//   claude mcp add voxtale-editor -e ASSEMBLYAI_API_KEY=… -- bun <repo>/apps/editor-mcp/src/main.ts
import {join} from 'node:path';
import {runLocalEditor} from 'voxtale-editor/mcp';

await runLocalEditor({fontsDir:join(import.meta.dir,'..','fonts')});
