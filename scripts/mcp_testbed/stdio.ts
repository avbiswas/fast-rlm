import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";

// stdio transport: the client (e.g. the fast-rlm Deno host) spawns this file as
// a subprocess and speaks JSON-RPC over stdin/stdout. Nothing may be written to
// stdout except protocol frames — logs go to stderr.
const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[testbed] MCP server connected over stdio");
