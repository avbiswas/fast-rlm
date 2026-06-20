import inspect
import json
import os
import shutil
import subprocess
import tempfile
import textwrap
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable, Optional

import yaml


_PRIMITIVE_JSON_SCHEMAS = {
    str: {"type": "string"},
    int: {"type": "integer"},
    float: {"type": "number"},
    bool: {"type": "boolean"},
    list: {"type": "array"},
    dict: {"type": "object"},
}


def _to_json_schema(schema: Any) -> dict:
    """Convert a user-supplied output schema into a JSON Schema dict.

    Accepts:
      - dict: assumed to already be a JSON Schema, returned as-is.
      - Python primitive type (str/int/float/bool/list/dict): mapped directly.
      - Pydantic BaseModel subclass: uses model_json_schema().
      - Any other type usable by pydantic.TypeAdapter (e.g. list[int]): uses TypeAdapter.
    """
    if isinstance(schema, dict):
        return schema
    if isinstance(schema, type) and schema in _PRIMITIVE_JSON_SCHEMAS:
        return _PRIMITIVE_JSON_SCHEMAS[schema]
    try:
        from pydantic import BaseModel, TypeAdapter
    except ImportError as e:
        raise TypeError(
            "output_schema must be a JSON Schema dict, a primitive type "
            "(str/int/float/bool/list/dict), or a pydantic type. "
            "Install pydantic to use Pydantic models or generic types."
        ) from e
    if isinstance(schema, type) and issubclass(schema, BaseModel):
        return schema.model_json_schema()
    return TypeAdapter(schema).json_schema()


@dataclass
class RLMConfig:
    """Configuration for fast-rlm."""

    # primary_agent is REQUIRED — there is no default. run() raises if it is unset.
    # sub_agent is optional; when unset it falls back to primary_agent.
    primary_agent: Optional[str] = None
    sub_agent: Optional[str] = None
    max_depth: int = 3
    max_calls_per_subagent: int = 20
    truncate_len: int = 2000
    max_money_spent: float = 0.2
    max_completion_tokens: int = 50000
    max_prompt_tokens: int = 200000
    # Global cap on the TOTAL number of LLM calls across the whole run (root +
    # all sub-agents, every backend). None = unlimited. Once reached, no new
    # calls are made and the run stops. The only budget that bites for ACP,
    # where token/cost usage is always zero — set it for any ACP run.
    max_global_calls: Optional[int] = None
    api_max_retries: int = 3
    api_timeout_ms: int = 600000
    # Ablation toggles. When False, the capability is removed from the agent's
    # REPL AND stripped from its system prompt (root + all sub-agents):
    #   enable_tools           -> user-defined Python tools + llm_query(tools=...)
    #   enable_structured_io   -> output_schema validation, llm_query(schema=...),
    #                             and dict/list inputs (shown to the agent as str)
    enable_tools: bool = True
    enable_structured_io: bool = True
    # Compression guard: when an agent delegates a large, barely-compressed
    # context to a subagent, make it self-confirm (same model, same system
    # prompt) before the call runs; NO blocks and forces a compress + retry.
    enable_compression_guard: bool = True
    compression_min_chars: int = 5000
    compression_ratio: float = 0.6
    # ACP backdoor: register non-preset Agent Client Protocol agents by command,
    # then select one via primary_agent/sub_agent="acp:<name>". Built-in presets
    # (acp:claude-code, acp:codex, acp:opencode) need no entry here. Example:
    #   acp_agents={"hermes": {"command": "hermes", "args": ["acp"]}}
    # Each value: {command, args?, readonly_mode?, model?, env?}.
    acp_agents: Optional[dict] = None

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


def _extract_tool_source(tool: Callable) -> str:
    if not callable(tool):
        raise TypeError(
            f"tools must be callables, got {type(tool).__name__}"
        )
    try:
        src = inspect.getsource(tool)
    except (OSError, TypeError) as e:
        raise TypeError(
            f"Could not extract source for tool {getattr(tool, '__name__', tool)!r}. "
            f"Tools must be regular Python functions defined in a source file "
            f"(not lambdas, builtins, or REPL-defined). ({e})"
        ) from e
    return textwrap.dedent(src)


