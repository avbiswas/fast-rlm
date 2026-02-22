# Log Viewer

Every run saves a `.jsonl` log file to `logs/`. The log captures every step: code generated, output produced, usage stats, and final results across all agents and sub-agents.

![TUI Log Viewer](../images/tui.jpeg)

## Stats (default)

Print a summary of any log file — no extra dependencies required:

```bash
fast-rlm-log logs/run_2026-02-23T20-33-30-936Z.jsonl
```

Output:

```
Log entries:  42
Total runs:   5
Root runs:    1
Max depth:    2
Total tokens: 45,230
Total cost:   $0.034521
```

## Interactive TUI

For a full interactive viewer with code highlighting, step navigation, and reasoning traces:

```bash
fast-rlm-log logs/run_2026-02-23T20-33-30-936Z.jsonl --tui
```

!!! note "Requires Bun"
    The TUI viewer is built with [OpenTUI](https://github.com/anthropics/opentui) and requires [Bun](https://bun.sh/). Dependencies are installed automatically on first run.

### TUI controls

| Key | Action |
|-----|--------|
| `Up` / `Down` | Navigate steps in current run |
| `Left` / `Right` | Go to parent / child subagent |
| `Tab` / `Shift+Tab` | Next / previous sibling subagent |
| `H` / `J` | Scroll code panel up / down |
| `K` / `L` | Scroll output panel up / down |
| `R` | Toggle reasoning trace modal |
| `O` | Toggle final output modal |
| `q` / `Ctrl+C` | Quit |

## Programmatic access

The log file path is included in every `run()` result:

```python
import fast_rlm

result = fast_rlm.run("What is 2+2?")
print(result["log_file"])  # e.g. "./logs/run_2026-02-23T20-33-30-936Z.jsonl"
```

The log is standard JSONL — each line is a JSON object you can parse with any tool.
