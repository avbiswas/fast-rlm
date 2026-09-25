/**
 * Logging orchestrator - handles both persistent logging (Pino) and terminal UI
 */

import pino from "npm:pino";
import type { Usage } from "./call_llm.ts";
import { getVerbosity, showFinalResult, type StepData } from "./ui.ts";
import { getTotalUsage } from "./usage.ts";
import { emitEvent } from "./events.ts";
import chalk from "npm:chalk@5";

// Re-export types
export type { StepData };

// ── Pino logger setup ───────────────────────────────────────────────

let pinoLogger: pino.Logger;
let pinoDestination: ReturnType<typeof pino.destination>;
let pinoDestinationReady = false;
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

        pinoDestination = pino.destination({ dest: currentLogFile, sync: false });
        pinoDestination.on("ready", () => {
            pinoDestinationReady = true;
        });
        pinoLogger = pino({
            level: "info",
            timestamp: pino.stdTimeFunctions.isoTime,
            base: null, // Skip hostname/pid to avoid --allow-sys requirement
        }, pinoDestination);

        if (getVerbosity() >= 2) {
            console.log(chalk.dim(`📝 Logging to: ${currentLogFile}\n`));
        }
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

    logAgentStart(): void {
        initPino().child({
            run_id: this.run_id,
            parent_run_id: this.parent_run_id,
            depth: this.depth,
        }).info({
            event_type: "agent_start",
        });
    }

    logAgentEnd(): void {
        initPino().child({
            run_id: this.run_id,
            parent_run_id: this.parent_run_id,
            depth: this.depth,
        }).info({
            event_type: "agent_end",
        });
    }

    logEvent(event_type: string, data: Record<string, unknown> = {}): void {
        const event = {
            event_type,
            run_id: this.run_id,
            parent_run_id: this.parent_run_id,
            depth: this.depth,
            ...data,
        };
        initPino().info(event);
        emitEvent(event);
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

        const { step, code, output, hasError, reasoning, usage, timestamps } = fullData;

        // Log to Pino
        const log = initPino().child({
            run_id: this.run_id,
            parent_run_id: this.parent_run_id,
            depth: this.depth,
            step,
        });

        const event_type = output !== undefined ? "execution_result" : "code_generated";
        log.info({
            event_type,
            code,
            output,
            hasError,
            reasoning,
            usage,
            timestamps,
        });

        // Stream the same step data to the Python `on_step` callback (no-op when
        // no --events-file was configured). The terminal render is done by the
        // caller's explicit printStep(), so logStep no longer prints here.
        emitEvent({
            event_type,
            run_id: this.run_id,
            parent_run_id: this.parent_run_id,
            depth: this.depth,
            step,
            code,
            output,
            hasError,
            reasoning,
            usage,
            totalUsage: fullData.totalUsage,
            timestamps,
        });
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

        emitEvent({
            event_type: "final_result",
            run_id: this.run_id,
            parent_run_id: this.parent_run_id,
            depth: this.depth,
            result,
        });

        // Display on terminal
        showFinalResult(result, this.depth);
    }

    static async flush(): Promise<void> {
        if (pinoLogger) {
            if (!pinoDestinationReady) {
                await new Promise<void>((resolve) => {
                    pinoDestination.once("ready", resolve);
                });
            }
            pinoLogger.flush();
            pinoDestination.flushSync();
        }
    }
}
