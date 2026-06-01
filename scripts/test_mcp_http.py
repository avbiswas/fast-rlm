import fast_rlm
from fast_rlm import RLMConfig

config = RLMConfig.default()
config.max_calls_per_subagent = 10
config.max_money_spent = 0.5

result = fast_rlm.run(
    "There is an MCP server 'demo' connected over HTTP. List its resources, then "
    "read the resource with uri 'testbed://greeting' and call FINAL with its exact text.",
    prefix="mcp_http_test",
    config=config,
    mcp_servers={"demo": {"url": "http://localhost:3333/mcp"}},
)

print("\n\n===== RESULT =====")
print(result["results"])
print("usage:", result.get("usage"))
