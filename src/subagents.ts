import { loadPyodide } from "pyodide";
// ajv ships as CJS; Deno's npm interop wraps the default export in a namespace
// whose `.default` property is the actual constructor.
// deno-lint-ignore no-explicit-any
import * as AjvNs from "ajv";
// deno-lint-ignore no-explicit-any
const Ajv: any = (AjvNs as any).default ?? AjvNs;
interface AjvError {
    instancePath?: string;
    message?: string;
    params?: Record<string, unknown>;
}
interface ValidateFunction {
    (data: unknown): boolean;
    errors?: AjvError[] | null;
}
import { confirmDelegation, generate_code, Usage } from "./call_llm.ts";
import { loadConfig } from "./config.ts";
import { isAcpModel } from "./acp.ts";
// MCP is optional: only the *types* are imported statically (erased at compile,
// so they pull in nothing at runtime). The implementation in ./mcp.ts — and its
// heavy `@modelcontextprotocol/sdk` npm dependency — is loaded lazily via dynamic
// import() below, only when the run actually configures MCP servers. Runs without
// MCP never fetch or load the SDK.
import type { McpHandle, McpServersConfig } from "./mcp.ts";
import { Logger, setLogDir, setLogPrefix, getLogFile } from "./logging.ts";
import { startSpinner, showGlobalUsage } from "./ui.ts";
import { trackUsage, getTotalUsage, resetUsage, trackCall, getTotalCalls } from "./usage.ts";
import chalk from "npm:chalk@5";

const _ajv = new Ajv({ strict: false, allErrors: true });

function compileSchema(schema: unknown): ValidateFunction | null {
    if (schema == null) return null;
    try {
        return _ajv.compile(schema as object);
    } catch (e) {
        throw new Error(
            `Invalid output schema: ${e instanceof Error ? e.message : String(e)}`
        );
    }
}

function formatValidationErrors(validate: ValidateFunction): string {
    if (!validate.errors) return "(no error details)";
    return validate.errors
        .map((e) => {
            const path = e.instancePath || "(root)";
            return `  - ${path}: ${e.message}${
                e.params && Object.keys(e.params).length
                    ? ` [${JSON.stringify(e.params)}]`
                    : ""
            }`;
        })
        .join("\n");
}

const _config = loadConfig();
const MAX_CALLS = _config.max_calls_per_subagent ?? 20;
const MAX_DEPTH = _config.max_depth ?? 3;
const TRUNCATE_LEN = _config.truncate_len ?? 5000;
// primary_agent is required (no default). sub_agent falls back to primary_agent.
function requirePrimaryAgent(): string {
    const p = _config.primary_agent;
    if (!p) {
        throw new Error(
            "primary_agent is required and has no default — set it in the config " +
            "(e.g. rlm_config.yaml or RLMConfig(primary_agent=...)).",
        );
    }
    return p;
}
const PRIMARY_AGENT: string = requirePrimaryAgent();
const SUB_AGENT: string = _config.sub_agent ?? PRIMARY_AGENT;
const MAX_MONEY_SPENT = _config.max_money_spent ?? Infinity;
const MAX_COMPLETION_TOKENS = _config.max_completion_tokens ?? 50000;
const MAX_PROMPT_TOKENS = _config.max_prompt_tokens ?? 200000;
// ACP runs have no working token/cost budget (usage is always zero), so they get
// a default global call ceiling of 50 unless overridden. Other backends stay
// unlimited by default and rely on the token/cost budgets.
const _acpRun = isAcpModel(PRIMARY_AGENT) || isAcpModel(SUB_AGENT);
const MAX_GLOBAL_CALLS = _config.max_global_calls ?? (_acpRun ? 50 : Infinity);
const API_MAX_RETRIES = _config.api_max_retries ?? 3;
const API_TIMEOUT_MS = _config.api_timeout_ms ?? 600000;
const ENABLE_TOOLS = _config.enable_tools ?? true;
const ENABLE_STRUCTURED_IO = _config.enable_structured_io ?? true;
const ENABLE_COMPRESSION_GUARD = _config.enable_compression_guard ?? true;
const COMPRESSION_MIN_CHARS = _config.compression_min_chars ?? 5000;
const COMPRESSION_RATIO = _config.compression_ratio ?? 0.6;
// run(instruction=...) — applies to the ROOT agent only. Sub-agents are NOT given
// this; they receive an instruction only when their parent passes one explicitly
// via llm_query(instruction=...). There is intentionally no global instruction.
const ROOT_INSTRUCTION = _config.instruction ?? null;

function truncateText(text: string): string {
    let truncatedOutput = "";
    if (text.length > TRUNCATE_LEN) {
        truncatedOutput = `[TRUNCATED: Last ${TRUNCATE_LEN} chars shown].. ` + text.slice(-TRUNCATE_LEN);
    } else {
        if (text.length == 0) {
            truncatedOutput = "[EMPTY OUTPUT]";
        }
        else {
            truncatedOutput = "[FULL OUTPUT SHOWN]... " + text;
        }
    }
    return truncatedOutput;

}

function now(): string {
    return new Date().toISOString();
}

// Banner prepended to step-output messages once the budget is past halfway.
// Below 50% used we say nothing (don't burn tokens reminding a fresh agent).
function budgetBanner(stepJustFinished: number, maxCalls: number): string {
    const used = stepJustFinished + 1; // i is 0-indexed; +1 = steps consumed
    if (used * 2 < maxCalls) return ""; // < 50% used → silent
    const remaining = maxCalls - used;
    return (
        `[Steps remaining after this one: ${remaining} / ${maxCalls}]\n` +
        `[You can call a subagent via llm_query(...) to finish smaller tasks if ` +
        `needed. Use a divide-and-conquer strategy.]\n`
    );
}

type Context = string | Record<string, unknown> | unknown[];
type JsonSchema = Record<string, unknown>;

