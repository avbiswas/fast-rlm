// Host-side MCP client manager.
//
// The MCP client lives here, in the Deno host — NOT inside the Pyodide REPL,
// which is a pure-WASM sandbox with no subprocess/socket access. The REPL
// reaches MCP tools through thin Python proxies that bridge out to this module
// (the same pattern as `__js_llm_query__` in subagents.ts).
//
// One pool is opened once at process start and shared across the root agent and
// every recursive sub-agent (they all run in this one Deno process).
import { Client } from "npm:@modelcontextprotocol/sdk@1.29.0/client/index.js";
import { StdioClientTransport } from "npm:@modelcontextprotocol/sdk@1.29.0/client/stdio.js";
import { StreamableHTTPClientTransport } from "npm:@modelcontextprotocol/sdk@1.29.0/client/streamableHttp.js";

export interface StdioServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
}
export interface HttpServerConfig {
    url: string;
    headers?: Record<string, string>;
}
export type ServerConfig = StdioServerConfig | HttpServerConfig;
export type McpServersConfig = Record<string, ServerConfig>;

function isHttp(c: ServerConfig): c is HttpServerConfig {
    return typeof (c as HttpServerConfig).url === "string";
}

export interface McpToolInfo {
    server: string;
    name: string;
    description: string;
    inputSchema: unknown;
}
export interface McpResourceInfo {
    server: string;
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}
export interface McpResourceTemplateInfo {
    server: string;
    uriTemplate: string;
    name: string;
    description?: string;
    mimeType?: string;
}

export interface McpHandle {
    tools: McpToolInfo[];
    resources: McpResourceInfo[];
    resourceTemplates: McpResourceTemplateInfo[];
    serverNames: string[];
    // Returns the raw MCP result (content / structuredContent / isError) as a
    // JSON string. The Python proxy applies the marshaling rule + raises on error.
    callTool(server: string, tool: string, args: Record<string, unknown>): Promise<string>;
    readResource(server: string, uri: string): Promise<string>;
    closeAll(): Promise<void>;
}

export async function connectMcpServers(configs: McpServersConfig): Promise<McpHandle> {
    const clients = new Map<string, Client>();
    const tools: McpToolInfo[] = [];
    const resources: McpResourceInfo[] = [];
    const resourceTemplates: McpResourceTemplateInfo[] = [];

    for (const [name, cfg] of Object.entries(configs)) {
        const client = new Client({ name: `fast-rlm-${name}`, version: "1.0.0" });
        try {
            if (isHttp(cfg)) {
                const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
                    requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
                });
                await client.connect(transport);
            } else {
                const transport = new StdioClientTransport({
                    command: cfg.command,
                    args: cfg.args ?? [],
                    env: { ...Deno.env.toObject(), ...(cfg.env ?? {}) },
                    cwd: cfg.cwd,
                });
                await client.connect(transport);
            }
        } catch (e) {
            // Tear down whatever connected so far, then surface a clear error.
            for (const c of clients.values()) { try { await c.close(); } catch { /* ignore */ } }
            throw new Error(
                `Failed to connect MCP server '${name}': ${e instanceof Error ? e.message : String(e)}`
            );
        }
        clients.set(name, client);

        // Discover tools.
        try {
            const listed = await client.listTools();
            for (const t of listed.tools) {
                tools.push({
                    server: name,
                    name: t.name,
                    description: t.description ?? "",
                    inputSchema: t.inputSchema ?? { type: "object" },
                });
            }
        } catch { /* server may not support tools */ }

        // Discover resources (best-effort; templated resources won't be listed).
        try {
            const listed = await client.listResources();
            for (const r of listed.resources) {
                resources.push({
                    server: name,
                    uri: r.uri,
                    name: r.name ?? r.uri,
                    description: r.description,
                    mimeType: r.mimeType,
                });
            }
        } catch { /* server may not support resources */ }

        // Discover resource templates (parameterized URIs the agent can fill in).
        try {
            const listed = await client.listResourceTemplates();
            for (const t of listed.resourceTemplates) {
                resourceTemplates.push({
                    server: name,
                    uriTemplate: t.uriTemplate,
                    name: t.name ?? t.uriTemplate,
                    description: t.description,
                    mimeType: t.mimeType,
                });
            }
        } catch { /* server may not support resource templates */ }
    }

    const requireClient = (server: string): Client => {
        const c = clients.get(server);
        if (!c) throw new Error(`Unknown MCP server '${server}'. Known: ${[...clients.keys()].join(", ")}`);
        return c;
    };

    return {
        tools,
        resources,
        resourceTemplates,
        serverNames: [...clients.keys()],
        async callTool(server, tool, args) {
            const result = await requireClient(server).callTool({ name: tool, arguments: args });
            return JSON.stringify(result);
        },
        async readResource(server, uri) {
            const result = await requireClient(server).readResource({ uri });
            return JSON.stringify(result);
        },
        async closeAll() {
            for (const c of clients.values()) { try { await c.close(); } catch { /* ignore */ } }
        },
    };
}

// Returns true if any configured server uses the stdio transport (i.e. Deno
// must be granted --allow-run to spawn it).
export function hasStdioServer(configs: McpServersConfig): boolean {
    return Object.values(configs).some((c) => !isHttp(c));
}
