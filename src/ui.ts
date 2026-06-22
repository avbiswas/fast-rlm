import boxen from "npm:boxen@8";
import chalk from "npm:chalk@5";
import yoctoSpinner from "npm:yocto-spinner@1";
import type { Usage } from "./call_llm.ts";

const GUTTER = "    │ ";
const GUTTER_WIDTH = 6;

function termWidth(): number {
    try {
        return Deno.consoleSize().columns;
    } catch {
        return 80;
    }
}

function indent(text: string, depth: number): string {
    if (depth === 0) return text;
    const prefix = chalk.dim(GUTTER.repeat(depth));
    return text.split("\n").map((line) => prefix + line).join("\n");
}

function boxWidth(depth: number): number {
    return termWidth() - depth * GUTTER_WIDTH;
}

// ── Step data dictionary ────────────────────────────────────────────

export interface StepTimestamps {
    llm_call_start?: string;
    llm_call_end?: string;
    execution_start?: string;
    execution_end?: string;
}

export interface StepData {
    run_id: string;
    parent_run_id?: string;
    depth: number;
    step: number;
    maxSteps: number;
    code: string;
    output?: string;
    hasError?: boolean;
    reasoning?: string; // LLM reasoning/thinking text
    usage: Usage;
    totalUsage?: Usage; // Running total across all steps
    timestamps?: StepTimestamps;
}

export function printStep(data: StepData): void {
    const { depth, step, maxSteps, code, output, hasError, reasoning, usage, totalUsage } = data;
    const w = boxWidth(depth);
    const parts: string[] = [];

    // Header rule
    const title = ` Depth ${depth} · Step ${step}/${maxSteps} `;
    const side = Math.max(2, Math.floor((w - title.length) / 2));
    parts.push(chalk.bold.blue(`${"─".repeat(side)}${title}${"─".repeat(side)}`));

    // Reasoning panel (extended thinking / chain-of-thought)
    if (reasoning) {
        parts.push(boxen(chalk.magenta(reasoning), {
            title: "Reasoning",
            titleAlignment: "left",
            borderColor: "magenta",
            borderStyle: "round",
            padding: { left: 1, right: 1, top: 0, bottom: 0 },
            width: w,
        }));
    }

    // Code panel
    if (code) {
        parts.push(boxen(addLineNumbers(code), {
            title: "Python Code",
            titleAlignment: "left",
            borderColor: "blue",
            borderStyle: "round",
            padding: { left: 1, right: 1, top: 0, bottom: 0 },
            width: w,
        }));
    } else {
        parts.push(chalk.yellow("No code generated. Stopping."));
    }

    // Output panel
    if (output !== undefined) {
        const color = hasError ? "red" : "green";
        const label = hasError ? "Error" : "Result";
        parts.push(boxen(hasError ? chalk.red(output) : chalk.green(output), {
            title: label,
            titleAlignment: "left",
            borderColor: color,
            borderStyle: "round",
            padding: { left: 1, right: 1, top: 0, bottom: 0 },
            width: w,
        }));
    }

    // Usage panel
    if (usage) {
        const fmt = (v: number | undefined | null, color: typeof chalk.cyan) =>
            v != null ? color(v.toLocaleString()) : color("Unknown");
        const fmtCost = (v: number | undefined | null) =>
            v != null ? chalk.green("$" + v.toFixed(6)) : chalk.green("Unknown");

        // Step line
        const stepParts = [
            `${fmt(usage.prompt_tokens, chalk.cyan)} prompt`,
            `${fmt(usage.completion_tokens, chalk.cyan)} completion`,
        ];
        if (usage.cached_tokens > 0) {
            stepParts.push(`${fmt(usage.cached_tokens, chalk.yellow)} cached`);
        }
        if (usage.reasoning_tokens > 0) {
            stepParts.push(`${fmt(usage.reasoning_tokens, chalk.magenta)} reasoning`);
        }
        const stepLine = `${chalk.bold("Step:")}  ${stepParts.join(", ")} | Cost: ${fmtCost(usage.cost)}`;

        // Total line
        let totalLine = "";
        if (totalUsage) {
            const totalParts = [
                `${fmt(totalUsage.prompt_tokens, chalk.cyan)} prompt`,
                `${fmt(totalUsage.completion_tokens, chalk.cyan)} completion`,
            ];
            if (totalUsage.cached_tokens > 0) {
                totalParts.push(`${fmt(totalUsage.cached_tokens, chalk.yellow)} cached`);
            }
            if (totalUsage.reasoning_tokens > 0) {
                totalParts.push(`${fmt(totalUsage.reasoning_tokens, chalk.magenta)} reasoning`);
            }
            totalLine = `\n${chalk.bold("Total:")} ${totalParts.join(", ")} | Cost: ${fmtCost(totalUsage.cost)}`;
        }

        parts.push(boxen(stepLine + totalLine, {
            title: "Usage",
            titleAlignment: "left",
            borderColor: "cyan",
            borderStyle: "round",
            padding: { left: 1, right: 1, top: 0, bottom: 0 },
            width: w,
        }));
    }

    console.log(indent(parts.join("\n"), depth));
}

// ── Standalone helpers (not part of a step) ─────────────────────────

export function showPythonReady(depth: number): void {
    console.log(indent(chalk.green.bold("✔ Python Ready"), depth));
}

export function showLlmQueryCall(depth: number): void {
    console.log(indent(chalk.cyan.bold("↳ llm_query called"), depth));
}

export function showFinalResult(result: unknown, depth: number): void {
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    const w = boxWidth(depth);
    const banner = boxen(chalk.green(text), {
        title: "✔ Final Result",
        titleAlignment: "left",
        borderColor: "green",
        borderStyle: "double",
        padding: { left: 1, right: 1, top: 1, bottom: 1 },
        width: w,
    });
    console.log(indent(banner, depth));
}

export function startSpinner(text: string) {
    return yoctoSpinner({ text }).start();
}

export function showGlobalUsage(totalUsage: Usage): void {
    const fmt = (v: number | undefined | null, color: typeof chalk.cyan) =>
        v != null ? color(v.toLocaleString()) : color("Unknown");
    const fmtCost = (v: number | undefined | null) =>
        v != null ? chalk.green("$" + v.toFixed(6)) : chalk.green("Unknown");

    const usageParts = [
        `${fmt(totalUsage.prompt_tokens, chalk.cyan)} prompt`,
        `${fmt(totalUsage.completion_tokens, chalk.cyan)} completion`,
    ];

    if (totalUsage.cached_tokens > 0) {
        usageParts.push(`${fmt(totalUsage.cached_tokens, chalk.yellow)} cached`);
    }

    if (totalUsage.reasoning_tokens > 0) {
        usageParts.push(`${fmt(totalUsage.reasoning_tokens, chalk.magenta)} reasoning`);
    }

    const usageText = usageParts.join(", ") + ` | Cost: ${fmtCost(totalUsage.cost)}`;

    const banner = boxen(usageText, {
        title: "📊 Global Usage (All Runs)",
        titleAlignment: "left",
        borderColor: "magenta",
        borderStyle: "double",
        padding: { left: 1, right: 1, top: 0, bottom: 0 },
        width: termWidth(),
    });

    console.log("\n" + banner);
}

// ── Internal ────────────────────────────────────────────────────────

function addLineNumbers(code: string): string {
    const lines = code.split("\n");
    const width = String(lines.length).length;
    return lines
        .map((line, i) => `${chalk.dim(String(i + 1).padStart(width))} ${line}`)
        .join("\n");
}
