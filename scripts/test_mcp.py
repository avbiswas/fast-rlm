import os
import fast_rlm
from fast_rlm import RLMConfig

TESTBED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcp_testbed")

config = RLMConfig.default()
config.max_calls_per_subagent = 10
config.max_money_spent = 0.5

result = fast_rlm.run(
    "Use the fsio MCP server. First write a file named hello.txt containing exactly "
    "'hi there from mcp', then read it back to confirm. Call FINAL with the exact "
    "contents you read back.",
    prefix="mcp_test",
    config=config,
    mcp_servers={
        "fsio": {
            "command": "bun",
            "args": ["run", "fsio-stdio.ts"],
            "cwd": TESTBED,
            "env": {"FSIO_ROOT": "/tmp/fsio-scratch"},
        }
    },
)

print("\n\n===== RESULT =====")
print(result["results"])
print("usage:", result.get("usage"))
