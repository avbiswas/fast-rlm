import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const FRUITS = [
  "apple", "banana", "cherry", "date", "elderberry", "fig", "grape",
  "honeydew", "kiwi", "lemon", "mango", "nectarine", "orange", "pear",
  "quince", "raspberry", "strawberry", "tangerine", "watermelon",
];

/**
 * Build a fresh MCP server instance.
 *
 * The same definition is shared by both transport entrypoints (stdio.ts and
 * http.ts). For stateless HTTP we build one of these per request; for stdio we
 * build a single long-lived one.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "fast-rlm-testbed",
    version: "1.0.0",
  });

  // ---- Tools --------------------------------------------------------------

  server.registerTool(
    "add",
    {
      title: "Add",
      description: "Add two numbers and return the sum.",
      inputSchema: { a: z.number(), b: z.number() },
    },
    ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    }),
  );

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echo back the provided text (round-trip / string test).",
      inputSchema: { text: z.string() },
    },
    ({ text }) => ({
      content: [{ type: "text", text }],
    }),
  );

  server.registerTool(
    "now",
    {
      title: "Now",
      description: "Return the current server time as an ISO-8601 string. Takes no arguments.",
      inputSchema: {},
    },
    () => ({
      content: [{ type: "text", text: new Date().toISOString() }],
    }),
  );

  server.registerTool(
    "random_fruits",
    {
      title: "Random fruits",
      description:
        "Return a JSON array of `count` random fruit names (structured / array-result test).",
      inputSchema: { count: z.number().int().min(1).max(100).default(5) },
    },
    ({ count }) => {
      const picked = Array.from(
        { length: count },
        () => FRUITS[Math.floor(Math.random() * FRUITS.length)],
      );
      return {
        // `structuredContent` rides alongside a text fallback so clients that
        // only read text still get something usable.
        content: [{ type: "text", text: JSON.stringify(picked) }],
        structuredContent: { fruits: picked },
      };
    },
  );

  server.registerTool(
    "big_text",
    {
      title: "Big text",
      description:
        "Return a large block of placeholder text (`paragraphs` paragraphs). " +
        "Used to test large-result handling / truncation in the RLM REPL.",
      inputSchema: { paragraphs: z.number().int().min(1).max(2000).default(50) },
    },
    ({ paragraphs }) => {
      const para =
        "Recursive language models explore long context programmatically " +
        "instead of loading it all into the prompt. ";
      const text = Array.from(
        { length: paragraphs },
        (_, i) => `[para ${i + 1}] ${para.repeat(8)}`,
      ).join("\n\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "fail",
    {
      title: "Fail",
      description:
        "Always throws an error with the given message. Used to test error propagation.",
      inputSchema: { message: z.string().default("intentional test failure") },
    },
    ({ message }) => {
      throw new Error(message);
    },
  );

  // ---- Resources ----------------------------------------------------------

  // Static resource.
  server.registerResource(
    "greeting",
    "testbed://greeting",
    {
      title: "Greeting",
      description: "A static greeting from the testbed server.",
      mimeType: "text/plain",
    },
    (uri) => ({
      contents: [{ uri: uri.href, text: "Hello from the fast-rlm MCP testbed!" }],
    }),
  );

  // Static JSON resource.
  server.registerResource(
    "fruit-catalog",
    "testbed://fruits.json",
    {
      title: "Fruit catalog",
      description: "The full list of fruits known to the server, as JSON.",
      mimeType: "application/json",
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(FRUITS, null, 2) }],
    }),
  );

  // Templated / dynamic resource: testbed://fruit/{name}
  server.registerResource(
    "fruit",
    new ResourceTemplate("testbed://fruit/{name}", { list: undefined }),
    {
      title: "Fruit info",
      description: "Information about a single fruit, addressed by name.",
      mimeType: "text/plain",
    },
    (uri, { name }) => {
      const known = FRUITS.includes(String(name));
      return {
        contents: [
          {
            uri: uri.href,
            text: known
              ? `${name} is a known fruit in the testbed catalog.`
              : `${name} is NOT in the testbed catalog. Known fruits: ${FRUITS.join(", ")}.`,
          },
        ],
      };
    },
  );

  // ---- Prompts ------------------------------------------------------------

  server.registerPrompt(
    "summarize",
    {
      title: "Summarize",
      description: "A reusable prompt template that asks for a summary of some text.",
      argsSchema: { text: z.string(), style: z.string().optional() },
    },
    ({ text, style }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Summarize the following text${style ? ` in a ${style} style` : ""}:\n\n${text}`,
          },
        },
      ],
    }),
  );

  return server;
}
