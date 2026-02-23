/**
 * Global usage tracker across all subagents
 */

import type { Usage } from "./call_llm.ts";

let globalUsage: Usage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
    cost: 0,
};

// Parallel execution statistics
let parallelStats = {
    parallel_batches: 0,
    total_parallel_queries: 0,
};

export function trackUsage(usage: Usage): void {
    globalUsage.prompt_tokens += usage.prompt_tokens;
    globalUsage.completion_tokens += usage.completion_tokens;
    globalUsage.total_tokens += usage.total_tokens;
    globalUsage.cached_tokens += usage.cached_tokens;
    globalUsage.reasoning_tokens += usage.reasoning_tokens;
    globalUsage.cost += usage.cost;
}

export function trackParallelExecution(queryCount: number): void {
    parallelStats.parallel_batches++;
    parallelStats.total_parallel_queries += queryCount;
}

export function getTotalUsage(): Usage {
    return { ...globalUsage };
}

export function getParallelStats() {
    return { ...parallelStats };
}

export function resetUsage(): void {
    globalUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        cost: 0,
    };
    parallelStats = {
        parallel_batches: 0,
        total_parallel_queries: 0,
    };
}
