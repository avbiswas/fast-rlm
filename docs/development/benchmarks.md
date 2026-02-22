# Benchmarks

fast-rlm includes evaluation scripts under `benchmarks/` for testing against standard long-context datasets.

## Setup

Install benchmark dependencies:

```bash
uv sync --extra benchmarks
```

This adds the [`datasets`](https://huggingface.co/docs/datasets/) library from Hugging Face.

## Available Benchmarks

### LongBench (NarrativeQA)

**Dataset:** [THUDM/LongBench](https://huggingface.co/datasets/THUDM/LongBench) — a multi-task benchmark for long context understanding.

**What it tests:** Reading comprehension over long narratives. The agent receives a full story plus a question, and must find the answer by exploring the text through its REPL.

```bash
uv run benchmarks/longbench_benchmark.py
```

??? note "Full source: `benchmarks/longbench_benchmark.py`"

    ```python
    import fast_rlm
    from datasets import load_dataset

    ds = load_dataset("THUDM/LongBench",
                      "narrativeqa",
                      split="test",
                      trust_remote_code=True)
    idx = 140

    example = ds[idx]

    query = f"""
    {example['input']}

    {example['context']}
    """

    data = fast_rlm.run(query, prefix=f"longbench_hotpot_idx{idx}")
    print("Expected answer: ", example['answers'])
    ```

To test a different example, change `idx`:

```python
idx = 100  # try different indices
```

---

### Oolong Synth

**Dataset:** [oolongbench/oolong-synth](https://huggingface.co/datasets/oolongbench/oolong-synth) — synthetic long-context tasks including timeline ordering, user tracking, and counting.

**What it tests:** Precise information extraction from very long synthetic contexts. Tasks include tracking timelines, counting occurrences, and following user actions across large documents.

```bash
uv run benchmarks/oolong_synth_benchmark.py
```

??? note "Full source: `benchmarks/oolong_synth_benchmark.py`"

    ```python
    import fast_rlm
    from datasets import load_dataset

    ds = load_dataset("oolongbench/oolong-synth",
                      split="test")
    idx = 100

    example = ds[idx]
    print(example['answer'])

    query = f"""
    {example['context_window_text_with_labels']}

    {example['question']}
    """

    data = fast_rlm.run(query, prefix=f"oolong_synth_idx{idx}")
    print("Expected answer: ", example['answer'])
    ```

You can filter by task type:

```python
# Available task groups: 'timeline', 'user', 'counting'
ds = ds.filter(lambda x: x['task_group'] == 'counting')
```

---

## Adding New Benchmarks

Create a new file in `benchmarks/`. The pattern is simple:

```python
import fast_rlm
from datasets import load_dataset

# 1. Load a dataset
ds = load_dataset("your/dataset", split="test")

# 2. Pick an example
example = ds[0]

# 3. Build a query (question + context)
query = f"{example['question']}\n\n{example['context']}"

# 4. Run it
result = fast_rlm.run(query, prefix="my_benchmark")

# 5. Compare
print("Got:", result["results"])
print("Expected:", example["answer"])
print("Cost:", result["usage"]["cost"])
```

The `usage` field in every result gives you per-run cost and token tracking, useful for comparing efficiency across models and configurations.
