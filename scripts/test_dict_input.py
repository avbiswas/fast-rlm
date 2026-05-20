"""Smoke test for structured (dict) input to fast_rlm.run().

Pass criteria:
- result["results"] mentions apple, cherry, tomato (and ideally nothing else).
- Step 0 of the log shows the dict schema probe (Keys (3): ['task', 'items', 'decoy'])
  rather than "First 500 characters of str(context)".
- The agent should index context["items"] directly in its first real step.
"""

import fast_rlm

config = fast_rlm.RLMConfig()
config.primary_agent = "minimax/minimax-m2.5"
config.sub_agent = "minimax/minimax-m2.5"
config.max_depth = 1
config.max_calls_per_subagent = 5
config.max_money_spent = 0.10

result = fast_rlm.run(
    {
        "task": "Return a JSON list of the names of items whose color is 'red'.",
        "items": [
            {"name": "apple", "color": "red"},
            {"name": "lemon", "color": "yellow"},
            {"name": "cherry", "color": "red"},
            {"name": "lime", "color": "green"},
            {"name": "tomato", "color": "red"},
        ],
        "decoy": "ignore this entirely",
    },
    prefix="dict_input_test",
)

print("RESULT:", result["results"])
print("LOG:", result.get("log_file"))
print("USAGE:", result.get("usage"))
