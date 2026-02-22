import json
import os
import shutil
import subprocess
import sys

from fast_rlm._runner import _find_engine_dir

USAGE = "Usage: fast-rlm-log <log-file.jsonl> [--stats|--tui]"


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
            print(
                "Error: bun is required for the TUI log viewer but was not found on PATH.\n"
                "Install it with: curl -fsSL https://bun.sh/install | bash",
                file=sys.stderr,
            )
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