export async function subagent(
    context: Context,
    subagent_depth = 0,
    parent_run_id?: string,
    outputSchema?: JsonSchema | null,
    toolSources?: string[] | null,
    envVars?: Record<string, string> | null,
    mcp?: McpHandle | null,
    // Which MCP servers this agent may see: null = all (root), [] = none
    // (default for sub-agents), [names] = the subset the parent granted.
    mcpAllowedServers?: string[] | null,
    // Extra LLM params (temperature, top_p, seed, ...) passed to every API call,
    // inherited by all sub-agents. From run(llm_kwargs=...).
    llmKwargs?: Record<string, unknown> | null,
    // Set by the parent when its delegation tripped the compression heuristic;
    // this agent must self-confirm (YES/NO) before running its loop.
    confirmInfo?: { childChars: number; parentChars: number } | null,
    // Instruction shown to THIS agent only, appended to its system prompt. Set by
    // whoever spawned it: run(instruction=...) for the root, or
    // llm_query(instruction=...) for a child. Never inherited — a child sees only
    // what its parent explicitly passed, with no carry-on from ancestors.
    instruction?: string | null,
) {
    // Structured I/O ablation: when disabled, ignore any requested output schema
    // (no validation, no schema preamble) and present dict/list contexts as plain
    // strings instead of running the structured flat-schema probe.
    const effectiveSchema = ENABLE_STRUCTURED_IO ? (outputSchema ?? null) : null;
    const effectiveContext: Context = (!ENABLE_STRUCTURED_IO && typeof context !== "string")
        ? JSON.stringify(context)
        : context;
    const validate = compileSchema(effectiveSchema);
    const logger = new Logger(subagent_depth, MAX_CALLS, parent_run_id);
    logger.logAgentStart();

    const model_name = subagent_depth == 0 ? PRIMARY_AGENT : SUB_AGENT;
    const is_leaf_agent = subagent_depth == MAX_DEPTH;
    let stdoutBuffer = "";

    const pyodide = await loadPyodide({
        stderr: (text: string) => console.error(`[Python Stderr]: ${text}`),
        stdout: (text: string) => {
            stdoutBuffer += text + "\n";
        },
    });
    console.log("✔ Python Ready");

    // Make `requests` work inside the WASM REPL:
    //   1. loadPackage("micropip") — bundled with Pyodide, no network needed.
    //   2. micropip.install("requests", "pyodide-http") — pure-Python wheels.
    //   3. pyodide_http.patch_all() — routes requests/urllib through host fetch.
    // After this, any tool can `import requests; requests.get(...)` as normal.
    const envSetupStart = Date.now();
    await pyodide.loadPackage("micropip");
    await pyodide.runPythonAsync(`
import micropip
await micropip.install(["requests", "httpx"])
`);
    const envSetupMs = Date.now() - envSetupStart;
    console.log(`✔ requests + httpx ready (env setup took ${envSetupMs}ms)`);

    const pyProxyToJs = (val: unknown): unknown => {
        if (val && typeof (val as { toJs?: unknown }).toJs === "function") {
            return (val as { toJs: (opts: unknown) => unknown }).toJs({
                dict_converter: Object.fromEntries,
            });
        }
        return val;
    };

    const js_llm_query = async (
        context: unknown,
        child_schema?: unknown,
        child_tool_sources?: unknown,
        child_mcp_servers?: unknown,
        // Instruction for the spawned child only (from llm_query(instruction=...)).
        child_instruction?: unknown,
        // Set by batch_llm_query: the batch was already judged once, so skip the
        // per-call compression guard for these children.
        suppress_guard?: unknown,
    ) => {
        if (subagent_depth >= MAX_DEPTH) {
            stdoutBuffer += "\nError: MAXIMUM DEPTH REACHED. You must solve this task on your own without calling llm_query.\n";
            throw new Error("MAXIMUM DEPTH REACHED. You must solve this task on your own without calling llm_query.");
        }
        // Dict/list contexts arrive as PyProxy from Python; same for schema and tools.
        const plain = pyProxyToJs(context) as Context;
        if (typeof plain !== "string" && (typeof plain !== "object" || plain === null)) {
            throw new Error(
                `llm_query expects a string or dict/list context, got ${typeof plain}`
            );
        }
        let childSchema: JsonSchema | null = null;
        if (child_schema != null && ENABLE_STRUCTURED_IO) {
            const s = pyProxyToJs(child_schema);
            if (typeof s !== "object" || s === null || Array.isArray(s)) {
                throw new Error(
                    `llm_query output_schema must be a JSON Schema dict, got ${typeof s}`
                );
            }
            childSchema = s as JsonSchema;
        }
        let childTools: string[] | null = null;
        if (child_tool_sources != null && ENABLE_TOOLS) {
            const t = pyProxyToJs(child_tool_sources);
            if (!Array.isArray(t) || !t.every((x) => typeof x === "string")) {
                throw new Error(
                    `llm_query tools must be a list of Python functions (received non-string sources)`
                );
            }
            childTools = t as string[];
        }
        // Sub-agents inherit NO MCP servers unless the parent grants them by
        // name (server-level). Default → [] (none).
        let childMcpServers: string[] = [];
        if (child_mcp_servers != null) {
            const m = pyProxyToJs(child_mcp_servers);
            if (!Array.isArray(m) || !m.every((x) => typeof x === "string")) {
                throw new Error(
                    `llm_query mcp must be a list of server-name strings, got ${typeof m}`
                );
            }
            childMcpServers = m as string[];
        }
        // Instruction for the child only — never inherited from this agent.
        let childInstruction: string | null = null;
        if (child_instruction != null) {
            const ci = pyProxyToJs(child_instruction);
            if (typeof ci !== "string") {
                throw new Error(
                    `llm_query instruction must be a string, got ${typeof ci}`
                );
            }
            childInstruction = ci;
        }
        console.log("↳ llm_query called");

        // Compression guard: if this delegation ships a large, barely-compressed
        // context, flag the child to self-confirm before it runs.
        let confirmInfo: { childChars: number; parentChars: number } | null = null;
        if (ENABLE_COMPRESSION_GUARD && !suppress_guard) {
            const sizeOf = (v: unknown) =>
                typeof v === "string" ? v.length : JSON.stringify(v).length;
            const parentChars = sizeOf(context);
            const childChars = sizeOf(plain);
            if (parentChars >= COMPRESSION_MIN_CHARS &&
                childChars >= COMPRESSION_RATIO * parentChars) {
                confirmInfo = { childChars, parentChars };
            }
        }

        const output = await subagent(
            plain,
            subagent_depth + 1,
            logger.run_id,
            childSchema,
            childTools,
            envVars ?? null,
            mcp ?? null,
            childMcpServers,
            llmKwargs ?? null,
            confirmInfo,
            childInstruction,
        );
        return output;
    };
    pyodide.globals.set("__js_llm_query__", js_llm_query);

    // ---- Batch compression guard -------------------------------------------
    // batch_llm_query (a drop-in for asyncio.gather over llm_query calls) routes
    // here ONCE for the whole fan-out. Python passes {parentChars, items:[{childChars,
    // preview}]}; we apply the same heuristic and, if it trips, make a SINGLE judge
    // call covering the whole batch and return one approve/reject.
    const js_batch_confirm = async (metaJson: unknown): Promise<boolean> => {
        if (!ENABLE_COMPRESSION_GUARD) return true;
        let meta: { parentChars: number; items: { childChars: number; preview: string }[] };
        try {
            meta = JSON.parse(String(metaJson));
        } catch {
            return true; // can't parse → don't block
        }
        const { parentChars, items } = meta;
        if (!items?.length || parentChars < COMPRESSION_MIN_CHARS) return true;
        const tripping = items.filter((it) => it.childChars >= COMPRESSION_RATIO * parentChars);
        if (tripping.length === 0) return true; // legit small-chunk map → no judge

        const lines = items.map((it, i) =>
            `  [${i + 1}] ${it.childChars.toLocaleString()} chars (` +
            `${Math.round((it.childChars / Math.max(1, parentChars)) * 100)}% of your context): ` +
            `${(it.preview || "").slice(0, 140)}`).join("\n");
        const q =
            `STOP — confirmation required before this PARALLEL batch of ${items.length} ` +
            `subagent calls runs.\nYour context is ${parentChars.toLocaleString()} chars. ` +
            `The children would receive:\n${lines}\n${tripping.length} of them get a large, ` +
            `barely-compressed slice of your context. RLM works best when you slice/filter/` +
            `summarize in your OWN repl first and delegate only the reduced result.\n` +
            `Approve the WHOLE batch? Reply YES or NO on the first line, then a one-line reason.`;
        const verdict = await confirmDelegation(
            messages, q, model_name, is_leaf_agent,
            { maxRetries: API_MAX_RETRIES, timeout: API_TIMEOUT_MS },
            {
                enableTools: ENABLE_TOOLS,
                enableStructuredIo: ENABLE_STRUCTURED_IO,
                enableCompressionGuard: ENABLE_COMPRESSION_GUARD,
            },
            llmKwargs ?? null,
        );
        trackCall();
        trackUsage(verdict.usage);
        return verdict.approve;
    };
    pyodide.globals.set("__js_batch_confirm__", js_batch_confirm);

    // ---- MCP bridge --------------------------------------------------------
    // Which servers this agent may see: null → all (root), else the granted set.
    const allowedServers = mcp
        ? (mcpAllowedServers == null
            ? mcp.serverNames
            : mcpAllowedServers.filter((s) => mcp.serverNames.includes(s)))
        : [];
    const scopedTools = mcp ? mcp.tools.filter((t) => allowedServers.includes(t.server)) : [];
    const scopedResources = mcp ? mcp.resources.filter((r) => allowedServers.includes(r.server)) : [];
    const scopedTemplates = mcp ? mcp.resourceTemplates.filter((t) => allowedServers.includes(t.server)) : [];
    const mcpData = {
        // null means "all servers" (root agent); a list means an explicit grant.
        allowedServers: mcp && mcpAllowedServers == null ? null : allowedServers,
        tools: scopedTools.map((t) => ({ server: t.server, name: t.name, description: t.description })),
        schemas: Object.fromEntries(scopedTools.map((t) => [`${t.server}.${t.name}`, t.inputSchema])),
        resources: scopedResources,
        resourceTemplates: scopedTemplates,
    };
    const mcpEnabled = mcp != null && (allowedServers.length > 0 || mcpData.allowedServers === null);

    if (mcpEnabled) {
        pyodide.globals.set("__js_mcp_call__", async (server: unknown, tool: unknown, args: unknown) => {
            const a = (pyProxyToJs(args) ?? {}) as Record<string, unknown>;
            return await mcp!.callTool(String(server), String(tool), a);
        });
        pyodide.globals.set("__js_mcp_read_resource__", async (server: unknown, uri: unknown) => {
            return await mcp!.readResource(String(server), String(uri));
        });
    }

    // Initialize context. Strings are embedded as Python string literals;
    // dicts/lists are passed through json.loads so the agent gets a real
    // Python dict/list (not a JsProxy).
    const contextLiteral = typeof effectiveContext === "string"
        ? JSON.stringify(effectiveContext)
        : `__import__('json').loads(${JSON.stringify(JSON.stringify(effectiveContext))})`;
    const envInjection = envVars && Object.keys(envVars).length
        ? `import os, json as _json
os.environ.update(_json.loads(${JSON.stringify(JSON.stringify(envVars))}))
`
        : "";
    const setup_code = `
${envInjection}context = ${contextLiteral}
__final_result__ = None
__final_result_set__ = False

def FINAL(x):
    global __final_result__, __final_result_set__
    __final_result__ = x
    __final_result_set__ = True

__tools__ = []

# Pretty-print Pydantic models, JsProxy objects, and nested dicts/lists as
# JSON. Plain strings/numbers/etc. fall through to the original print.
import builtins as __builtins__
__real_print__ = __builtins__.print

def __coerce_for_print__(o, _seen=None):
    if _seen is None:
        _seen = set()
    _oid = id(o)
    if _oid in _seen:
        return o
    try:
        from pydantic import BaseModel as __BaseModel
        if isinstance(o, __BaseModel):
            return o.model_dump(mode="json")
    except ImportError:
        pass
    if hasattr(o, "to_py") and not isinstance(o, (str, bytes)):
        try:
            o = o.to_py()
        except Exception:
            return o
    if isinstance(o, dict):
        _seen.add(_oid)
        return {k: __coerce_for_print__(v, _seen) for k, v in o.items()}
    if isinstance(o, (list, tuple, set)):
        _seen.add(_oid)
        return [__coerce_for_print__(x, _seen) for x in o]
    return o

def print(*args, **kwargs):
    import json as __json
    _out = []
    for _a in args:
        _c = __coerce_for_print__(_a)
        if _c is _a or isinstance(_a, (str, bytes, int, float, bool)) or _a is None:
            _out.append(_a)
            continue
        try:
            _out.append(__json.dumps(_c, indent=2, default=str, ensure_ascii=False))
        except Exception:
            _out.append(_a)
    __real_print__(*_out, **kwargs)

__builtins__.print = print

def __register_tool__(src):
    _ns = {}
    exec(src, globals(), _ns)
    _fn = next((v for v in _ns.values() if callable(v)), None)
    if _fn is None:
        raise ValueError("Tool source defined no callable: " + src[:200])
    try:
        _fn.__fast_rlm_source__ = src
    except (AttributeError, TypeError):
        pass
    globals()[_fn.__name__] = _fn
    __tools__.append(_fn)

class _LazyQuery:
    """Awaitable handle for a sub-agent query.

    Awaiting it runs the call normally (with the per-call compression guard).
    batch_llm_query reads its .context up front (one batch judge) and runs it
    with the guard suppressed.
    """
    __slots__ = ("context", "schema", "tools", "mcp", "instruction")

    def __init__(self, context, schema, tools, mcp, instruction):
        self.context = context
        self.schema = schema
        self.tools = tools
        self.mcp = mcp
        self.instruction = instruction

    def __await__(self):
        return self._run(False).__await__()

    async def _run(self, suppress):
        _tool_sources = None
        if self.tools:
            import inspect as _inspect
            _tool_sources = []
            for _t in self.tools:
                _stashed = getattr(_t, "__fast_rlm_source__", None)
                if _stashed is not None:
                    _tool_sources.append(_stashed)
                else:
                    _tool_sources.append(_inspect.getsource(_t))
        _mcp = list(self.mcp) if self.mcp else None
        _result = await __js_llm_query__(self.context, self.schema, _tool_sources, _mcp, self.instruction, suppress)
        if hasattr(_result, "to_py"):
            return _result.to_py()
        return _result


def llm_query(context, schema=None, *, tools=None, mcp=None, instruction=None):
    """Recursively query a sub-agent. Use 'await llm_query(...)'.

    Args:
        context: str or dict — the task/context for the sub-agent.
        schema: optional JSON Schema (as a dict) the sub-agent's FINAL must satisfy.
        tools: optional list of Python functions to expose in the sub-agent's REPL.
            By default the sub-agent does NOT inherit your tools; pass them
            explicitly here if you want the child to have access.
        mcp: optional list of MCP server-name strings to grant the sub-agent.
            By default the sub-agent inherits NO MCP servers; name the ones it
            may use (e.g. mcp=["fsio"]) and it gets that server's tools/resources.
        instruction: optional string directive shown ONLY to this sub-agent
            (appended to its system prompt). It is not inherited by the child's
            own sub-agents and does not carry over from you — pass it again on
            each llm_query call where you want it to apply.
    """
    return _LazyQuery(context, schema, tools, mcp, instruction)


async def batch_llm_query(*queries):
    """Run several sub-agent queries in PARALLEL — a drop-in for
    asyncio.gather(*[llm_query(...), llm_query(...), ...]).

    Unlike asyncio.gather, the whole batch is checked for compression ONCE (a
    single reviewer call decides whether to approve the entire fan-out), instead
    of each call being checked separately. Prefer this over asyncio.gather when
    you delegate to many sub-agents at once. Returns results in order.

        results = await batch_llm_query(llm_query(c1), llm_query(c2), llm_query(c3))
    """
    import asyncio as _asyncio
    import json as _json
    qs = list(queries)
    if len(qs) == 1 and isinstance(qs[0], (list, tuple)):
        qs = list(qs[0])
    if not all(isinstance(q, _LazyQuery) for q in qs):
        raise TypeError("batch_llm_query expects llm_query(...) calls, e.g. "
                        "batch_llm_query(llm_query(a), llm_query(b))")

    def _meta(ctx):
        s = ctx if isinstance(ctx, str) else _json.dumps(ctx)
        return {"childChars": len(s), "preview": s[:160]}

    _parent = context if isinstance(context, str) else _json.dumps(context)
    _payload = {"parentChars": len(_parent), "items": [_meta(q.context) for q in qs]}
    _approved = await __js_batch_confirm__(_json.dumps(_payload))
    if not _approved:
        raise RuntimeError(
            "BATCH_DELEGATION_REJECTED: this parallel batch was declined as "
            "under-compressed. Slice/filter/summarize each context in your OWN "
            "REPL first, then delegate only the reduced results."
        )
    return await _asyncio.gather(*[q._run(True) for q in qs])
${ENABLE_COMPRESSION_GUARD ? `
# Failsafe: block llm_query() handles passed into asyncio.gather, steering the
# model to batch_llm_query (which does one compression check for the whole batch).
# batch_llm_query is unaffected: it passes coroutines (q._run), not _LazyQuery.
import asyncio as _aio_guard
_real_gather = _aio_guard.gather
def _guarded_gather(*aws, **kw):
    if any(isinstance(a, _LazyQuery) for a in aws):
        raise RuntimeError(
            "Do not call llm_query inside asyncio.gather. Use batch_llm_query(...) "
            "instead - it runs them in parallel with a SINGLE compression check. "
            "Example: await batch_llm_query(llm_query(a), llm_query(b))")
    return _real_gather(*aws, **kw)
_aio_guard.gather = _guarded_gather
` : ""}`;
    await pyodide.runPythonAsync(setup_code);

    // Register tools (if any) into the REPL globals + __tools__ list.
    // Skipped entirely when the tools capability is disabled (ablation).
    if (ENABLE_TOOLS && toolSources && toolSources.length) {
        for (const src of toolSources) {
            await pyodide.runPythonAsync(
                `__register_tool__(${JSON.stringify(src)})`
            );
        }
    }

    // Inject MCP proxy functions (scoped to this agent's allowed servers).
    if (mcpEnabled) {
        await pyodide.runPythonAsync(`
import json as _json
__mcp_data__ = _json.loads(${JSON.stringify(JSON.stringify(mcpData))})
__mcp_allowed_servers__ = __mcp_data__["allowedServers"]

def _mcp_check(server):
    if __mcp_allowed_servers__ is not None and server not in __mcp_allowed_servers__:
        raise PermissionError(
            f"MCP server {server!r} is not available to this agent. "
            f"Available: {__mcp_allowed_servers__}"
        )

def mcp_list_tools(server=None):
    """List available MCP tools (name + description). Optionally filter by server."""
    return [
        {"server": t["server"], "name": t["name"], "description": t["description"]}
        for t in __mcp_data__["tools"]
        if server is None or t["server"] == server
    ]

def mcp_tool_schema(name):
    """Return the input JSON Schema for an MCP tool. Accepts 'server.tool' or 'tool' if unambiguous."""
    _schemas = __mcp_data__["schemas"]
    if name in _schemas:
        return _schemas[name]
    _m = [k for k in _schemas if k.split(".", 1)[-1] == name]
    if len(_m) == 1:
        return _schemas[_m[0]]
    if len(_m) > 1:
        raise ValueError(f"Ambiguous tool name {name!r}; use 'server.tool'. Matches: {_m}")
    raise KeyError(f"No such MCP tool: {name!r}")

async def mcp_call(server, tool, **kwargs):
    """Call an MCP tool. Returns structuredContent (dict) if present, else the text result. Raises on tool error."""
    _mcp_check(server)
    _res = _json.loads(await __js_mcp_call__(server, tool, kwargs))
    if _res.get("isError"):
        _txt = " ".join(c.get("text", "") for c in _res.get("content", []) if isinstance(c, dict))
        raise RuntimeError(f"MCP tool {server}.{tool} failed: {_txt}")
    if _res.get("structuredContent") is not None:
        return _res["structuredContent"]
    _texts = [c.get("text", "") for c in _res.get("content", []) if isinstance(c, dict) and c.get("type") == "text"]
    if len(_texts) == 1:
        return _texts[0]
    if _texts:
        return "\\n".join(_texts)
    return _res.get("content")

def mcp_list_resources(server=None):
    """List available MCP resources (uri + name + description). Optionally filter by server."""
    return [r for r in __mcp_data__["resources"] if server is None or r["server"] == server]

def mcp_list_resource_templates(server=None):
    """List MCP resource templates: parameterized uris like 'transcripts://episode/{id}'.
    Fill in the {placeholders} and read the concrete uri with mcp_read_resource(uri, server=...)."""
    return [t for t in __mcp_data__["resourceTemplates"] if server is None or t["server"] == server]

async def mcp_read_resource(uri, server=None):
    """Read an MCP resource by uri. Pass server=... if the uri isn't in mcp_list_resources()."""
    if server is None:
        _cands = sorted({r["server"] for r in __mcp_data__["resources"] if r["uri"] == uri})
        if len(_cands) == 1:
            server = _cands[0]
        elif __mcp_allowed_servers__ is not None and len(__mcp_allowed_servers__) == 1:
            server = __mcp_allowed_servers__[0]
        else:
            raise ValueError(f"Cannot infer server for resource {uri!r}; pass server=...")
    _mcp_check(server)
    _res = _json.loads(await __js_mcp_read_resource__(server, uri))
    _out = [c.get("text") if c.get("text") is not None else c
            for c in _res.get("contents", []) if isinstance(c, dict)]
    return _out[0] if len(_out) == 1 else _out
`);
    }

    const mcpProbeCode = mcpEnabled
        ? `print("---")
_mcp_servers = sorted({s for s in __mcp_allowed_servers__} if __mcp_allowed_servers__ is not None else {t["server"] for t in __mcp_data__["tools"]} | {r["server"] for r in __mcp_data__["resources"]} | {t["server"] for t in __mcp_data__["resourceTemplates"]})
print(f"MCP: {len(mcp_list_tools())} tool(s); {len(mcp_list_resources())} listed resource(s); {len(mcp_list_resource_templates())} resource template(s). Server(s): {_mcp_servers}")
print("  Tools:     mcp_list_tools(server=None) -> names; mcp_tool_schema('server.tool') -> schema; await mcp_call('server','tool',**kwargs)")
print("  Resources: mcp_list_resources(); await mcp_read_resource(uri, server=None)")
if mcp_list_resource_templates():
    print("  Resource templates (fill {placeholders}, then mcp_read_resource(uri, server=...)):")
    for _t in mcp_list_resource_templates():
        print(f"    [{_t['server']}] {_t['uriTemplate']}  -  {_t.get('description','')}")
`
        : "";
    const schemaPreambleCode = effectiveSchema
        ? `print("Required output schema for FINAL (JSON Schema):")
print(${JSON.stringify(JSON.stringify(effectiveSchema, null, 2))})
print("---")
`
        : "";
    // Tools probe is omitted entirely when the tools capability is disabled.
    const toolsProbeCode = ENABLE_TOOLS
        ? `
import inspect as _inspect
if __tools__:
    print("---")
    print(f"Available tools ({len(__tools__)}) — callable directly in this REPL.")
    print("NOTE: tools marked [async] must be called with 'await' (e.g. inside")
    print("      an 'async def' or via asyncio.run). Tools marked [sync] are")
    print("      called directly with no await.")
    print()
    for _t in __tools__:
        try:
            _sig = str(_inspect.signature(_t))
        except (TypeError, ValueError):
            _sig = "(...)"
        _doc = _inspect.getdoc(_t)
        _is_async = _inspect.iscoroutinefunction(_t)
        _kw = "async def" if _is_async else "def"
        _kind = "[async — needs await]" if _is_async else "[sync]"
        print(f"{_kw} {_t.__name__}{_sig}:  {_kind}")
        if _doc:
            for _line in _doc.splitlines():
                print(f"    {_line}")
        print()
else:
    print("---")
    print("Available tools: (none provided)")
`
        : "";
    const initial_code = `
${schemaPreambleCode}if isinstance(context, dict):
    print(f"Context type: dict")
    print(f"Keys ({len(context)}): {list(context.keys())}")
    print("---")
    for _k, _v in context.items():
        _type_name = type(_v).__name__
        try:
            _len_info = f", len={len(_v)}"
        except TypeError:
            _len_info = ""
        _preview = str(_v)
        if len(_preview) > 200:
            _preview = _preview[:200] + "...[truncated]"
        print(f"  [{_k!r}] ({_type_name}{_len_info}): {_preview}")
else:
    print("Context type: ", type(context))
    print(f"Context length: {len(context) if hasattr(context, '__len__') else 'N/A'}")
    if len(context) > 500:
        print(f"First 500 characters of str(context): ", str(context)[:500])
        print("---")
        print(f"Last 500 characters of str(context): ", str(context)[-500:])
    else:
        print(f"Context: ", context)
${toolsProbeCode}${mcpProbeCode}`
    stdoutBuffer = "";
    const step0ExecStart = now();
    await pyodide.runPythonAsync(initial_code);
    const step0ExecEnd = now();
    let messages = [
        {
            "role": "user", "content": `
Outputs will always be truncated to last ${TRUNCATE_LEN} characters.
code:\n\`\`\`repl\n${initial_code}\n\`\`\`\n
Output:\n${stdoutBuffer.trim()}
    `
        }
    ];

    // Step 0 has no usage (just initial context)
    const noUsage: Usage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        cost: undefined
    };

    logger.logStep({
        step: 0,
        code: initial_code,
        output: stdoutBuffer.trim(),
        hasError: false,
        usage: noUsage,
        timestamps: {
            execution_start: step0ExecStart,
            execution_end: step0ExecEnd,
        }
    });

    const promptOpts = {
        enableTools: ENABLE_TOOLS,
        enableStructuredIo: ENABLE_STRUCTURED_IO,
        enableCompressionGuard: ENABLE_COMPRESSION_GUARD,
        instruction: instruction ?? null,
    };
    const apiOpts = { maxRetries: API_MAX_RETRIES, timeout: API_TIMEOUT_MS };

    // Compression guard: the parent flagged this delegation as barely-compressed.
    // Self-confirm (same model, same system prompt, same probe → cache reuse)
    // before doing any work; a NO blocks and forces the caller to compress.
    if (confirmInfo && ENABLE_COMPRESSION_GUARD) {
        const { childChars, parentChars } = confirmInfo;
        const pct = Math.round((childChars / Math.max(1, parentChars)) * 100);
        const confirmQuestion =
            `STOP — confirmation required before this delegation runs.\n` +
            `You were handed a context of ${childChars.toLocaleString()} characters via the ` +
            `parent's llm_query call — that is ${pct}% of the delegating agent's own context ` +
            `(${parentChars.toLocaleString()} chars), which suggests it was passed with little ` +
            `or no compression. RLM works best when the caller slices/filters/summarizes in its ` +
            `OWN REPL first and delegates only the reduced result.\n` +
            `Reply on the FIRST line with exactly YES (this delegation is appropriate — e.g. a ` +
            `genuine map step over one chunk) or NO (the caller should compress first).\n` +
            `If NO: give a one-line reason, THEN a concrete \`\`\`repl code block the caller can ` +
            `run in its own REPL to compress the context (keyword/regex slicing, chunking, or ` +
            `summarizing into a smaller variable) before delegating the reduced result. The probe ` +
            `above shows the context shape and the task — make the code specific to them. Do NOT ` +
            `tell them to simply call llm_query again with the full context.`;
        const confirmSpinner = startSpinner("Confirming delegation...");
        const verdict = await confirmDelegation(
            messages, confirmQuestion, model_name, is_leaf_agent, apiOpts, promptOpts, llmKwargs ?? null,
        );
        trackCall();
        trackUsage(verdict.usage);
        if (!verdict.approve) {
            confirmSpinner.success("Delegation rejected");
            logger.logAgentEnd();
            throw new Error(
                `DELEGATION_REJECTED: this call was declined as under-compressed ` +
                `(${pct}% of your context). Do the compression in YOUR OWN REPL — slice/filter/` +
                `summarize the context into a smaller variable — then delegate only that reduced ` +
                `result. Do NOT re-send the full context. Suggested REPL code from the reviewer:\n` +
                `${verdict.reason}`
            );
        }
        confirmSpinner.success("Delegation approved");
    }

    for (let i = 0; i < MAX_CALLS; i++) {
        // Global call budget: stop before making a new call once the run-wide
        // total is reached. Counts calls (not tokens), so it's the one stop gap
        // that works universally — including ACP, where usage is always zero.
        if (getTotalCalls() >= MAX_GLOBAL_CALLS) {
            throw new Error(`Global call budget exceeded: ${getTotalCalls()} call(s) made, limit is ${MAX_GLOBAL_CALLS}`);
        }
        // Reserve this call's slot synchronously, BEFORE the await below.
        // Concurrent sub-agents (batch_llm_query → gather) would otherwise all
        // pass the check above before any of them incremented past the await.
        trackCall();

        const llmCallStart = now();
        const llmSpinner = startSpinner("Generating code...");
        const { code, success, message, usage } = await generate_code(
            messages, model_name, is_leaf_agent, apiOpts, promptOpts, llmKwargs ?? null);
        const llmCallEnd = now();
        messages.push(message);

        // Track usage globally
        trackUsage(usage);
        const totalUsage = getTotalUsage();
        if (totalUsage.cost != null && totalUsage.cost > MAX_MONEY_SPENT) {
            throw new Error(`Budget exceeded: $${totalUsage.cost.toFixed(4)} spent, limit is $${MAX_MONEY_SPENT}`);
        }

        if (totalUsage.completion_tokens > MAX_COMPLETION_TOKENS) {
            throw new Error(`Completion token budget exceeded: ${totalUsage.completion_tokens.toLocaleString()} tokens used, limit is ${MAX_COMPLETION_TOKENS.toLocaleString()}`);
        }
        if (totalUsage.prompt_tokens > MAX_PROMPT_TOKENS) {
            throw new Error(`Prompt token budget exceeded: ${totalUsage.prompt_tokens.toLocaleString()} tokens used, limit is ${MAX_PROMPT_TOKENS.toLocaleString()}`);
        }

        llmSpinner.success("Code generated");

        if (!success) {
            logger.logStep({
                step: i + 1, code, reasoning: message.reasoning, usage,
                timestamps: { llm_call_start: llmCallStart, llm_call_end: llmCallEnd },
            });

            messages.push({
                "role": "user",
                "content": `${budgetBanner(i, MAX_CALLS)}Error: We could not extract code because you may not have used repl block!`

            });
            continue
        }
        // Reset stdout buffer for this execution
        stdoutBuffer = "";

        const execStart = now();
        try {
            await pyodide.runPythonAsync(code);
        } catch (error) {
            if (error instanceof Error) {
                stdoutBuffer += `\nError: ${error.message} `;
            } else {
                stdoutBuffer += `\nError: ${error} `;
            }
        }
        const execEnd = now();
        let truncatedText = truncateText(stdoutBuffer);

        const stepTimestamps = {
            llm_call_start: llmCallStart,
            llm_call_end: llmCallEnd,
            execution_start: execStart,
            execution_end: execEnd,
        };

        const finalResultSet = pyodide.globals.get("__final_result_set__");
        if (finalResultSet) {
            let result = pyodide.globals.get("__final_result__");
            if (result && typeof result.toJs === "function") {
                result = result.toJs({ dict_converter: Object.fromEntries });
            }

            if (validate && !validate(result)) {
                const errText = formatValidationErrors(validate);
                const schemaStr = JSON.stringify(effectiveSchema, null, 2);
                const feedback =
                    `FINAL value failed schema validation. The value you passed to FINAL does NOT match the required output schema.\n\n` +
                    `Required JSON Schema:\n${schemaStr}\n\n` +
                    `Validation errors:\n${errText}\n\n` +
                    `Fix the value and call FINAL again. The agent state is preserved; you do not need to recompute everything.`;
                // Reset Python flags so the loop continues.
                await pyodide.runPythonAsync(
                    "__final_result__ = None\n__final_result_set__ = False\n"
                );
                stdoutBuffer += `\n${feedback}\n`;
                const truncatedErr = truncateText(stdoutBuffer);
                logger.logStep({
                    step: i + 1,
                    code,
                    output: truncatedErr,
                    hasError: true,
                    reasoning: message.reasoning,
                    usage,
                    timestamps: stepTimestamps,
                });
                messages.push({
                    "role": "user",
                    "content": `${budgetBanner(i, MAX_CALLS)}Output: \n${truncatedErr}`,
                });
                continue;
            }

            logger.logStep({ step: i + 1, code, reasoning: message.reasoning, usage, timestamps: stepTimestamps });
            logger.logFinalResult(result);
            logger.logAgentEnd();
            return result;
        }

        const hasError = stdoutBuffer.includes("Error");
        logger.logStep({
            step: i + 1,
            code,
            output: truncatedText,
            hasError,
            reasoning: message.reasoning,
            usage,
            timestamps: stepTimestamps,
        });


        messages.push({
            "role": "user",
            "content": `${budgetBanner(i, MAX_CALLS)}Output: \n${truncatedText}`
        });
    }

    logger.logAgentEnd();
    throw new Error("Did not finish the function stack before subagent died");
}

