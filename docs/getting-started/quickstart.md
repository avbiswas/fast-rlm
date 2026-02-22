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
