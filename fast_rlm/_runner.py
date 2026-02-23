import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

import yaml


@dataclass
class RLMConfig:
    """Configuration for fast-rlm."""

    primary_agent: str = "z-ai/glm-5"
    sub_agent: str = "minimax/minimax-m2.5"
    max_depth: int = 3
    max_calls_per_subagent: int = 20
    truncate_len: int = 2000
    max_money_spent: float = 1.0
    max_parallel_children: int = 5
    parallel_batch_window_ms: int = 50

    @classmethod
    def default(cls) -> "RLMConfig":
        """Load defaults from bundled rlm_config.yaml."""
        try:
            engine_dir = _find_engine_dir()
            config_path = engine_dir / "rlm_config.yaml"
            with open(config_path) as f:
                data = yaml.safe_load(f) or {}
            return cls(
                **{k: v for k, v in data.items() if k in cls.__dataclass_fields__}
            )
        except Exception:
            return cls()


def _find_engine_dir() -> Path:
    """Find the TS engine: bundled (_engine/) for pip install, project root for dev."""
    bundled = Path(__file__).parent / "_engine"
    if (bundled / "deno.json").exists():
        return bundled

    # Editable / dev install: walk up to project root
    root = Path(__file__).resolve().parent.parent
    if (root / "deno.json").exists():
        return root

    raise FileNotFoundError(
        "Cannot find the fast-rlm TS engine. "
        "Ensure the package is installed correctly or you're in the project root."
    )


def _check_deno():
    if shutil.which("deno") is None:
        raise RuntimeError(
            "Deno is required but not found on PATH.\n"
            "Install it on (Mac/Linux): curl -fsSL https://deno.land/install.sh | sh\n"
            "Install it on (Windows): npm install -g deno\n"
            "Visit: https://docs.deno.com/runtime/getting_started/installation/ for more installation options"
        )

def _deno_prefix_cmd() -> list[str]:
    """Return a subprocess-safe Deno command prefix across platforms."""
    deno = shutil.which("deno")
    if deno is None:
        raise RuntimeError("Deno is required but not found on PATH.")

    # npm installs on Windows often expose deno as a .cmd shim.
    # Python's subprocess can fail on that directly, so route via cmd.exe.
    if os.name == "nt" and deno.lower().endswith(".cmd"):
        return ["cmd", "/c", deno]
    return [deno]


def run(
    query: str,
    prefix: Optional[str] = None,
    config: Optional[RLMConfig | dict] = None,
    verbose: bool = True,
) -> dict:
    """Run a fast-rlm query.

    Args:
        query: The question / context to process.
        prefix: Optional log filename prefix.
        config: RLMConfig object or dict of overrides (e.g. primary_agent, max_depth).
        verbose: If True, stream deno stdout/stderr to terminal.

    Returns:
        Dict with 'results', 'usage', and optionally 'log_file'.
    """
    _check_deno()
    engine_dir = _find_engine_dir()

    output_file = tempfile.mktemp(suffix=".json")
    log_dir = os.path.join(os.getcwd(), "logs")

    cmd = _deno_prefix_cmd() + [
        "run",
        "--allow-read",
        "--allow-env",
        "--allow-net",
        "--allow-sys=hostname,osRelease",
        "--allow-write",
        "src/subagents.ts",
        "--log-dir",
        log_dir,
        "--output",
        output_file,
    ]

    if prefix:
        cmd += ["--prefix", prefix]

    # RLMConfig merge: load defaults, overlay user overrides, write to temp file
    config_tmpfile = None
    if config is not None:
        if isinstance(config, RLMConfig):
            config = asdict(config)

        default_config_path = engine_dir / "rlm_config.yaml"
        defaults = {}
        if default_config_path.exists():
            with open(default_config_path) as f:
                defaults = yaml.safe_load(f) or {}
        merged = {**defaults, **config}

        config_tmpfile = tempfile.mktemp(suffix=".yaml")
        with open(config_tmpfile, "w") as f:
            yaml.dump(merged, f)
        cmd += ["--config", config_tmpfile]

    try:
        result = subprocess.run(
            cmd,
            input=query,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(engine_dir),
            stdout=None if verbose else subprocess.PIPE,
            stderr=None if verbose else subprocess.PIPE,
        )

        if not os.path.exists(output_file):
            stderr = result.stderr or "" if not verbose else ""
            raise RuntimeError(
                f"fast-rlm engine failed (exit code {result.returncode}).\n{stderr}"
            )

        with open(output_file) as f:
            data = json.load(f)
    finally:
        if os.path.exists(output_file):
            os.unlink(output_file)
        if config_tmpfile and os.path.exists(config_tmpfile):
            os.unlink(config_tmpfile)

    if "error" in data:
        raise RuntimeError(f"fast-rlm subagent failed: {data['error']}")

    return data
