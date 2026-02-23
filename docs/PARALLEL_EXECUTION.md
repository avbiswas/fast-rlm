# Parallel Sub-Agent Execution

This PR adds parallel execution support for `llm_query()` calls when used with `asyncio.gather()` in fast-rlm.

## Problem

When Python code uses `asyncio.gather()` to call multiple `llm_query()` functions, they should execute in parallel. However, the current implementation executes them sequentially because each `llm_query()` call immediately `await`s its child agent.

**Example from the system prompt:**
```python
import asyncio

tasks = []
for i in range(10):
    chunk_str = "\\n".join(context[i * chunk_size: (i + 1) * chunk_size])
    task = llm_query(f"Try to answer the following query: {query}. Here are the documents:\\n{chunk_str}")
    tasks.append(task)

answers = await asyncio.gather(*tasks)  # Should run in parallel!
```

**Before this PR:** 10 chunks × 5s/chunk = 50s total (sequential)
**After this PR:** 10 chunks in parallel = ~5s total (10x speedup)

## Solution

Introduced a `ParallelExecutor` class that:

1. **Detects parallel invocations**: Collects `llm_query()` calls within a short time window (default 50ms)
2. **Batches and executes in parallel**: Uses `Promise.all()` to run collected sub-agents concurrently
3. **Respects budget limits**: Splits `max_money_spent` across parallel children
4. **Tracks parallel execution**: Adds `parallel_group_id` for observability in logs

## Files Changed

| File | Description |
|------|-------------|
| `src/parallel.ts` | **NEW** - ParallelExecutor class with batching logic |
| `tests/test_parallel.ts` | **NEW** - 10 comprehensive unit tests |
| `src/subagents.ts` | Integrated ParallelExecutor into llm_query |
| `src/logging.ts` | Added parallel_group_id to log entries |
| `src/usage.ts` | Added parallel execution statistics |
| `src/ui.ts` | Added parallel execution UI indicator |
| `rlm_config.yaml` | Added max_parallel_children and parallel_batch_window_ms |
| `fast_rlm/_runner.py` | Added Python config options |

## Configuration

New config options in `rlm_config.yaml`:

```yaml
# Maximum number of sub-agents to run in parallel (0 = unlimited)
max_parallel_children: 5

# Time window to collect concurrent queries before batching (ms)
parallel_batch_window_ms: 50
```

## Testing

All 10 unit tests pass:

```
$ deno test tests/test_parallel.ts --allow-all --no-check

running 10 tests from ./tests/test_parallel.ts
generateParallelGroupId creates unique IDs ... ok (0ms)
shouldUseParallelExecution respects depth limit ... ok (0ms)
shouldUseParallelExecution respects budget ... ok (0ms)
ParallelExecutor handles single query without batching ... ok (66ms)
ParallelExecutor batches concurrent queries ... ok (155ms)
ParallelExecutor respects maxParallelChildren ... ok (205ms)
ParallelExecutor parallel is faster than sequential ... ok (155ms)
ParallelExecutor handles errors gracefully ... ok (103ms)
ParallelExecutor flush forces immediate execution ... ok (12ms)
ParallelExecutor resetStats clears statistics ... ok (63ms)

ok | 10 passed | 0 failed (781ms)
```

## UI Changes

When parallel execution occurs, the terminal shows:

```
⚡ Parallel Execution Started: 5 sub-agents in group pg-1234abcd
    │ ─── Depth 1 · Step 1/20 ⚡ pg-1234ab ───
    │ ... (parallel agent 1)
    │ ─── Depth 1 · Step 1/20 ⚡ pg-1234ab ───
    │ ... (parallel agent 2)
    │ ...
✓ Parallel Execution Complete: 5 sub-agents in group pg-1234abcd (1.23s)
```

## Logging

JSONL logs now include `parallel_group_id` for tracing parallel execution:

```json
{
  "run_id": "1234-abc",
  "parent_run_id": "5678-def",
  "parallel_group_id": "pg-1234567890-abcdef",
  "depth": 1,
  "step": 1,
  "event_type": "execution_result",
  ...
}
```

## Backward Compatibility

- Single `llm_query()` calls work exactly as before (no batching overhead)
- All existing tests continue to pass
- New config options have sensible defaults
- No breaking API changes
