import { loadPyodide } from "pyodide";
import { parse as parseYaml } from "@std/yaml";
import { generate_code, Usage } from "./call_llm.ts";
import { Logger, setLogPrefix, getLogFile } from "./logging.ts";
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

function truncateText(text: string): string {
    let truncatedOutput = "";
    console.log(text.length);
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

export async function subagent(
    context: string,
    subagent_depth = 0,
    parent_run_id?: string
) {
    const logger = new Logger(subagent_depth, MAX_CALLS, parent_run_id);

    const model_name = subagent_depth == 0 ? PRIMARY_AGENT : SUB_AGENT;
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

def FINAL(x):
    global __final_result__
    __final_result__ = x

def FINAL_VAR(x):
    global __final_result__
    __final_result__ = x
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
    await pyodide.runPythonAsync(initial_code);
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
        cost: 0
    };

    logger.logStep({
        step: 0,
        code: initial_code,
        output: stdoutBuffer.trim(),
        hasError: false,
        usage: noUsage
    });

    for (let i = 0; i < MAX_CALLS; i++) {
        const llmSpinner = startSpinner("Generating code...");
        const { code, success, message, usage } = await generate_code(messages, model_name);
        messages.push(message);

        // Track usage globally
        trackUsage(usage);
        const totalCost = getTotalUsage().cost;
        if (totalCost > MAX_MONEY_SPENT) {
            throw new Error(`Budget exceeded: $${totalCost.toFixed(4)} spent, limit is $${MAX_MONEY_SPENT}`);
        }

        llmSpinner.success("Code generated");

        if (!success) {
            logger.logStep({ step: i + 1, code, reasoning: message.reasoning, usage });

            messages.push({
                "role": "user",
                "content": "Error: We could not extract code because you may not have used repl block!"

            });
            continue
        }

        console.log(message.reasoning);

        // Reset stdout buffer for this execution
        stdoutBuffer = "";

        try {
            await pyodide.runPythonAsync(code);
        } catch (error) {
            if (error instanceof Error) {
                stdoutBuffer += `\nError: ${error.message} `;
            } else {
                stdoutBuffer += `\nError: ${error} `;
            }
        }
        let truncatedText = truncateText(stdoutBuffer);


        const finalResult = pyodide.globals.get("__final_result__");
        if (finalResult !== undefined) {
            logger.logStep({ step: i + 1, code, reasoning: message.reasoning, usage });
            let result = finalResult;
            if (result && typeof result.toJs === 'function') {
                result = result.toJs();
            }
            logger.logFinalResult(result);
            return result;
        }

        const hasError = stdoutBuffer.includes("Error");
        logger.logStep({
            step: i + 1,
            code,
            output: truncatedText,
            hasError,
            reasoning: message.reasoning,
            usage
        });


        messages.push({
            "role": "user",
            "content": `Output: \n${truncatedText}`
        });
    }

    throw new Error("Did not finish the function stack before subagent died");
}

if (import.meta.main) {
    resetUsage(); // Start fresh

    // Parse --prefix flag
    const prefixIdx = Deno.args.indexOf("--prefix");
    if (prefixIdx !== -1 && Deno.args[prefixIdx + 1]) {
        setLogPrefix(Deno.args[prefixIdx + 1]);
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
        throw err;
    } finally {
        // Flush logs before exit
        await Logger.flush();

        // Reprint the log file path for easy access
        const logFile = getLogFile();
        if (logFile) {
            console.log(chalk.green(`\n📝 Log saved to: ${logFile}`));
            console.log(chalk.dim(`   View with: ./viewlog ${logFile}`));
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
    }
}
