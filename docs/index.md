# fast-rlm

**Recursive Language Models**

fast-rlm is an inference technique where an LLM interacts with arbitrarily long prompts through an external REPL. The LLM can write code to explore, decompose, and transform the prompt. It can recursively invoke sub-agents to complete smaller subtasks. Crucially, sub-agent responses are not automatically loaded into the parent agent's context — they are returned as symbols or variables inside the parent's REPL.

[:material-download: Install](getting-started/installation.md){ .md-button .md-button--primary }
[:material-play: Quick Start](getting-started/quickstart.md){ .md-button }

---

## How it works

```
User Query
    |
    v
Root Agent (primary_agent)
    |-- writes Python code in REPL
    |-- calls llm_query() to spawn sub-agents
    |       |
    |       v
    |   Sub-Agent (sub_agent)
    |       |-- explores a chunk of context
    |       |-- returns result as a variable
    |       v
    |   (result flows back as symbol, not raw text)
    |
    v
Final Answer
```

The root agent orchestrates the task by writing Python code. When it needs help with a subtask, it calls `llm_query()` which spawns a child agent. Child agents can spawn their own children, up to `max_depth` levels deep. Each agent has a budget of `max_calls_per_subagent` LLM calls.

## Features

- **Recursive decomposition** — agents spawn sub-agents to handle subtasks
- **REPL-based reasoning** — agents write and execute Python code iteratively
- **Budget controls** — set hard limits on depth, calls, and dollar spend
- **Any OpenAI-compatible API** — works with OpenRouter, OpenAI, local models, etc.
- **Structured logging** — every step logged as JSONL, viewable in an interactive TUI

## Learn More

<div style="position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; max-width: 100%; margin-bottom: 1em;">
  <iframe src="https://www.youtube.com/embed/nxaVvvrezbY" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;" frameborder="0" allowfullscreen></iframe>
</div>

[:material-file-document: Read the paper on arXiv](https://arxiv.org/abs/2512.24601)

## Support

If you find this helpful, consider supporting on Patreon — it hosts all code, projects, slides, and write-ups from the YouTube channel.

[:material-heart: Become a Patron](https://www.patreon.com/NeuralBreakdownwithAVB){ .md-button }
