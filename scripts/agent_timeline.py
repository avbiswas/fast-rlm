"""Print a timeline of all agents from a fast-rlm log file.

Usage:
    python scripts/agent_timeline.py logs/your_log.jsonl
"""

import json
import sys
from datetime import datetime

def parse_time(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))

def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/agent_timeline.py <logfile.jsonl>")
        sys.exit(1)

    log_path = sys.argv[1]

    agents = {}  # run_id -> {depth, start, end, parent_run_id}

    with open(log_path) as f:
        for line in f:
            entry = json.loads(line)
            rid = entry.get("run_id")
            if not rid:
                continue

            t = parse_time(entry["time"])
            step = entry.get("step")
            if rid not in agents:
                agents[rid] = {
                    "depth": entry.get("depth", 0),
                    "start": t,
                    "end": t,
                    "parent": entry.get("parent_run_id"),
                    "steps": set(),
                }
            else:
                agents[rid]["start"] = min(agents[rid]["start"], t)
                agents[rid]["end"] = max(agents[rid]["end"], t)
            if step is not None:
                agents[rid]["steps"].add(step)

    # Sort by start time
    sorted_agents = sorted(agents.items(), key=lambda x: x[1]["start"])

    global_start = sorted_agents[0][1]["start"] if sorted_agents else None

    print(f"{'AGENT ID':<30} {'DEPTH':<6} {'STEPS':>5} {'START':>10} {'END':>10} {'DURATION':>10}")
    print("-" * 78)

    for rid, info in sorted_agents:
        depth = info["depth"]
        indent = "\t" * depth
        offset_start = (info["start"] - global_start).total_seconds()
        offset_end = (info["end"] - global_start).total_seconds()
        duration = (info["end"] - info["start"]).total_seconds()
        num_steps = len(info["steps"])

        short_id = rid.split("-")[-1]  # readable suffix
        print(f"{indent}{short_id:<{30 - depth * 8}} d={depth:<4} {num_steps:>5} +{offset_start:>7.1f}s  +{offset_end:>7.1f}s  ({duration:.1f}s)")

    # Check for concurrency
    print("\n--- Concurrency check ---")
    by_depth = {}
    for rid, info in sorted_agents:
        d = info["depth"]
        by_depth.setdefault(d, []).append((rid, info))

    for depth in sorted(by_depth):
        siblings = by_depth[depth]
        if len(siblings) < 2:
            continue
        for i in range(len(siblings)):
            for j in range(i + 1, len(siblings)):
                a_id, a = siblings[i]
                b_id, b = siblings[j]
                # Check if they share the same parent and overlap in time
                if a["parent"] == b["parent"]:
                    overlap_start = max(a["start"], b["start"])
                    overlap_end = min(a["end"], b["end"])
                    if overlap_start < overlap_end:
                        overlap_s = (overlap_end - overlap_start).total_seconds()
                        print(f"  PARALLEL (depth {depth}): {a_id.split('-')[-1]} & {b_id.split('-')[-1]} overlap by {overlap_s:.1f}s")

if __name__ == "__main__":
    main()
