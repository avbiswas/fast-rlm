"""Smoketest the ACP backend (Claude Code / Codex / opencode / backdoor).

Runs a few deterministic tasks through the real fast_rlm.run() pipeline using an
ACP agent as the model, and asserts the results. This exercises the whole path:
  acp: model string -> preset/backdoor resolution -> spawn agent (read-only) ->
  agent emits a ```repl``` block -> fast-rlm executes it in Pyodide -> FINAL.

Prerequisites (the agent must already be logged in via its own CLI):
  - acp:opencode      -> `opencode` on PATH, `opencode auth login`
  - acp:claude-code   -> Node/npx on PATH, `claude /login`
  - acp:codex         -> Node/npx on PATH, `codex login`

Usage:
    uv run examples/acp_smoketest.py                 # defaults to acp:opencode
    uv run examples/acp_smoketest.py acp:codex       # pick a preset
    uv run examples/acp_smoketest.py acp:claude-code acp:opencode   # several
    uv run examples/acp_smoketest.py --backdoor      # also test acp_agents registry
"""

import sys

import fast_rlm

PASS, FAIL = "✔", "✗"


# Each case: (label, query, output_schema, checker(result) -> bool)
CASES = [
    (
        "arithmetic",
        "Compute the sum of integers from 1 to 100 in Python, then call FINAL(result) "
        "with the integer. Do not delegate.",
        int,
        lambda r: int(r) == 5050,
    ),
    (
        "string-op",
        "Uppercase the string 'hello world' in Python and call FINAL with the result. "
        "Do not delegate.",
        str,
        lambda r: str(r).strip() == "HELLO WORLD",
    ),
    (
        "list-count",
        "Given the list [3, 1, 4, 1, 5, 9, 2, 6], compute how many elements are strictly "
        "greater than 3, then FINAL that integer count. Do not delegate.",
        int,
        lambda r: int(r) == 4,  # 4, 5, 9, 6
    ),
]


def run_agent(agent: str, acp_agents: dict | None = None) -> bool:
    """Run all cases against one agent. Returns True if all passed."""
    print(f"\n{'=' * 60}\nAgent: {agent}" + (f"  (backdoor: {list((acp_agents or {}).keys())})" if acp_agents else "") + f"\n{'=' * 60}")
    all_ok = True
    for label, query, schema, check in CASES:
        config = fast_rlm.RLMConfig()
        config.primary_agent = agent
        config.sub_agent = agent
        config.max_depth = 1
        config.max_calls_per_subagent = 6
        # Global call cap: the stop gap that actually works for ACP (token/cost
        # budgets are always zero there). Always set this for ACP agents.
        config.max_global_calls = 50
        config.enable_compression_guard = False  # not meaningful for single-shot tasks
        if acp_agents:
            config.acp_agents = acp_agents
        try:
            data = fast_rlm.run(query, config=config, prefix=f"acp_{label}",
                                output_schema=schema)
            result = data.get("results")
            ok = bool(result is not None and check(result))
            print(f"  {PASS if ok else FAIL} {label:12s} -> {result!r}")
            if not ok:
                all_ok = False
        except Exception as e:
            print(f"  {FAIL} {label:12s} raised {type(e).__name__}: {e}")
            all_ok = False
    return all_ok


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    agents = args or ["acp:opencode"]

    results: list[tuple[str, bool]] = []
    for agent in agents:
        results.append((agent, run_agent(agent)))

    # Backdoor: register opencode under a custom name and select it via acp:<name>.
    if "--backdoor" in flags:
        registry = {"myacp": {"command": "opencode", "args": ["acp"], "readonly_mode": "plan"}}
        results.append(("acp:myacp (backdoor)", run_agent("acp:myacp", acp_agents=registry)))

    print("\n" + "=" * 60)
    failed = [a for a, ok in results if not ok]
    for agent, ok in results:
        print(f"  {PASS if ok else FAIL} {agent}")
    if failed:
        print(f"\nACP SMOKETEST FAILED for: {', '.join(failed)}")
        sys.exit(1)
    print("\nACP SMOKETEST PASSED")
