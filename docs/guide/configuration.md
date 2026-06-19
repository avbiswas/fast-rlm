# Configuration

## RLMConfig

All configuration is managed through the `RLMConfig` dataclass. Every field has a sensible default.

```python
from fast_rlm import RLMConfig

config = RLMConfig.default()
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `primary_agent` | `str` | **(required, no default)** | Model used for the root agent. Must be set or `run()` raises. |
| `sub_agent` | `str` | `primary_agent` | Model used for child subagents. When unset, falls back to `primary_agent`. |
| `max_depth` | `int` | `3` | Max recursive subagent depth |
| `max_calls_per_subagent` | `int` | `20` | Max LLM calls a single subagent can make |
| `truncate_len` | `int` | `2000` | Output characters shown to the LLM per step |
| `max_money_spent` | `float` | `1.0` | Budget cap in USD — raises an error once cumulative spend exceeds it (see note below; it's a soft cap, not a hard ceiling) |
| `max_completion_tokens` | `int` | `50000` | Max total completion tokens across all subagents — raises an error if exceeded |
| `max_prompt_tokens` | `int` | `200000` | Max total prompt tokens across all subagents — raises an error if exceeded |

### Modifying config

`RLMConfig` is a dataclass — just set attributes directly:

```python
config = RLMConfig.default()
config.primary_agent = "openai/gpt-5.2"
config.max_depth = 5
config.max_money_spent = 3.0
config.max_completion_tokens = 100000
config.max_prompt_tokens = 500000
```

### Using a dict

You can also pass a plain dict if you prefer:

```python
from fast_rlm import run

result = run(
    "Summarize this document",
    config={"primary_agent": "openai/gpt-5.2-codex", "max_depth": 5},
)
```

Dict values are merged on top of the defaults from `rlm_config.yaml`.

!!! warning "`max_money_spent` is a soft cap, not a hard ceiling"
    The budget is tracked as a single running total across **every** LLM call in the trace — the root agent, all nested subagents at every depth, and the delegation-confirmation calls. That accounting is complete. But the limit is checked *after each call returns*, so it can only stop the **next** call, never calls already in flight.

    This matters because `batch_llm_query(...)` fans out subagents in parallel. All of a batch's calls launch before any of them pushes the cumulative total over the limit, so their tokens are spent (and billed) before the cap trips. Realized spend can therefore **overshoot the limit by roughly `batch_width × cost-per-call`** — e.g. a 5-wide batch against a `$0.05` cap was observed to reach `~$0.19` before halting. Treat `max_money_spent` as "stop once I notice I'm over," not a guaranteed ceiling, and set it with headroom below your true limit. Deep/wide configs (`max_depth`, parallel batches) overshoot more.

    The cap is also **per run (per process)**: the running total resets each time the engine starts, so separate invocations — e.g. benchmarking two models — each get their own independent budget. Nothing tracks spend *across* runs.

!!! note "Cost tracking depends on your provider"
    Not all API providers return cost information in their responses. OpenRouter includes cost data, but OpenAI and most other providers do not. If your provider doesn't return cost, `max_money_spent` won't be able to enforce a budget **at all** (the check is skipped when cost is `null`) and cost will show as "Unknown" in the UI. In that case, use `max_completion_tokens` and `max_prompt_tokens` to control spending instead — these work with any provider since token counts are always returned.

## How config merging works

1. Defaults are loaded from the bundled `rlm_config.yaml`
2. Your overrides (from `RLMConfig` or `dict`) are applied on top
3. The merged config is written to a temp file and passed to the engine

This means you only need to specify what you want to change — everything else keeps its default value.

## Model names

fast-rlm uses [OpenRouter](https://openrouter.ai) by default, so model names follow the OpenRouter format: `provider/model-name`.

Since agents write and execute Python code in a REPL, **choose models that are strong at coding**. Recommended models:

| Model | Name |
|-------|------|
| GPT-5.2 Codex | `openai/gpt-5.2-codex` |
| Claude Sonnet 4.6 | `anthropic/claude-sonnet-4-6` |
| Gemini 3.1 Pro Preview | `google/gemini-3.1-pro-preview` |
| MiniMax M2.5 | `minimax/minimax-m2.5` |
| GLM-5 | `z-ai/glm-5` |

Browse the full list at [openrouter.ai/models](https://openrouter.ai/models).

!!! tip "Using a different provider"
    If you're pointing `RLM_MODEL_BASE_URL` at a different API (e.g. OpenAI directly), use that provider's model names instead (e.g. `gpt-5.2-codex` instead of `openai/gpt-5.2-codex`).
