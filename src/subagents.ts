import { loadPyodide } from "pyodide";
import { parse as parseYaml } from "@std/yaml";
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
import { generate_code, Usage } from "./call_llm.ts";
import { Logger, setLogDir, setLogPrefix, getLogFile } from "./logging.ts";
import { startSpinner, showGlobalUsage } from "./ui.ts";
import { trackUsage, getTotalUsage, resetUsage } from "./usage.ts";
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

interface RlmConfig {
    max_calls_per_subagent?: number;
    max_depth?: number;
    truncate_len?: number;
    primary_agent?: string;
    sub_agent?: string;
    max_money_spent?: number;
    max_completion_tokens?: number;
    max_prompt_tokens?: number;
    api_max_retries?: number;
    api_timeout_ms?: number;
}

function loadConfig(): RlmConfig {
    try {
        const configIdx = Deno.args.indexOf("--config");
        const configPath = configIdx !== -1 && Deno.args[configIdx + 1]
            ? Deno.args[configIdx + 1]
            : new URL("../rlm_config.yaml", import.meta.url).pathname;
        const raw = Deno.readTextFileSync(configPath);
        return (parseYaml(raw) as RlmConfig) ?? {};
    } catch {
        return {};
    }
}

const _config = loadConfig();
const MAX_CALLS = _config.max_calls_per_subagent ?? 20;
const MAX_DEPTH = _config.max_depth ?? 3;
const TRUNCATE_LEN = _config.truncate_len ?? 5000;
const PRIMARY_AGENT = _config.primary_agent ?? "z-ai/glm-5";
const SUB_AGENT = _config.sub_agent ?? "minimax/minimax-m2.5";
const MAX_MONEY_SPENT = _config.max_money_spent ?? Infinity;
const MAX_COMPLETION_TOKENS = _config.max_completion_tokens ?? 50000;
const MAX_PROMPT_TOKENS = _config.max_prompt_tokens ?? 200000;
const API_MAX_RETRIES = _config.api_max_retries ?? 3;
const API_TIMEOUT_MS = _config.api_timeout_ms ?? 600000;

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
) {
    const validate = compileSchema(outputSchema ?? null);
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
        if (child_schema != null) {
            const s = pyProxyToJs(child_schema);
            if (typeof s !== "object" || s === null || Array.isArray(s)) {
                throw new Error(
                    `llm_query output_schema must be a JSON Schema dict, got ${typeof s}`
                );
            }
            childSchema = s as JsonSchema;
        }
        let childTools: string[] | null = null;
        if (child_tool_sources != null) {
            const t = pyProxyToJs(child_tool_sources);
            if (!Array.isArray(t) || !t.every((x) => typeof x === "string")) {
                throw new Error(
                    `llm_query tools must be a list of Python functions (received non-string sources)`
                );
            }
            childTools = t as string[];
        }
        console.log("↳ llm_query called");
        const output = await subagent(
            plain,
            subagent_depth + 1,
            logger.run_id,
            childSchema,
            childTools,
            envVars ?? null,
        );
        return output;
    };
    pyodide.globals.set("__js_llm_query__", js_llm_query);

    // Initialize context. Strings are embedded as Python string literals;
    // dicts/lists are passed through json.loads so the agent gets a real
    // Python dict/list (not a JsProxy).
    const contextLiteral = typeof context === "string"
        ? JSON.stringify(context)
        : `__import__('json').loads(${JSON.stringify(JSON.stringify(context))})`;
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

async def llm_query(context, schema=None, *, tools=None):
    """Recursively query a sub-agent.

    Args:
        context: str or dict — the task/context for the sub-agent.
        schema: optional JSON Schema (as a dict) the sub-agent's FINAL must satisfy.
        tools: optional list of Python functions to expose in the sub-agent's REPL.
            By default the sub-agent does NOT inherit your tools; pass them
            explicitly here if you want the child to have access.
    """
    _tool_sources = None
    if tools:
        import inspect as _inspect
        _tool_sources = []
        for _t in tools:
            _stashed = getattr(_t, "__fast_rlm_source__", None)
            if _stashed is not None:
                _tool_sources.append(_stashed)
            else:
                _tool_sources.append(_inspect.getsource(_t))
    _result = await __js_llm_query__(context, schema, _tool_sources)
    if hasattr(_result, "to_py"):
        return _result.to_py()
    return _result
`;
    await pyodide.runPythonAsync(setup_code);

    // Register tools (if any) into the REPL globals + __tools__ list.
    if (toolSources && toolSources.length) {
        for (const src of toolSources) {
            await pyodide.runPythonAsync(
                `__register_tool__(${JSON.stringify(src)})`
            );
        }
    }

    const schemaPreambleCode = outputSchema
        ? `print("Required output schema for FINAL (JSON Schema):")
print(${JSON.stringify(JSON.stringify(outputSchema, null, 2))})
print("---")
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

    for (let i = 0; i < MAX_CALLS; i++) {
        const llmCallStart = now();
        const llmSpinner = startSpinner("Generating code...");
        const { code, success, message, usage } = await generate_code(messages, model_name, is_leaf_agent, {
            maxRetries: API_MAX_RETRIES,
            timeout: API_TIMEOUT_MS,
        });
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
                const schemaStr = JSON.stringify(outputSchema, null, 2);
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

        out = await subagent(query_context, 0, undefined, rootSchema, rootTools, rootEnv);

        // Final result is already logged inside subagent()
        // Show global usage across all runs
        showGlobalUsage(getTotalUsage());
        console.log("JSON_RESULT:" + JSON.stringify({ results: out }));
    } catch (err) {
        fatalError = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFatal error: ${fatalError}`));
        // Removed throw err - error is already handled
    } finally {
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
