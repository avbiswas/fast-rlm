# Development from Source

## Prerequisites

- [Deno](https://deno.land/) 2+
- [Bun](https://bun.sh/) (for the log viewer)
- [uv](https://docs.astral.sh/uv/) (for Python/benchmarks)

## Setup

```bash
git clone https://github.com/avbiswas/fast-rlm.git
cd fast-rlm
```

### Install log viewer dependencies

```bash
cd tui_log_viewer && bun install && cd ..
```

### Set your API key

Create a `.env` file in the project root:

```
RLM_MODEL_API_KEY=sk-or-...
RLM_MODEL_BASE_URL=https://openrouter.ai/api/v1
```

Or use `.envrc` with [direnv](https://direnv.net/):

```bash
export RLM_MODEL_API_KEY=sk-or-...
export RLM_MODEL_BASE_URL=https://openrouter.ai/api/v1  # optional, this is the default
```

| Variable | Description | Default |
|----------|-------------|---------|
| `RLM_MODEL_API_KEY` | API key for your LLM provider | _(required)_ |
| `RLM_MODEL_BASE_URL` | OpenAI-compatible base URL | `https://openrouter.ai/api/v1` |

## Configuration

Edit `rlm_config.yaml` at the project root:

```yaml
max_calls_per_subagent: 20
max_depth: 3
truncate_len: 2000
primary_agent: "z-ai/glm-5"
sub_agent: "minimax/minimax-m2.5"
max_money_spent: 1.0
```

## Running

```bash
# Run the counting-r example
deno task test_counting_r

# Run the subagent directly
echo "What is 2+2?" | deno task subagent

# View logs
./viewlog logs/<logfile>.jsonl
```

## Editable Python install

To develop the Python package locally:

```bash
uv pip install -e .
```

Changes to `fast_rlm/` and `src/` are reflected immediately — no rebuild needed.

## Project structure

```
fast-rlm/
├── fast_rlm/              # Python package
│   ├── __init__.py        # Public API: run(), RLMConfig
│   ├── _runner.py         # Engine discovery, config merge, subprocess
│   └── _cli.py            # fast-rlm-log CLI entry point
├── src/                   # TypeScript engine (Deno)
│   ├── subagents.ts       # Core recursive agent loop
│   ├── call_llm.ts        # LLM API client
│   ├── prompt.ts          # System prompt
│   ├── logging.ts         # Pino-based JSONL logger
│   ├── ui.ts              # Terminal UI (spinners, boxes)
│   └── usage.ts           # Token/cost tracking
├── tui_log_viewer/        # OpenTUI log viewer (Bun)
├── benchmarks/            # Evaluation scripts
├── deno.json              # Deno config + task definitions
├── rlm_config.yaml        # Default agent configuration
└── pyproject.toml         # Python build config (hatchling)
```
