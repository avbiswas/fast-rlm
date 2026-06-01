import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";

const execAsync = promisify(exec);

// Filesystem ops are confined to ROOT. Override with FSIO_ROOT; defaults to the
// process cwd. This is the only guard rail — see the README's warning: a shell
// MCP server is full host access, NOT a sandbox.
const ROOT = resolve(process.env.FSIO_ROOT ?? process.cwd());
mkdirSync(ROOT, { recursive: true }); // ensure the root exists so cwd is valid
const CMD_TIMEOUT_MS = Number(process.env.FSIO_CMD_TIMEOUT_MS ?? 10000);

// Resolve a user-supplied path against ROOT and refuse anything that escapes it.
function resolveInRoot(p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(join(ROOT, p));
  const rel = relative(ROOT, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes root: ${p} (root is ${ROOT})`);
  }
  return abs;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export function createFsioServer(): McpServer {
  const server = new McpServer({ name: "fast-rlm-fsio", version: "1.0.0" });

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: `Read a UTF-8 text file. Paths are relative to the server root (${ROOT}).`,
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      try {
        return ok(await readFile(resolveInRoot(path), "utf8"));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description: `Write (overwrite) a UTF-8 text file. Paths are relative to the server root (${ROOT}).`,
      inputSchema: { path: z.string(), content: z.string() },
    },
    async ({ path, content }) => {
      try {
        const abs = resolveInRoot(path);
        await writeFile(abs, content, "utf8");
        return ok(`Wrote ${content.length} bytes to ${relative(ROOT, abs)}`);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "list_dir",
    {
      title: "List directory",
      description: `List entries in a directory. Paths are relative to the server root (${ROOT}). Defaults to root.`,
      inputSchema: { path: z.string().default(".") },
    },
    async ({ path }) => {
      try {
        const abs = resolveInRoot(path);
        const names = await readdir(abs);
        const lines = await Promise.all(
          names.map(async (n) => {
            const s = await stat(join(abs, n));
            return `${s.isDirectory() ? "d" : "-"} ${n}${s.isDirectory() ? "/" : ` (${s.size}b)`}`;
          }),
        );
        return ok(lines.join("\n") || "(empty)");
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "run_command",
    {
      title: "Run shell command",
      description:
        `Run a shell command and return its stdout, stderr, and exit code. ` +
        `Runs in the server root (${ROOT}) with a ${CMD_TIMEOUT_MS}ms timeout. ` +
        `WARNING: full host access, not sandboxed.`,
      inputSchema: { command: z.string() },
    },
    async ({ command }) => {
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: ROOT,
          timeout: CMD_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
        });
        return ok(`exit: 0\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
      } catch (e) {
        // exec rejects on non-zero exit; surface code + captured output.
        const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
        return fail(
          `exit: ${err.code ?? "?"}\n--- stdout ---\n${err.stdout ?? ""}\n` +
          `--- stderr ---\n${err.stderr ?? err.message ?? ""}`,
        );
      }
    },
  );

  return server;
}