def _string_path_note(ext: str) -> str:
    """Note appended to the instruction for raw-text inputs, telling the model
    what kind of file it is so it can parse it itself (csv/xml/toml/... are all
    in the REPL's Python 3.13 stdlib; pandas and PyYAML are not)."""
    label = f"a `.{ext}` file" if ext else "a file"
    return (
        f"The input context is the raw text of {label}. pandas is NOT available "
        f"in the REPL — use the Python standard library to parse it if needed "
        f"(e.g. `csv` for CSV/TSV, `xml.etree.ElementTree` for XML, `tomllib` for TOML)."
    )


def _load_input_file(path: str):
    """Load an input file by extension. Returns (value, ext).

    Structured formats are parsed host-side into a Python object:
      .json            -> dict / list / scalar
      .jsonl / .ndjson -> list[dict] (one object per line)
      .yaml / .yml     -> dict / list  (the REPL has no `yaml`, so we parse here)

    Everything else is passed as raw text; the model parses it itself using the
    extension (returned as `ext`) as the hint. This scales to large files and
    lets the model slice instead of us dumping a parsed structure.
    """
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    if ext == "json":
        with open(path) as f:
            return json.load(f), ext
    if ext in ("jsonl", "ndjson"):
        with open(path) as f:
            return [json.loads(line) for line in f if line.strip()], ext
    if ext in ("yaml", "yml"):
        with open(path) as f:
            return yaml.safe_load(f), ext
    with open(path) as f:
        return f.read(), ext


