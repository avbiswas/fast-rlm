/**
 * Logging orchestrator - handles both persistent logging (Pino) and terminal UI
 */

import pino from "npm:pino";
import type { Usage } from "./call_llm.ts";
import { printStep, showFinalResult, type StepData } from "./ui.ts";
import { getTotalUsage } from "./usage.ts";
import chalk from "npm:chalk@5";

// Re-export types
export type { StepData };

// ── Pino logger setup ───────────────────────────────────────────────

let pinoLogger: pino.Logger;
let currentLogFile: string | null = null;
let logPrefix: string | null = null;
let logDir = "./logs";

/** Set a custom prefix for the log filename (call before any logging) */
export function setLogPrefix(prefix: string) {
    logPrefix = prefix;
}

/** Set log directory path (call before any logging) */
export function setLogDir(dir: string) {
    logDir = dir;
}

/** Get the current log file path */
export function getLogFile(): string | null {
    return currentLogFile;
}

function initPino() {
    if (!pinoLogger) {
        try {
            Deno.mkdirSync(logDir, { recursive: true });
        } catch {
            // Directory might exist
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const prefix = logPrefix ? `${logPrefix}_` : "run_";
        currentLogFile = `${logDir}/${prefix}${timestamp}.jsonl`;

        pinoLogger = pino({
            level: "info",
            timestamp: pino.stdTimeFunctions.isoTime,
            base: null, // Skip hostname/pid to avoid --allow-sys requirement
        }, pino.destination({ dest: currentLogFile, sync: false }));

        console.log(chalk.dim(`📝 Logging to: ${currentLogFile}\n`));
    }
    return pinoLogger;
}

function generateRunId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// ── Logger Class ────────────────────────────────────────────────────

export class Logger {
    public readonly run_id: string;
    private parent_run_id?: string;
    private depth: number;
    private maxSteps: number;

    constructor(depth: number, maxSteps: number, parent_run_id?: string) {
        this.run_id = generateRunId();
        this.parent_run_id = parent_run_id;
        this.depth = depth;
        this.maxSteps = maxSteps;
    }

    logStep(data: Omit<StepData, "run_id" | "parent_run_id" | "depth" | "maxSteps" | "totalUsage">): void {
        const fullData: StepData = {
            run_id: this.run_id,
            parent_run_id: this.parent_run_id,
            depth: this.depth,
            maxSteps: this.maxSteps,
            totalUsage: getTotalUsage(), // Add running total
            ...data,
        };

        const { step, code, output, hasError, reasoning, usage } = fullData;

        // Log to Pino
        const log = initPino().child({
            run_id: this.run_id,
            parent_run_id: this.parent_run_id,
            depth: this.depth,
            step,
        });

        if (output !== undefined) {
            log.info({
                event_type: "execution_result",
                code,
                output,
                hasError,
                reasoning,
                usage,
            });
        } else {
            log.info({
                event_type: "code_generated",
                code,
                reasoning,
                usage,
            });
        }

        // Display on terminal
        printStep(fullData);
    }

    logFinalResult(result: unknown): void {
        // Log to Pino
        initPino().child({
            run_id: this.run_id,
            parent_run_id: this.parent_run_id,
            depth: this.depth,
        }).info({
            event_type: "final_result",
            result,
        });

        // Display on terminal
        showFinalResult(result, this.depth);
    }

    static async flush(): Promise<void> {
        if (pinoLogger) {
            await pinoLogger.flush();
        }
    }
}
