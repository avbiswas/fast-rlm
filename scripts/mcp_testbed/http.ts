import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.ts";

const PORT = Number(process.env.PORT ?? 3333);
const ENDPOINT = "/mcp";

const app = express();
app.use(express.json());

// One transport per session, keyed by the server-issued session id.
const transports: Record<string, StreamableHTTPServerTransport> = {};

// POST /mcp — client → server JSON-RPC. The very first request (an
// `initialize`) has no session id; we mint one and stand up a transport. All
// subsequent requests carry the `mcp-session-id` header and reuse it.
app.post(ENDPOINT, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  let transport: StreamableHTTPServerTransport;
  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
        console.error(`[testbed] session initialized: ${sid}`);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.error(`[testbed] session closed: ${transport.sessionId}`);
      }
    };
    // Fresh server instance bound to this session's transport.
    await createServer().connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: no valid session id" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// GET /mcp — opens the server→client SSE stream for notifications.
// DELETE /mcp — terminates the session.
const handleSessionRequest = async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session id");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
};

app.get(ENDPOINT, handleSessionRequest);
app.delete(ENDPOINT, handleSessionRequest);

app.listen(PORT, () => {
  console.error(`[testbed] MCP server (Streamable HTTP) listening on http://localhost:${PORT}${ENDPOINT}`);
});
