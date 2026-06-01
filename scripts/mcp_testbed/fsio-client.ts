import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Smoke test for the filesystem + terminal-IO server, over either transport.
//   bun run fsio-client.ts stdio
//   bun run fsio-client.ts http    (server must be running: bun run fsio-http)
//
// Runs against a scratch root so it doesn't touch the repo.

const mode = (process.argv[2] ?? "stdio").toLowerCase();
const HTTP_URL = process.env.MCP_URL ?? "http://localhost:3334/mcp";

function header(s: string) {
  console.log(`\n=== ${s} ===`);
}

async function main() {
  const client = new Client({ name: "fsio-smoke-client", version: "1.0.0" });

  if (mode === "stdio") {
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", "fsio-stdio.ts"],
      env: { ...process.env, FSIO_ROOT: "/tmp/fsio-scratch" },
    });
    await client.connect(transport);
  } else if (mode === "http") {
    await client.connect(new StreamableHTTPClientTransport(new URL(HTTP_URL)));
  } else {
    throw new Error(`Unknown mode '${mode}'. Use 'stdio' or 'http'.`);
  }
  console.log(`Connected over ${mode}.`);

  header("tools/list");
  const { tools } = await client.listTools();
  for (const t of tools) console.log(`- ${t.name}: ${t.description}`);

  header("run_command: mkdir -p the scratch root, then echo");
  console.log(JSON.stringify(await client.callTool({ name: "run_command", arguments: { command: "mkdir -p /tmp/fsio-scratch && echo hello-from-shell" } }), null, 2));

  header("write_file note.txt");
  console.log(JSON.stringify(await client.callTool({ name: "write_file", arguments: { path: "note.txt", content: "written via MCP\n" } }), null, 2));

  header("list_dir .");
  console.log(JSON.stringify(await client.callTool({ name: "list_dir", arguments: { path: "." } }), null, 2));

  header("read_file note.txt");
  console.log(JSON.stringify(await client.callTool({ name: "read_file", arguments: { path: "note.txt" } }), null, 2));

  header("read_file ../escape — expect error (path confinement)");
  console.log(JSON.stringify(await client.callTool({ name: "read_file", arguments: { path: "../../etc/hosts" } }), null, 2));

  await client.close();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Client error:", err);
  process.exit(1);
});
