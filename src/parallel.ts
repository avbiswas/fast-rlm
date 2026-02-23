/**
 * Parallel Sub-Agent Executor
 * 
 * Detects when multiple llm_query() calls are made concurrently (via asyncio.gather)
 * and batches them for parallel execution using Promise.all(), significantly reducing
 * latency for workloads that process multiple independent chunks.
 * 
 * This addresses a key optimization opportunity in RLMs: when the generated code uses
 * asyncio.gather to spawn multiple sub-agents, they should execute in parallel rather
 * than sequentially.
 */

import { Usage } from "./call_llm.ts";

export interface ParallelConfig {
    /** Maximum number of sub-agents to run in parallel (0 = unlimited) */
    maxParallelChildren: number;
    /** Time window to collect concurrent queries before batching (ms) */
    batchWindowMs: number;
    /** Budget limit for the entire parallel group */
    maxBudget: number;
    /** Current recursion depth */
    currentDepth: number;
    /** Maximum allowed depth */
    maxDepth: number;
}

export interface PendingQuery {
    id: string;
    context: string;
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    queuedAt: number;
}

export interface ParallelExecutionResult {
    results: PromiseSettledResult<unknown>[];
    parallelGroupId: string;
    executionTimeMs: number;
    queryCount: number;
}

/**
 * Generates a unique ID for parallel execution groups
 */
export function generateParallelGroupId(): string {
    return `pg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * ParallelExecutor coordinates batching of concurrent llm_query() calls.
 * 
 * When Python code uses asyncio.gather() to call multiple llm_query() functions,
 * they arrive at the executor nearly simultaneously. The executor collects these
 * within a short time window, then executes them all in parallel using Promise.all().
 * 
 * Usage:
 * ```typescript
 * const executor = new ParallelExecutor(config, subagentFn, logger);
 * 
 * // This is called by llm_query - if multiple calls come in quickly,
 * // they'll be batched and executed in parallel
 * const result = await executor.queueQuery(context);
 * ```
 */
export class ParallelExecutor {
    private pendingQueries: Map<string, PendingQuery> = new Map();
    private batchTimeout: number | null = null;
    private config: ParallelConfig;
    private subagentFn: (context: string, parallelGroupId?: string) => Promise<unknown>;
    private onParallelStart?: (groupId: string, count: number) => void;
    private onParallelComplete?: (groupId: string, results: ParallelExecutionResult) => void;

    // Statistics
    private stats = {
        totalQueries: 0,
        parallelBatches: 0,
        sequentialQueries: 0,
        totalParallelQueries: 0,
    };

    constructor(
        config: ParallelConfig,
        subagentFn: (context: string, parallelGroupId?: string) => Promise<unknown>,
        callbacks?: {
            onParallelStart?: (groupId: string, count: number) => void;
            onParallelComplete?: (groupId: string, results: ParallelExecutionResult) => void;
        }
    ) {
        this.config = config;
        this.subagentFn = subagentFn;
        this.onParallelStart = callbacks?.onParallelStart;
        this.onParallelComplete = callbacks?.onParallelComplete;
    }

    /**
     * Queue a query for potential parallel execution.
     * 
     * If this is the only query within the batch window, it executes immediately.
     * If multiple queries arrive within the window, they're batched and executed in parallel.
     */
    async queueQuery(context: string): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const id = `q-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
            
            this.pendingQueries.set(id, {
                id,
                context,
                resolve,
                reject,
                queuedAt: Date.now(),
            });

            this.stats.totalQueries++;

            // Schedule batch flush if not already scheduled
            if (this.batchTimeout === null) {
                this.batchTimeout = setTimeout(
                    () => this.flushBatch(),
                    this.config.batchWindowMs
                ) as unknown as number;
            }
        });
    }

    /**
     * Flush all pending queries, executing them in parallel if there are multiple.
     */
    private async flushBatch(): Promise<void> {
        this.batchTimeout = null;
        
        const queries = Array.from(this.pendingQueries.entries());
        this.pendingQueries.clear();

        if (queries.length === 0) {
            return;
        }

        const startTime = Date.now();

        if (queries.length === 1) {
            // Single query - execute directly (no parallelism overhead)
            const [id, query] = queries[0];
            this.stats.sequentialQueries++;
            
            try {
                const result = await this.subagentFn(query.context);
                query.resolve(result);
            } catch (error) {
                query.reject(error instanceof Error ? error : new Error(String(error)));
            }
        } else {
            // Multiple queries - execute in parallel!
            const parallelGroupId = generateParallelGroupId();
            this.stats.parallelBatches++;
            this.stats.totalParallelQueries += queries.length;

            // Apply max parallel limit if configured
            const maxParallel = this.config.maxParallelChildren > 0 
                ? this.config.maxParallelChildren 
                : queries.length;
            
            // Notify about parallel execution start
            this.onParallelStart?.(parallelGroupId, Math.min(queries.length, maxParallel));

            // Execute in batches if we have more queries than max parallel
            const batches: typeof queries[] = [];
            for (let i = 0; i < queries.length; i += maxParallel) {
                batches.push(queries.slice(i, i + maxParallel));
            }

            for (const batch of batches) {
                const results = await Promise.allSettled(
                    batch.map(([id, query]) => 
                        this.subagentFn(query.context, parallelGroupId)
                    )
                );

                // Resolve/reject each promise in the batch
                results.forEach((result, i) => {
                    const [id, query] = batch[i];
                    if (result.status === 'fulfilled') {
                        query.resolve(result.value);
                    } else {
                        query.reject(result.reason instanceof Error 
                            ? result.reason 
                            : new Error(String(result.reason)));
                    }
                });
            }

            // Notify about parallel execution completion
            const executionTimeMs = Date.now() - startTime;
            this.onParallelComplete?.(parallelGroupId, {
                results: [], // Already resolved individually
                parallelGroupId,
                executionTimeMs,
                queryCount: queries.length,
            });
        }
    }

    /**
     * Force immediate execution of any pending queries.
     * Useful for cleanup or when you know no more queries are coming.
     */
    async flush(): Promise<void> {
        if (this.batchTimeout !== null) {
            clearTimeout(this.batchTimeout);
            this.batchTimeout = null;
        }
        await this.flushBatch();
    }

    /**
     * Get execution statistics
     */
    getStats() {
        return {
            ...this.stats,
            pendingQueries: this.pendingQueries.size,
        };
    }

    /**
     * Reset statistics
     */
    resetStats(): void {
        this.stats = {
            totalQueries: 0,
            parallelBatches: 0,
            sequentialQueries: 0,
            totalParallelQueries: 0,
        };
    }
}

/**
 * Utility to check if we should use parallel execution based on config
 */
export function shouldUseParallelExecution(config: ParallelConfig): boolean {
    // Don't use parallel execution at max depth (children can't spawn more)
    if (config.currentDepth >= config.maxDepth - 1) {
        return false;
    }
    
    // Respect budget constraints
    if (config.maxBudget <= 0) {
        return false;
    }

    return true;
}
