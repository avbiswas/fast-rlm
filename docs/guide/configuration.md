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
| `primary_agent` | `str` | `z-ai/glm-5` | Model used for the root agent |
| `sub_agent` | `str` | `minimax/minimax-m2.5` | Model used for child subagents |
| `max_depth` | `int` | `3` | Max recursive subagent depth |
| `max_calls_per_subagent` | `int` | `20` | Max LLM calls a single subagent can make |
| `truncate_len` | `int` | `2000` | Output characters shown to the LLM per step |
| `max_money_spent` | `float` | `1.0` | Hard budget cap in USD — raises an error if exceeded |

### Modifying config

`RLMConfig` is a dataclass — just set attributes directly:

```python
config = RLMConfig.default()
config.primary_agent = "openai/gpt-5.2-codex"
config.max_depth = 5
config.max_money_spent = 3.0
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
