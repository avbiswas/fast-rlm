# Quick Start

![Quickstart](../images/quickstart.jpeg)

## Basic usage

```python
import fast_rlm

result = fast_rlm.run("Generate 50 fruits and count number of r")
print(result["results"])
print(result["usage"])
```

The returned dict contains:

```python
{
    "results": ...,        # the agent's final answer
    "log_file": "...",     # path to the JSONL log
    "usage": {
        "prompt_tokens": 12345,
        "completion_tokens": 678,
        "total_tokens": 13023,
        "cached_tokens": 5000,
        "reasoning_tokens": 200,
        "cost": 0.0342
    }
}
```

## Arbitrarily long context

The key idea behind RLMs is that the prompt can be arbitrarily long — far beyond any model's context window. The agent explores it programmatically through the REPL rather than trying to fit it all into a single call.

```python
import fast_rlm

transcripts = open("lex_fridman_all_transcripts.txt").read()  # millions of tokens

result = fast_rlm.run(
    "Here are the transcripts of all Lex Fridman podcasts. "
    "Summarize what the first 5 Machine Learning guests had to say about AGI.\n\n"
    + transcripts
)
print(result["results"])
```

The agent will write code to search, filter, and chunk the transcripts on its own — no manual splitting required.

## With configuration

```python
from fast_rlm import run, RLMConfig

config = RLMConfig.default()
config.primary_agent = "minimax/minimax-m2.5"
config.sub_agent = "minimax/minimax-m2.5"
config.max_depth = 5
config.max_money_spent = 2.0

result = run(
    "Count the r's in 50 fruit names",
    prefix="r_count",
    config=config,
)
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | `str` | _(required)_ | The question or context to process |
| `prefix` | `str` | `None` | Log filename prefix (e.g. `"r_count"` → `r_count_2026-02-23T...`) |
| `config` | `RLMConfig` or `dict` | `None` | Config overrides (see [Configuration](../guide/configuration.md)) |
| `verbose` | `bool` | `True` | Stream engine output to terminal |

## Quiet mode

To suppress all terminal output and just get the result:

```python
result = fast_rlm.run("What is 2+2?", verbose=False)
```
