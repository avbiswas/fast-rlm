"""Two-MCP-server demo: an autonomous research assistant over the REAL internet.

  fetch  ->  `html-to-markdown-mcp` (levz0r): lightweight, pure-JS (Turndown),
             no browser/API key. Fetches a URL and converts it to clean markdown.
             Tool: html_to_markdown(url=..., maxLength=...).
  fs     ->  official `@modelcontextprotocol/server-filesystem`: writes to disk.

Give the RLM a few topics. It fetches their Wikipedia articles via the fetch
server, keeps the (large) page text in REPL variables, fans out sub-agents to
analyze each in parallel, synthesizes a comparison brief, and writes it to disk
via the filesystem server. The full articles never enter the model's context.

Requires: uv/uvx on PATH, internet access, and the filesystem server installed
(cd scripts/mcp_testbed && bun add @modelcontextprotocol/server-filesystem).
"""

import json
import os

import fast_rlm
from fast_rlm import RLMConfig

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # examples/ -> repo root
TESTBED = os.path.join(REPO, "scripts", "mcp_testbed")
OUT_DIR = os.path.realpath("/tmp/rlm-wiki-demo")  # realpath dodges macOS /tmp -> /private/tmp
os.makedirs(OUT_DIR, exist_ok=True)
REPORT = os.path.join(OUT_DIR, "ai-milestones-brief.md")
FS_SERVER = os.path.join(
    TESTBED, "node_modules",
    "@modelcontextprotocol", "server-filesystem", "dist", "index.js",
)
FETCH_SERVER = os.path.join(
    TESTBED, "node_modules", "html-to-markdown-mcp", "index.js",
)

TOPICS = {
    "AlphaGo": "https://en.wikipedia.org/wiki/AlphaGo",
    "AlphaFold": "https://en.wikipedia.org/wiki/AlphaFold",
    "GPT-3": "https://en.wikipedia.org/wiki/GPT-3",
}

config = RLMConfig.default()
config.max_calls_per_subagent = 18
config.max_money_spent = 1.0
config.max_prompt_tokens = 1_500_000      # Wikipedia pages are large
config.max_completion_tokens = 300_000

task = f"""You are a research assistant with TWO MCP servers:

  - 'fetch': fetches a URL and returns it as clean markdown (a single string).
    Call: await mcp_call("fetch", "html_to_markdown", url=URL). Optionally pass
    maxLength=N to cap very large pages. Returns ONE markdown string per call.
    Pages can be long — KEEP the returned text in REPL variables (do not print whole pages).
  - 'fs': a filesystem server rooted at {OUT_DIR}.

Research these three landmark AI systems from their Wikipedia articles:
{json.dumps(TOPICS, indent=2)}

Do this:
1. Fetch each article (chunk if long). Keep each page's text in a variable.
2. For each system, use a sub-agent (llm_query) to extract: what it is, the year
   it appeared, the organization behind it, and why it was a landmark. Run these
   in parallel.
3. Synthesize a markdown comparison brief: a title, one section per system, and a
   final "Common threads" paragraph on what these milestones share.
4. Write the brief to {REPORT} via the fs server's write tool.
5. FINAL a JSON dict: {{"report_path": ..., "systems": [...names...]}}."""

# --- stdio transport (used here) -------------------------------------------
# stdio servers are SPAWNED by the fast-rlm host (and killed when the run ends),
# so you do NOT start them yourself — you just give the command to launch.
mcp_servers = {
    "fetch": {
        "command": "node",
        "args": [FETCH_SERVER],
        "cwd": TESTBED,
    },
    "fs": {
        "command": "node",
        "args": [FS_SERVER, OUT_DIR],
        "cwd": TESTBED,
    },
}

# --- HTTP transport (alternative) ------------------------------------------
# For HTTP you DON'T give a command — the server must already be running and
# listening, and you point at its URL. Pick transport per-server by config shape:
# `command` => stdio (spawned for you); `url` => HTTP (you run it).
#
# mcp_servers = {
#     "demo": {"url": "http://localhost:3333/mcp"},
#     # "remote": {"url": "https://example.com/mcp", "headers": {"Authorization": "Bearer ..."}},
# }
# (e.g. start one first:  cd scripts/mcp_testbed && bun run http.ts )

result = fast_rlm.run(
    task,
    prefix="demo_wiki",
    config=config,
    mcp_servers=mcp_servers,
)

print("\n" + "=" * 72)
print(" AUTONOMOUS WIKIPEDIA RESEARCH — fetch + filesystem MCP, 1 small model")
print("=" * 72)
print("FINAL:", json.dumps(result["results"], indent=2) if isinstance(result["results"], dict) else result["results"])
u = result["usage"]
print("-" * 72)
print(f"Model context used : {u['prompt_tokens']:,} prompt tokens ({u['cached_tokens']:,} cached)")
print(f"Cost               : ${u['cost']:.4f}")
print(f"Report on disk     : {REPORT}")
print("=" * 72)
if os.path.exists(REPORT):
    print("\n----- ai-milestones-brief.md -----\n")
    print(open(REPORT).read())
