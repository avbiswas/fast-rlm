import json
import os
import subprocess
import tempfile


def run(query: str, prefix: str = None, verbose: bool = True) -> dict:
    output_file = tempfile.mktemp(suffix=".json")

    # primary_agent is required by the engine and has no default — hardcode one
    # for this test wrapper and pass it via a temp config file.
    config_file = tempfile.mktemp(suffix=".yaml")
    with open(config_file, "w") as f:
        f.write('primary_agent: "minimax/minimax-m3"\n')

    cmd = ["deno", "task", "-q", "subagent", "--config", config_file, "--output", output_file]
    if prefix:
        cmd += ["--prefix", prefix]

    subprocess.run(
        cmd,
        input=query,
        text=True,
        stdout=None if verbose else subprocess.DEVNULL,
        stderr=None if verbose else subprocess.DEVNULL,
    )

    data = json.loads(open(output_file).read())
    os.unlink(output_file)
    os.unlink(config_file)

    if "error" in data:
        raise RuntimeError(f"fast-rlm subagent failed: {data['error']}")

    return data
