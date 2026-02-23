/**
 * Unit tests for ParallelExecutor
 * 
 * Tests the parallel sub-agent batching and execution logic.
 */

import { 
    ParallelExecutor, 
    ParallelConfig, 
    generateParallelGroupId,
    shouldUseParallelExecution 
} from "../src/parallel.ts";

// Simple assert functions
function assertEquals<T>(actual: T, expected: T, msg?: string): void {
    if (actual !== expected) {
        throw new Error(msg || `Expected ${expected} but got ${actual}`);
    }
}

function assertGreater(expected: number, actual: number, msg?: string): void {
    if (actual >= expected) {
        throw new Error(msg || `Expected ${actual} to be less than ${expected}`);
    }
}

// Mock subagent function for testing
function createMockSubagent(delayMs: number = 100): (context: string, pgId?: string) => Promise<string> {
    return async (context: string, pgId?: string) => {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return `Result for: ${context.substring(0, 20)}...`;
    };
}

Deno.test("generateParallelGroupId creates unique IDs", () => {
    const id1 = generateParallelGroupId();
    const id2 = generateParallelGroupId();
    
    assertEquals(id1.startsWith("pg-"), true);
    assertEquals(id2.startsWith("pg-"), true);
    assertEquals(id1 !== id2, true);
});

Deno.test("shouldUseParallelExecution respects depth limit", () => {
    const configAtMaxDepth: ParallelConfig = {
        maxParallelChildren: 5,
        batchWindowMs: 50,
        maxBudget: 1.0,
        currentDepth: 2,
        maxDepth: 3,
    };
    
    const configBelowMaxDepth: ParallelConfig = {
        maxParallelChildren: 5,
        batchWindowMs: 50,
        maxBudget: 1.0,
        currentDepth: 1,
        maxDepth: 3,
    };
    
    // At max depth - 1, should not use parallel (children can't spawn more)
    assertEquals(shouldUseParallelExecution(configAtMaxDepth), false);
    
    // Below max depth, should use parallel
    assertEquals(shouldUseParallelExecution(configBelowMaxDepth), true);
});

Deno.test("shouldUseParallelExecution respects budget", () => {
    const configNoBudget: ParallelConfig = {
        maxParallelChildren: 5,
        batchWindowMs: 50,
        maxBudget: 0,
        currentDepth: 0,
        maxDepth: 3,
    };
    
    assertEquals(shouldUseParallelExecution(configNoBudget), false);
});

Deno.test("ParallelExecutor handles single query without batching", async () => {
    const config: ParallelConfig = {
        maxParallelChildren: 5,
        batchWindowMs: 50,
        maxBudget: 1.0,
        currentDepth: 0,
        maxDepth: 3,
    };
    
    const mockSubagent = createMockSubagent(10);
    const executor = new ParallelExecutor(config, mockSubagent);
    
    const result = await executor.queueQuery("Single query test");
    
    assertEquals(typeof result, "string");
    assertEquals((result as string).includes("Result for"), true);
    
    const stats = executor.getStats();
    assertEquals(stats.totalQueries, 1);
    assertEquals(stats.sequentialQueries, 1);
    assertEquals(stats.parallelBatches, 0);
});

Deno.test("ParallelExecutor batches concurrent queries", async () => {
    const config: ParallelConfig = {
        maxParallelChildren: 5,
        batchWindowMs: 100, // 100ms window to collect queries
        maxBudget: 1.0,
        currentDepth: 0,
        maxDepth: 3,
    };
    
    let parallelStartCalled = false;
    let parallelCompleteCalled = false;
    let batchSize = 0;
    
    const mockSubagent = createMockSubagent(50);
    const executor = new ParallelExecutor(config, mockSubagent, {
        onParallelStart: (groupId, count) => {
            parallelStartCalled = true;
            batchSize = count;
        },
        onParallelComplete: (groupId, result) => {
            parallelCompleteCalled = true;
        }
    });
    
    // Queue 3 queries simultaneously (within batch window)
    const promises = [
        executor.queueQuery("Query 1"),
        executor.queueQuery("Query 2"),
        executor.queueQuery("Query 3"),
    ];
    
    const results = await Promise.all(promises);
    
    assertEquals(results.length, 3);
    assertEquals(parallelStartCalled, true);
    assertEquals(parallelCompleteCalled, true);
    assertEquals(batchSize, 3);
    
    const stats = executor.getStats();
    assertEquals(stats.totalQueries, 3);
    assertEquals(stats.parallelBatches, 1);
    assertEquals(stats.totalParallelQueries, 3);
});

