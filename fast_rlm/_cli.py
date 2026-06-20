import argparse
import json
import os
import shutil
import subprocess
import sys

from fast_rlm._runner import _find_engine_dir

USAGE = "Usage: fast-rlm-log <log-file.jsonl> [--stats|--tui]"


def main():
    """`fast-rlm` CLI entry point — a thin front door over fast_rlm.run()."""
    p = argparse.ArgumentParser(
        prog="fast-rlm",
        description="Run a fast-rlm query from the command line.",
    )
    p.add_argument("prompt", nargs="?", default=None,
                   help="The task/prompt. Goes into the system prompt as the "
                        "instruction. Optional only if --input-file is given.")
    p.add_argument("--input-file", default=None,
                   help="Path to the input. .json/.yaml/.yml -> dict/list, "
                        ".jsonl/.ndjson -> list[dict]; anything else (.csv, .tsv, "
                        ".xml, .toml, .txt, ...) -> raw text the model parses "
                        "itself (the extension is passed to it). Becomes the query "
                        "context; the prompt stays the instruction.")
    p.add_argument("--primary-agent", default=None,
                   help="Root-agent model (e.g. 'z-ai/glm-5', 'acp:opencode').")
    p.add_argument("--sub-agent", default=None,
                   help="Sub-agent model (defaults to --primary-agent).")
    p.add_argument("--max-depth", type=int, default=None,
                   help="Max recursive sub-agent depth (default: RLMConfig's 3).")
    p.add_argument("--max-calls", type=int, default=None,
                   help="Max REPL calls per sub-agent (default: RLMConfig's 20).")
    p.add_argument("--max-global-calls", type=int, default=None,
                   help="Global cap on total LLM calls across the whole run "
                        "(root + all sub-agents). Recommended for ACP agents.")
    p.add_argument("--acp-agents", default=None,
                   help="JSON registry of custom ACP agents (or @file.json). "
                        "Only needed for non-preset agents.")
    p.add_argument("--prefix", default=None, help="Log filename prefix.")
    p.add_argument("--vertex", action="store_true",
                   help="Route models through Vertex AI (ADC auth).")
    p.add_argument("-q", "--quiet", action="store_true",
                   help="Suppress the engine's streamed output.")
    args = p.parse_args()

    if not args.prompt and not args.input_file:
        p.error("provide a prompt, --input-file, or both.")

    if args.input_file and not os.path.exists(args.input_file):
        p.error(f"input file not found: {args.input_file}")

    config: dict = {}
    if args.primary_agent:
        config["primary_agent"] = args.primary_agent
    if args.sub_agent:
        config["sub_agent"] = args.sub_agent
    if args.max_depth is not None:
        config["max_depth"] = args.max_depth
    if args.max_calls is not None:
        config["max_calls_per_subagent"] = args.max_calls
    if args.max_global_calls is not None:
        config["max_global_calls"] = args.max_global_calls
    if args.acp_agents:
        raw = args.acp_agents
        if raw.startswith("@"):
            with open(raw[1:]) as f:
                raw = f.read()
        config["acp_agents"] = json.loads(raw)

    # Imported here so `fast-rlm-log` and --help don't pay the import cost.
    from fast_rlm._runner import run

    # The positional prompt is always the instruction (it goes into the system
    # prompt). With no --input-file it's also the query; otherwise run() loads the
    # file into the query and handles the extension note / dict injection.
    data = run(
        query=None if args.input_file else args.prompt,
        input_file=args.input_file,
        instruction=args.prompt,
        config=config or None,
        prefix=args.prefix,
        vertex=args.vertex,
        verbose=not args.quiet,
    )

    results = data.get("results")
    if isinstance(results, (dict, list)):
        print(json.dumps(results, indent=2, ensure_ascii=False))
    else:
        print(results)
    if data.get("log_file"):
        print(f"\nLog: {data['log_file']}", file=sys.stderr)


def _print_stats(log_path: str):
    with open(log_path) as f:
        entries = [json.loads(line) for line in f if line.strip()]

    if not entries:
        print("No log entries found.")
        return

    runs = {}
    for e in entries:
        rid = e.get("run_id", "unknown")
        if rid not in runs:
            runs[rid] = {"depth": e.get("depth", 0), "steps": 0, "usage": None}
        if e.get("event_type") in ("execution_result", "code_generated"):
            runs[rid]["steps"] += 1
        if e.get("usage"):
            runs[rid]["usage"] = e["usage"]

    total_tokens = 0
    total_cost = 0.0
    for e in entries:
        u = e.get("usage")
        if u:
            total_tokens += u.get("total_tokens", 0)
            total_cost += u.get("cost", 0)

    max_depth = max(e.get("depth", 0) for e in entries)
    roots = [r for r in runs.values() if r["depth"] == 0]

    print(f"Log entries:  {len(entries)}")
    print(f"Total runs:   {len(runs)}")
    print(f"Root runs:    {len(roots)}")
    print(f"Max depth:    {max_depth}")
    print(f"Total tokens: {total_tokens:,}")
    print(f"Total cost:   ${total_cost:.6f}")


def view_log():
    args = sys.argv[1:]
    if not args or args[0].startswith("-"):
        print(USAGE)
        sys.exit(1)

    log_path = os.path.abspath(args[0])
    if not os.path.exists(log_path):
        print(f"Error: file not found: {log_path}", file=sys.stderr)
        sys.exit(1)

    mode = args[1] if len(args) > 1 else "--stats"

    if mode == "--stats":
        _print_stats(log_path)
        return

    if mode == "--tui":
        if shutil.which("bun") is None:
            if os.name == "nt":
                msg = (
                    "Error: bun is required for the TUI log viewer but was not found on PATH.\n"
                    "Install it with:\n"
                    "  powershell -c \"irm bun.sh/install.ps1 | iex\"\n"
                    "  or: npm install -g bun"
                )
            else:
                msg = (
                    "Error: bun is required for the TUI log viewer but was not found on PATH.\n"
                    "Install it with: curl -fsSL https://bun.sh/install | bash"
                )
            print(msg, file=sys.stderr)
            sys.exit(1)

        engine_dir = _find_engine_dir()
        tui_dir = engine_dir / "tui_log_viewer"

        if not (tui_dir / "node_modules").exists():
            print("Installing log viewer dependencies...")
            subprocess.run(["bun", "install"], cwd=str(tui_dir), check=True)

        cmd = ["bun", "run", "src/index.tsx", log_path]
        sys.exit(subprocess.run(cmd, cwd=str(tui_dir)).returncode)

    print(f"Unknown flag: {mode}")
    print(USAGE)
    sys.exit(1)
