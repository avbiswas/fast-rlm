import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFsioServer } from "./fsio.ts";

const server = createFsioServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[fsio] MCP server connected over stdio");
