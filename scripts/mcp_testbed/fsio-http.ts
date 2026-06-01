import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createFsioServer } from "./fsio.ts";

const PORT = Number(process.env.PORT ?? 3334);
const ENDPOINT = "/mcp";

const app = express();
app.use(express.json());

const transports: Record<string, StreamableHTTPServerTransport> = {};

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
        console.error(`[fsio] session initialized: ${sid}`);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    await createFsioServer().connect(transport);
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
  console.error(`[fsio] MCP server (Streamable HTTP) listening on http://localhost:${PORT}${ENDPOINT}`);
});
