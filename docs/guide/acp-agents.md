# ACP Agents

fast-rlm can drive a coding agent that speaks the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) — Claude Code,
Codex, opencode, and others — as the model behind a run.

## How it works

The ACP agent is treated as a **drop-in model**, exactly like an OpenAI-compatible
or Vertex model:

1. fast-rlm sends the agent its system prompt and the message history.
2. The agent replies with a ` ```repl ` code block.
3. fast-rlm executes that block in **its own Pyodide sandbox** and feeds the output
   back on the next turn.

The agent **runs read-only** — it never executes the code or writes files itself.
All execution happens inside fast-rlm's sandbox.

## Selecting an agent

Use an `acp:` prefix on `primary_agent` / `sub_agent` (the same idea as the
`vertex/` prefix):

```yaml
primary_agent: "acp:claude-code"
sub_agent:     "acp:codex?model=gpt-5.5-codex"   # ?model= override is optional
```

```python
from fast_rlm import run, RLMConfig

run("What is 2+2?", config=RLMConfig(primary_agent="acp:opencode"))
```

### Built-in presets

| `acp:` name      | Launches                                   | Read-only mode |
| ---------------- | ------------------------------------------ | -------------- |
| `acp:claude-code`| `npx -y @zed-industries/claude-code-acp`   | `plan` (hard block) |
| `acp:codex`      | `npx -y @zed-industries/codex-acp`         | `read-only` (approval-gated) |
| `acp:opencode`   | `opencode acp`                             | `plan` (hard block) |

**Prerequisites:**

- The Claude Code and Codex presets shell out via `npx`, so **Node / npx must be on
  your PATH**.
- The agent must already be authenticated in its own CLI (e.g. `claude /login`,
  `codex login`, `opencode auth login`).

## Backdoor: any other ACP agent

Only the three presets above are built in. To use any other ACP agent, register it
by command under `acp_agents` and select it by name. A registered name overrides a
built-in preset of the same name.

```python
run(
    "Summarize the input.",
    config=RLMConfig(
        primary_agent="acp:hermes",
        acp_agents={
            "hermes": {"command": "hermes", "args": ["acp"]},
            "cursor": {"command": "npx", "args": ["-y", "cursor-agent-acp"]},
            "pi":     {"command": "npx", "args": ["-y", "pi-acp"]},
        },
    ),
)
```

In YAML:

```yaml
primary_agent: "acp:myagent"
acp_agents:
  myagent:
    command: npx
    args: ["-y", "@acme/foo-acp"]
    readonly_mode: plan      # optional — the agent's read-only mode id, if any
    model: some-model        # optional default model
    env:                     # optional extra env for the agent process
      FOO: bar
```

| Field           | Required | Meaning |
| --------------- | -------- | ------- |
| `command`       | yes      | Executable to spawn. |
| `args`          | no       | Arguments passed to the command. |
| `readonly_mode` | no       | The agent's read-only session mode id. When set, fast-rlm switches the session into it. |
| `model`         | no       | Default model id (overridable per call via `?model=`). |
| `auth_method`   | no       | ACP auth method id (e.g. `chatgpt`). Pinning it silences the provider's "authMethodId is not configured" warning; only consulted on the lazy-auth fallback path. |
| `env`           | no       | Extra environment variables for the agent process. |

## Safety & limitations

- **Isolated cwd.** Every ACP agent runs in a throwaway temp directory, so any stray
  write is contained there rather than in your project.
- **Read-only enforcement varies by agent:**
    - opencode / Claude Code `plan` mode is a **hard block** — edit tools are removed.
    - Codex `read-only` is **approval-gated**, and the ACP bridge auto-approves
      permission prompts, so codex *can* still write. The isolated temp cwd is its
      real guardrail.
    - Agents with **no session modes** (e.g. cursor, hermes) have no `readonly_mode`
      and are contained by the temp cwd alone.
- **Budgets — only `max_global_calls` works.** ACP agents report no token usage,
  so `max_money_spent`, `max_completion_tokens`, and `max_prompt_tokens` are
  **inert** for them (always zero, never trip). The one budget that applies is
  [`max_global_calls`](configuration.md) — a run-wide cap on total LLM calls — which
  **defaults to `50`** for ACP runs. Override it on the config or via
  `--max-global-calls` if you need more or fewer.
