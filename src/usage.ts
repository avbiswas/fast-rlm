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
    cost: undefined,
};

// Running count of LLM calls across ALL agents (root + every sub-agent) and
// every backend (openai/vertex/acp). Backs the max_global_calls budget — the
// stop gap that works for ACP, where token/cost usage is always zero.
let globalCalls = 0;

export function trackCall(): void {
    globalCalls += 1;
}

export function getTotalCalls(): number {
    return globalCalls;
}

export function trackUsage(usage: Usage): void {
    globalUsage.prompt_tokens += usage.prompt_tokens || 0;
    globalUsage.completion_tokens += usage.completion_tokens || 0;
    globalUsage.total_tokens += usage.total_tokens || 0;
    globalUsage.cached_tokens += usage.cached_tokens || 0;
    globalUsage.reasoning_tokens += usage.reasoning_tokens || 0;
    if (usage.cost != null) {
        globalUsage.cost = (globalUsage.cost ?? 0) + usage.cost;
    }
}

export function getTotalUsage(): Usage {
    return { ...globalUsage };
}

export function resetUsage(): void {
    globalUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        cost: undefined,
    };
    globalCalls = 0;
}
