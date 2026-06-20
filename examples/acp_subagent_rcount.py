"""ACP run that launches sub-agents: r-counting across categories.

The root agent must delegate each category to a sub-agent via llm_query (so the
log contains nested agent launches), then count the letter 'r' in every name.
Each ACP sub-agent is a fresh agent process running read-only.

Usage:
    uv run examples/acp_subagent_rcount.py                 # acp:opencode
    uv run examples/acp_subagent_rcount.py acp:codex
"""

import sys

import fast_rlm
from pydantic import BaseModel


class NameRCount(BaseModel):
    name: str
    r_count: int


PROMPT = """
Build a list of {"name": <string>, "r_count": <int>} entries counting the letter
'r' (case-insensitive) in each name, across THREE categories.

You MUST generate each category with a SEPARATE sub-agent call via llm_query
(do not generate the names yourself). Require each sub-agent to return a JSON
list of strings by passing this schema as the second argument:
You must use parallel subagents to find common fruit names, US states, and animal names.
Then, in your OWN repl, count the 'r's in each name and call FINAL with the
combined list of {"name", "r_count"} entries (24 total).
"""

if __name__ == "__main__":
    agent = (sys.argv[1] if len(sys.argv) > 1 else "acp:opencode")

    config = fast_rlm.RLMConfig()
    config.primary_agent = agent
    config.sub_agent = agent
    config.max_depth = 1                 # root + one level of sub-agents
    config.max_calls_per_subagent = 12   # headroom for retries
    # Global call cap: the stop gap that actually works for ACP (token/cost
    # budgets are always zero there). Always set this for ACP agents.
    config.max_global_calls = 50
    config.enable_compression_guard = False  # tiny contexts; avoid extra spawns

    data = fast_rlm.run(
        PROMPT,
        config=config,
        prefix="acp_rcount",
        output_schema=list[NameRCount],
    )

    print("\nResult:", data.get("results"))
    print("Log:", data.get("log_file"))
