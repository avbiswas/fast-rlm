import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Smoke test: connect to the testbed server over the chosen transport, then
// enumerate and exercise every primitive (tools, resources, prompts).
//
//   bun run client.ts stdio
//   bun run client.ts http   (server must already be running: bun run http)

const mode = (process.argv[2] ?? "stdio").toLowerCase();
const HTTP_URL = process.env.MCP_URL ?? "http://localhost:3333/mcp";

function header(s: string) {
  console.log(`\n=== ${s} ===`);
}

async function main() {
  const client = new Client({ name: "testbed-smoke-client", version: "1.0.0" });

  if (mode === "stdio") {
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", "stdio.ts"],
    });
    await client.connect(transport);
  } else if (mode === "http") {
    const transport = new StreamableHTTPClientTransport(new URL(HTTP_URL));
    await client.connect(transport);
  } else {
    throw new Error(`Unknown mode '${mode}'. Use 'stdio' or 'http'.`);
  }

  console.log(`Connected over ${mode}.`);

  header("tools/list");
  const { tools } = await client.listTools();
  for (const t of tools) console.log(`- ${t.name}: ${t.description}`);

  header("tools/call add(2, 3)");
  console.log(JSON.stringify(await client.callTool({ name: "add", arguments: { a: 2, b: 3 } }), null, 2));

  header("tools/call random_fruits(count=4)");
  console.log(JSON.stringify(await client.callTool({ name: "random_fruits", arguments: { count: 4 } }), null, 2));

  header("tools/call fail() — expect an error result");
  console.log(JSON.stringify(await client.callTool({ name: "fail", arguments: {} }), null, 2));

  header("resources/list");
  const { resources } = await client.listResources();
  for (const r of resources) console.log(`- ${r.uri} (${r.name}): ${r.description ?? ""}`);

  header("resources/templates/list");
  const { resourceTemplates } = await client.listResourceTemplates();
  for (const t of resourceTemplates) console.log(`- ${t.uriTemplate} (${t.name}): ${t.description ?? ""}`);

  header("resources/read testbed://greeting");
  console.log(JSON.stringify(await client.readResource({ uri: "testbed://greeting" }), null, 2));

  header("resources/read testbed://fruit/mango (templated)");
  console.log(JSON.stringify(await client.readResource({ uri: "testbed://fruit/mango" }), null, 2));

  header("prompts/list");
  const { prompts } = await client.listPrompts();
  for (const p of prompts) console.log(`- ${p.name}: ${p.description ?? ""}`);

  header("prompts/get summarize");
  console.log(JSON.stringify(await client.getPrompt({ name: "summarize", arguments: { text: "hello world", style: "terse" } }), null, 2));

  await client.close();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Client error:", err);
  process.exit(1);
});
