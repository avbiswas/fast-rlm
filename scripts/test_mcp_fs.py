import os
import fast_rlm
from fast_rlm import RLMConfig

TESTBED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcp_testbed")
SERVER = os.path.join(
    TESTBED, "node_modules",
    "@modelcontextprotocol", "server-filesystem", "dist", "index.js",
)
ALLOWED_DIR = "/tmp/mcp-fs-demo"

config = RLMConfig.default()
config.primary_agent = "minimax/minimax-m3"  # hardcoded for this test script
config.max_calls_per_subagent = 12
config.max_money_spent = 0.5

result = fast_rlm.run(
    f"You have the official MCP filesystem server connected (server name 'fs'), "
    f"rooted at {ALLOWED_DIR}. Explore the directory tree, read every .txt file you "
    f"find (including nested ones), and FINAL a dict mapping each file's relative path "
    f"to the number of lines it contains.",
    prefix="mcp_fs_test",
    config=config,
    mcp_servers={
        "fs": {
            "command": "node",
            "args": [SERVER, ALLOWED_DIR],
            "cwd": TESTBED,
        }
    },
)

print("\n\n===== RESULT =====")
print(result["results"])
print("usage:", result.get("usage"))
