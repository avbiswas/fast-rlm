import { loadPyodide } from "pyodide";
import { parse as parseYaml } from "@std/yaml";
import { generate_code, Usage } from "./call_llm.ts";
import { Logger, setLogDir, setLogPrefix, getLogFile } from "./logging.ts";
import { startSpinner, showGlobalUsage } from "./ui.ts";
import { trackUsage, getTotalUsage, resetUsage } from "./usage.ts";
import chalk from "npm:chalk@5";

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

export async function subagent(
    context: string,
    subagent_depth = 0,
    parent_run_id?: string
) {
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

    const llm_query = async (context: string) => {
        if (subagent_depth >= MAX_DEPTH) {
            stdoutBuffer += "\nError: MAXIMUM DEPTH REACHED. You must solve this task on your own without calling llm_query.\n";
            throw new Error("MAXIMUM DEPTH REACHED. You must solve this task on your own without calling llm_query.");
        }
        // if (context.length < 1000) {
        //     stdoutBuffer += `\nError: Context passed to llm_query is too short (${context.length} chars). This likely means you forgot to attach the actual context/data. Make sure you include the relevant context when calling llm_query().\n`;
        //     throw new Error(`Context too short (${context.length} chars). Ensure you have attached the context to llm_query().`);
        // }
        console.log("↳ llm_query called");
        const output = await subagent(context, subagent_depth + 1, logger.run_id);
        return output;
    };
    pyodide.globals.set("llm_query", llm_query);

    // Initialize context
    // We use JSON.stringify to safely embed the string into Python code
    const setup_code = `
context = ${JSON.stringify(context)}
__final_result__ = None
__final_result_set__ = False

def FINAL(x):
    global __final_result__, __final_result_set__
    __final_result__ = x
    __final_result_set__ = True

def FINAL_VAR(x):
    global __final_result__, __final_result_set__
    __final_result__ = x
    __final_result_set__ = True
`;
    await pyodide.runPythonAsync(setup_code);

    const initial_code = `
print("Context type: ", type(context))
print(f"Context length: {len(context) if hasattr(context, '__len__') else 'N/A'}")

if len(context) > 500:
    print(f"First 500 characters of str(context): ", str(context)[:500])
    print("---")
    print(f"Last 500 characters of str(context): ", str(context)[-500:])
else:
    print(f"Context: ", context)
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
                "content": "Error: We could not extract code because you may not have used repl block!"

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
            logger.logStep({ step: i + 1, code, reasoning: message.reasoning, usage, timestamps: stepTimestamps });
            let result = pyodide.globals.get("__final_result__");
            if (result && typeof result.toJs === 'function') {
                result = result.toJs();
            }
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
            "content": `Output: \n${truncatedText}`
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
        const query_context = await new Response(Deno.stdin.readable).text();
        out = await subagent(query_context);

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
