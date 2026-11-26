// The local editor MCP: the editor tools on the creator's machine, over stdio.
// apps/editor-mcp runs it; see that app's README.
export {localEditorServer,runLocalEditor,type LocalEditorOptions,type LocalEditorServer} from './server';
export {mcpHandler,serveStdio,type McpServer,type McpTool} from '../agent/mcp-protocol';