Deno.test("ParallelExecutor respects maxParallelChildren", async () => {
    const config: ParallelConfig = {
        maxParallelChildren: 2, // Only 2 at a time
        batchWindowMs: 100,
        maxBudget: 1.0,
        currentDepth: 0,
        maxDepth: 3,
    };
    
    const executionOrder: number[] = [];
    let currentConcurrent = 0;
    let maxConcurrent = 0;
    
    const mockSubagent = async (context: string) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise(resolve => setTimeout(resolve, 50));
        currentConcurrent--;
        return `Done: ${context}`;
    };
    
    const executor = new ParallelExecutor(config, mockSubagent);
    
    // Queue 4 queries
    const promises = [
        executor.queueQuery("Query 1"),
        executor.queueQuery("Query 2"),
        executor.queueQuery("Query 3"),
        executor.queueQuery("Query 4"),
    ];
    
    await Promise.all(promises);
    
    // Max concurrent should not exceed 2
    assertEquals(maxConcurrent <= 2, true, `Max concurrent was ${maxConcurrent}, expected <= 2`);
});

Deno.test("ParallelExecutor parallel is faster than sequential", async () => {
    const config: ParallelConfig = {
        maxParallelChildren: 5,
        batchWindowMs: 50,
        maxBudget: 1.0,
        currentDepth: 0,
        maxDepth: 3,
    };
    
    // Each query takes 100ms
    const mockSubagent = createMockSubagent(100);
    const executor = new ParallelExecutor(config, mockSubagent);
    
    const startTime = performance.now();
    
    // Queue 3 queries simultaneously
    const promises = [
        executor.queueQuery("Query 1"),
        executor.queueQuery("Query 2"),
        executor.queueQuery("Query 3"),
    ];
    
    await Promise.all(promises);
    
    const elapsed = performance.now() - startTime;
    
    // Sequential would take 3 * 100ms = 300ms
    // Parallel should take ~100ms + overhead (~150ms max)
    // If elapsed < 250ms, parallel execution is working
    assertGreater(250, elapsed, `Elapsed time ${elapsed}ms suggests sequential execution`);
});

Deno.test("ParallelExecutor handles errors gracefully", async () => {
    const config: ParallelConfig = {
        maxParallelChildren: 5,
        batchWindowMs: 100,
        maxBudget: 1.0,
        currentDepth: 0,
        maxDepth: 3,
    };
    
    let callCount = 0;
    const mockSubagent = async (context: string) => {
        callCount++;
        if (context.includes("fail")) {
            throw new Error("Intentional failure");
        }
        return `Success: ${context}`;
    };
    
    const executor = new ParallelExecutor(config, mockSubagent);
    
    // Queue mix of successful and failing queries
    const promises = [
        executor.queueQuery("success 1"),
        executor.queueQuery("fail please"),
        executor.queueQuery("success 2"),
    ];
    
    const results = await Promise.allSettled(promises);
    
    assertEquals(results[0].status, "fulfilled");
    assertEquals(results[1].status, "rejected");
    assertEquals(results[2].status, "fulfilled");
});

Deno.test("ParallelExecutor flush forces immediate execution", async () => {
    const config: ParallelConfig = {
        maxParallelChildren: 5,
        batchWindowMs: 1000, // Long batch window
        maxBudget: 1.0,
        currentDepth: 0,
        maxDepth: 3,
    };
    
    const mockSubagent = createMockSubagent(10);
    const executor = new ParallelExecutor(config, mockSubagent);
    
    // Queue a query
    const promise = executor.queueQuery("Test query");
    
    // Immediately flush (don't wait for batch window)
    await executor.flush();
    
    const result = await promise;
    assertEquals(typeof result, "string");
});

Deno.test("ParallelExecutor resetStats clears statistics", async () => {
    const config: ParallelConfig = {
        maxParallelChildren: 5,
        batchWindowMs: 50,
        maxBudget: 1.0,
        currentDepth: 0,
        maxDepth: 3,
    };
    
    const mockSubagent = createMockSubagent(10);
    const executor = new ParallelExecutor(config, mockSubagent);
    
    await executor.queueQuery("Test query");
    
    let stats = executor.getStats();
    assertEquals(stats.totalQueries, 1);
    
    executor.resetStats();
    
    stats = executor.getStats();
    assertEquals(stats.totalQueries, 0);
    assertEquals(stats.parallelBatches, 0);
});