def run(
    query: "str | dict | list | None" = None,
    prefix: Optional[str] = None,
    config: Optional[RLMConfig | dict] = None,
    verbose: bool = True,
    output_schema: Optional[Any] = None,
    tools: Optional[list[Callable]] = None,
    env_variables: Optional[dict[str, str]] = None,
    mcp_servers: Optional[dict[str, dict]] = None,
    llm_kwargs: Optional[dict] = None,
    vertex: bool = False,
    instruction: Optional[str] = None,
    input_file: Optional[str] = None,
) -> dict:
    """Run a fast-rlm query.

    Args:
        query: The question / context to process. A string, a JSON-serializable
            dict, or a list — when a dict/list, the agent receives `context` as a
            real Python object and the initial probe prints its top-level schema.
            Optional when `input_file` is given (provide exactly one of the two).
        prefix: Optional log filename prefix.
        config: RLMConfig object or dict of overrides (e.g. primary_agent, max_depth).
            `primary_agent` is REQUIRED and has no default — run() raises a
            ValueError if it is unset. `sub_agent` is optional and falls back to
            `primary_agent` when omitted.
        verbose: If True, stream deno stdout/stderr to terminal.
        env_variables: Optional dict of string KV pairs injected as
            `os.environ` entries inside every Pyodide REPL spawned by this
            run (root and all sub-agents). They are NOT set on the Deno host
            process and never leak outside Pyodide. Useful for handing API
            keys / configuration to tools without exposing them to the model.
        mcp_servers: Optional dict of MCP servers to connect for this run, keyed
            by name. Each value is either a stdio config
            ``{"command": str, "args": [str], "env": {str: str}}`` or an HTTP
            config ``{"url": str, "headers": {str: str}}``. The root agent sees
            all configured servers and can call their tools inside the REPL via
            ``await mcp_call(server, tool, **kwargs)``. Sub-agents inherit none
            by default — grant them per server via ``llm_query(..., mcp=[name])``.
            Configuring any stdio server grants the Deno host ``--allow-run``.
        tools: Optional list of Python callables exposed to the root agent.
            Each function's source is extracted via `inspect.getsource` and
            executed inside the agent's Pyodide REPL before initialization.
            Tools must be self-contained — do internal imports, and do not
            close over module-level variables. Sub-agents do NOT inherit
            these tools; the parent agent must explicitly pass them via
            `llm_query(query, tools=[...])` (or define new ones in its REPL).
        llm_kwargs: Optional dict of extra parameters spread into every LLM
            chat-completion call (root + all sub-agents), e.g.
            ``{"temperature": 0.1, "top_p": 0.9, "seed": 7}``. Passed through
            untouched to the OpenAI-compatible ``chat.completions.create`` call.
        output_schema: Optional schema the root agent's FINAL value must satisfy.
            Accepts a Pydantic model class, a primitive Python type (str/int/
            float/bool/list/dict), a `pydantic.TypeAdapter`-compatible type, or
            a raw JSON Schema dict. Validation runs after FINAL is set; on
            failure the agent receives the schema + errors and may retry within
            its remaining call budget.
        instruction: Optional custom directive appended to the end of the system
            prompt of every agent (root + all sub-agents, plus delegation-
            confirmation calls). When provided, a section of the form
            ``Here is the user's instructions - you must follow it closely:\n
            {instruction}`` is added. When None, nothing is appended.
        input_file: Optional path to a file used as the query instead of `query`
            (pass one or the other, not both). Loaded by extension:
            `.json`/`.yaml`/`.yml` -> dict/list, `.jsonl`/`.ndjson` -> list[dict],
            anything else -> raw text the model parses itself (the extension is
            noted in the instruction so it knows the format). When the loaded
            value is a dict with no ``instruction`` key, `instruction` is injected
            into it.

    Returns:
        Dict with 'results', 'usage', and optionally 'log_file'.
    """
    _check_deno()
    engine_dir = _find_engine_dir()

    # Resolve input_file into the query (so the CLI can be a thin shim). This is
    # the file-type contract above; raw-text inputs also get an extension note
    # appended to the instruction so the model knows how to parse them.
    if input_file is not None:
        if query is not None:
            raise ValueError("Pass either `query` or `input_file`, not both.")
        query, _ext = _load_input_file(input_file)
        if isinstance(query, dict) and instruction and "instruction" not in query:
            query["instruction"] = instruction
        if isinstance(query, str):
            _note = _string_path_note(_ext)
            instruction = f"{instruction}\n\n{_note}" if instruction else _note
    if query is None:
        raise ValueError("Provide either `query` or `input_file`.")

    # RLMConfig merge + validation (done early, before any temp files are created):
    # load yaml defaults, overlay user overrides, REQUIRE primary_agent, and default
    # sub_agent to primary_agent when it is unset.
    if isinstance(config, RLMConfig):
        cfg_dict = asdict(config)
    else:
        cfg_dict = dict(config) if config else {}

    default_config_path = engine_dir / "rlm_config.yaml"
    _defaults = {}
    if default_config_path.exists():
        with open(default_config_path) as f:
            _defaults = yaml.safe_load(f) or {}
    merged_config = {**_defaults, **cfg_dict}
    if instruction is not None:
        merged_config["instruction"] = instruction

    if not merged_config.get("primary_agent"):
        raise ValueError(
            "primary_agent is required and has no default. Set it explicitly, e.g. "
            "run(query, config=RLMConfig(primary_agent='z-ai/glm-5')) or "
            "config={'primary_agent': '...'}."
        )
    if not merged_config.get("sub_agent"):
        merged_config["sub_agent"] = merged_config["primary_agent"]

    output_file = tempfile.mktemp(suffix=".json")
    log_dir = os.path.join(os.getcwd(), "logs")

    cmd = _deno_prefix_cmd() + [
        "run",
        "--allow-read",
        "--allow-env",
        "--allow-net",
        "--allow-sys=hostname,osRelease",
        "--allow-write",
    ]

    # Vertex AI ADC via gcloud CLI needs subprocess permission
    if vertex:
        cmd.append("--allow-run=gcloud")

    # ACP agents are spawned as child processes (e.g. npx/opencode), so the Deno
    # host needs --allow-run when either agent is an "acp:" model.
    _agents = [merged_config.get("primary_agent") or "", merged_config.get("sub_agent") or ""]
    if any(a.startswith("acp:") for a in _agents):
        cmd.append("--allow-run")

    cmd += [
        "src/subagents.ts",
        "--log-dir",
        log_dir,
        "--output",
        output_file,
        "--input-json",
    ]

    if prefix:
        cmd += ["--prefix", prefix]

    if not isinstance(query, (str, dict, list)):
        raise TypeError(
            f"query must be a str, dict, or list, got {type(query).__name__}"
        )
    stdin_payload = json.dumps(query)

    env_tmpfile = None
    if env_variables:
        if not isinstance(env_variables, dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in env_variables.items()
        ):
            raise TypeError("env_variables must be a dict[str, str]")
        env_tmpfile = tempfile.mktemp(suffix=".env.json")
        with open(env_tmpfile, "w") as f:
            json.dump(env_variables, f)
        cmd += ["--env-file", env_tmpfile]

    tools_tmpfile = None
    if tools:
        tool_sources = [_extract_tool_source(t) for t in tools]
        tools_tmpfile = tempfile.mktemp(suffix=".tools.json")
        with open(tools_tmpfile, "w") as f:
            json.dump(tool_sources, f)
        cmd += ["--tools-file", tools_tmpfile]

    schema_tmpfile = None
    if output_schema is not None:
        schema_dict = _to_json_schema(output_schema)
        schema_tmpfile = tempfile.mktemp(suffix=".schema.json")
        with open(schema_tmpfile, "w") as f:
            json.dump(schema_dict, f)
        cmd += ["--output-schema-file", schema_tmpfile]

    mcp_tmpfile = None
    if mcp_servers:
        if not isinstance(mcp_servers, dict) or not all(
            isinstance(k, str) and isinstance(v, dict) for k, v in mcp_servers.items()
        ):
            raise TypeError("mcp_servers must be a dict[str, dict]")
        # stdio servers (no 'url') require Deno to spawn subprocesses.
        if any("url" not in cfg for cfg in mcp_servers.values()):
            cmd.insert(cmd.index("src/subagents.ts"), "--allow-run")
        mcp_tmpfile = tempfile.mktemp(suffix=".mcp.json")
        with open(mcp_tmpfile, "w") as f:
            json.dump(mcp_servers, f)
        cmd += ["--mcp-file", mcp_tmpfile]

    llm_kwargs_tmpfile = None
    if llm_kwargs is not None:
        if not isinstance(llm_kwargs, dict) or not all(
            isinstance(k, str) for k in llm_kwargs
        ):
            raise TypeError("llm_kwargs must be a dict with string keys")
        llm_kwargs_tmpfile = tempfile.mktemp(suffix=".llm_kwargs.json")
        with open(llm_kwargs_tmpfile, "w") as f:
            json.dump(llm_kwargs, f)
        cmd += ["--llm-kwargs-file", llm_kwargs_tmpfile]

    # Write the merged+validated config (always present — primary_agent is required)
    # to a temp file and hand it to the engine.
    config_tmpfile = tempfile.mktemp(suffix=".yaml")
    with open(config_tmpfile, "w") as f:
        yaml.dump(merged_config, f)
    cmd += ["--config", config_tmpfile]

    # Vertex AI: signal the Deno engine to use ADC auth
    run_env = None
    if vertex:
        run_env = {**os.environ, "RLM_VERTEX_AI": "1"}

    try:
        result = subprocess.run(
            cmd,
            input=stdin_payload,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(engine_dir),
            env=run_env,
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
        if schema_tmpfile and os.path.exists(schema_tmpfile):
            os.unlink(schema_tmpfile)
        if tools_tmpfile and os.path.exists(tools_tmpfile):
            os.unlink(tools_tmpfile)
        if env_tmpfile and os.path.exists(env_tmpfile):
            os.unlink(env_tmpfile)
        if mcp_tmpfile and os.path.exists(mcp_tmpfile):
            os.unlink(mcp_tmpfile)
        if llm_kwargs_tmpfile and os.path.exists(llm_kwargs_tmpfile):
            os.unlink(llm_kwargs_tmpfile)

    if "error" in data:
        raise RuntimeError(f"fast-rlm subagent failed: {data['error']}")

    return data