if (import.meta.main) {
    resetUsage(); // Start fresh

    // Parse --prefix flag
    const prefixIdx = Deno.args.indexOf("--prefix");
    if (prefixIdx !== -1 && Deno.args[prefixIdx + 1]) {
        setLogPrefix(Deno.args[prefixIdx + 1]);
    }

    // Parse --log-dir flag
    const logDirIdx = Deno.args.indexOf("--log-dir");
    if (logDirIdx !== -1 && Deno.args[logDirIdx + 1]) {
        setLogDir(Deno.args[logDirIdx + 1]);
    }

    // Parse --output flag
    const outputIdx = Deno.args.indexOf("--output");
    const outputFile = outputIdx !== -1 ? Deno.args[outputIdx + 1] : null;

    let out: unknown;
    let fatalError: string | null = null;
    let mcpHandle: McpHandle | null = null;
    try {
        const raw_stdin = await new Response(Deno.stdin.readable).text();
        const inputIsJson = Deno.args.includes("--input-json");
        let query_context: Context;
        if (inputIsJson) {
            const parsed = JSON.parse(raw_stdin);
            if (typeof parsed !== "string" && (typeof parsed !== "object" || parsed === null)) {
                throw new Error(
                    `--input-json payload must decode to a string or dict/list, got ${typeof parsed}`
                );
            }
            query_context = parsed as Context;
        } else {
            query_context = raw_stdin;
        }

        const schemaIdx = Deno.args.indexOf("--output-schema-file");
        let rootSchema: JsonSchema | null = null;
        if (schemaIdx !== -1 && Deno.args[schemaIdx + 1]) {
            const schemaRaw = await Deno.readTextFile(Deno.args[schemaIdx + 1]);
            rootSchema = JSON.parse(schemaRaw) as JsonSchema;
        }

        const toolsIdx = Deno.args.indexOf("--tools-file");
        let rootTools: string[] | null = null;
        if (toolsIdx !== -1 && Deno.args[toolsIdx + 1]) {
            const toolsRaw = await Deno.readTextFile(Deno.args[toolsIdx + 1]);
            const parsedTools = JSON.parse(toolsRaw);
            if (!Array.isArray(parsedTools) || !parsedTools.every((x) => typeof x === "string")) {
                throw new Error("--tools-file must decode to a list of source strings");
            }
            rootTools = parsedTools as string[];
        }

        const envIdx = Deno.args.indexOf("--env-file");
        let rootEnv: Record<string, string> | null = null;
        if (envIdx !== -1 && Deno.args[envIdx + 1]) {
            const envRaw = await Deno.readTextFile(Deno.args[envIdx + 1]);
            const parsedEnv = JSON.parse(envRaw);
            if (
                typeof parsedEnv !== "object" || parsedEnv === null || Array.isArray(parsedEnv) ||
                !Object.entries(parsedEnv).every(([k, v]) => typeof k === "string" && typeof v === "string")
            ) {
                throw new Error("--env-file must decode to an object of string → string");
            }
            rootEnv = parsedEnv as Record<string, string>;
        }

        const mcpIdx = Deno.args.indexOf("--mcp-file");
        if (mcpIdx !== -1 && Deno.args[mcpIdx + 1]) {
            const mcpRaw = await Deno.readTextFile(Deno.args[mcpIdx + 1]);
            const parsedMcp = JSON.parse(mcpRaw) as McpServersConfig;
            if (typeof parsedMcp !== "object" || parsedMcp === null || Array.isArray(parsedMcp)) {
                throw new Error("--mcp-file must decode to an object of server-name → config");
            }
            // Lazy import: pulls in @modelcontextprotocol/sdk only now, when MCP is used.
            const { connectMcpServers } = await import("./mcp.ts");
            mcpHandle = await connectMcpServers(parsedMcp);
            console.log(
                `✔ MCP connected: ${mcpHandle.tools.length} tool(s), ` +
                `${mcpHandle.resources.length} resource(s) across [${mcpHandle.serverNames.join(", ")}]`
            );
        }

        const llmKwargsIdx = Deno.args.indexOf("--llm-kwargs-file");
        let rootLlmKwargs: Record<string, unknown> | null = null;
        if (llmKwargsIdx !== -1 && Deno.args[llmKwargsIdx + 1]) {
            const raw = await Deno.readTextFile(Deno.args[llmKwargsIdx + 1]);
            const parsed = JSON.parse(raw);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                throw new Error("--llm-kwargs-file must decode to a JSON object");
            }
            rootLlmKwargs = parsed as Record<string, unknown>;
        }

        // Root agent: mcpAllowedServers = null → sees all configured servers.
        // ROOT_INSTRUCTION (from run(instruction=...)) applies to the root only.
        out = await subagent(query_context, 0, undefined, rootSchema, rootTools, rootEnv, mcpHandle, null, rootLlmKwargs, undefined, ROOT_INSTRUCTION);

        // Final result is already logged inside subagent()
        // Show global usage across all runs
        showGlobalUsage(getTotalUsage());
        console.log("JSON_RESULT:" + JSON.stringify({ results: out }));
    } catch (err) {
        fatalError = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFatal error: ${fatalError}`));
        // Removed throw err - error is already handled
    } finally {
        // Close MCP connections (and any stdio subprocesses) before exit.
        if (mcpHandle) {
            try { await mcpHandle.closeAll(); } catch { /* ignore */ }
        }

        // Flush logs before exit
        await Logger.flush();

        // Reprint the log file path for easy access
        const logFile = getLogFile();
        if (logFile) {
            console.log(chalk.green(`\n📝 Log saved to: ${logFile}`));
            console.log(chalk.dim(`   View with: fast-rlm-log ${logFile} --tui`));
        }

        if (outputFile) {
            const totalUsage = getTotalUsage();
            await Deno.writeTextFile(outputFile, JSON.stringify({
                results: out ?? null,
                log_file: logFile ?? null,
                usage: {
                    prompt_tokens: totalUsage.prompt_tokens,
                    completion_tokens: totalUsage.completion_tokens,
                    total_tokens: totalUsage.total_tokens,
                    cached_tokens: totalUsage.cached_tokens,
                    reasoning_tokens: totalUsage.reasoning_tokens,
                    cost: totalUsage.cost,
                },
                ...(fatalError ? { error: fatalError } : {}),
            }));
        }

        // Explicit exit: Deno can keep the event loop alive due to unclosed
        // async resources (OpenAI client, Pyodide workers). Always exit so
        // the process never hangs.
        Deno.exit(fatalError ? 1 : 0);
    }
}
