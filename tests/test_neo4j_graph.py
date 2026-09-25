import json
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest
import networkx as nx

import fast_rlm
import fast_rlm._runner as runner
from fast_rlm._graph import encode_neo4j_graph


def neo4j_graph(**overrides):
    values = {
        "uri": "neo4j://localhost:7687",
        "username": "neo4j",
        "password": "private-password",
        "schema": "(:Entity {name})-[:RELATED]->(:Entity)",
        "database": "neo4j",
    }
    values.update(overrides)
    return fast_rlm.Neo4jGraph(**values)


@pytest.mark.parametrize("field", ["uri", "username", "password", "schema", "database"])
def test_neo4j_graph_requires_non_empty_strings(field):
    with pytest.raises(ValueError, match=f"{field} must be a non-empty string"):
        neo4j_graph(**{field: "  "})


def test_neo4j_graph_is_keyword_only_and_hides_password():
    with pytest.raises(TypeError):
        fast_rlm.Neo4jGraph("uri", "user", "password", "schema")
    graph = neo4j_graph()
    assert "private-password" not in repr(graph)
    assert encode_neo4j_graph(graph)["password"] == "private-password"


def test_cypher_config_defaults():
    config = fast_rlm.RLMConfig(primary_agent="test-model")
    assert config.max_cypher_queries == 5
    assert config.max_cypher_rows == 100
    assert config.cypher_timeout_ms == 15000
    assert config.max_neo4j_observation_bytes == 8192
    assert config.max_neo4j_transcript_bytes == 10240
    assert config.max_neo4j_query_artifact_bytes == 1048576
    assert config.max_neo4j_evidence_bytes == 5242880
    assert config.enable_toon_output is True
    assert fast_rlm.RLMConfig.default().enable_toon_output is True


@pytest.mark.parametrize("value", [0, 1, "true", None])
def test_run_rejects_non_boolean_toon_output(value):
    with pytest.raises(ValueError, match="enable_toon_output must be a boolean"):
        fast_rlm.run(
            "question",
            graph=neo4j_graph(),
            config={"primary_agent": "test-model", "enable_toon_output": value},
        )


def test_run_transports_explicit_false_toon_output(monkeypatch, tmp_path):
    observed = {}

    def fake_run(command, **_kwargs):
        config_path = Path(command[command.index("--config") + 1])
        observed["config"] = config_path.read_text()
        output_path = Path(command[command.index("--output") + 1])
        output_path.write_text(json.dumps({"results": "ok", "usage": {}, "log_file": None}))
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(runner.subprocess, "run", fake_run)
    result = fast_rlm.run(
        "question",
        graph=neo4j_graph(),
        config={"primary_agent": "test-model", "enable_toon_output": False},
        log_dir=str(tmp_path),
        verbosity="silent",
    )

    assert result["results"] == "ok"
    assert "enable_toon_output: false" in observed["config"]


@pytest.mark.parametrize(
    "name,value",
    [
        ("max_cypher_queries", 0),
        ("max_cypher_rows", -1),
        ("cypher_timeout_ms", 1.5),
        ("max_cypher_queries", True),
    ],
)
def test_run_rejects_invalid_cypher_limits(name, value):
    with pytest.raises(ValueError, match=f"{name} must be a positive integer"):
        fast_rlm.run(
            "question",
            graph=neo4j_graph(),
            config={"primary_agent": "test-model", name: value},
        )


def test_run_passes_neo4j_source_in_private_temporary_file(monkeypatch, tmp_path):
    observed = {}

    def fake_run(command, **_kwargs):
        neo4j_path = Path(command[command.index("--neo4j-file") + 1])
        output_path = Path(command[command.index("--output") + 1])
        observed["path"] = neo4j_path
        observed["payload"] = json.loads(neo4j_path.read_text())
        observed["mode"] = stat.S_IMODE(neo4j_path.stat().st_mode)
        observed["command"] = command
        config_path = Path(command[command.index("--config") + 1])
        observed["config"] = config_path.read_text()
        output_path.write_text(json.dumps({"results": "ok", "usage": {}, "log_file": None}))
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(runner.subprocess, "run", fake_run)
    result = fast_rlm.run(
        "question",
        graph=neo4j_graph(),
        config={"primary_agent": "test-model"},
        log_dir=str(tmp_path),
        verbosity="silent",
    )

    assert result["results"] == "ok"
    assert observed["mode"] == 0o600
    assert observed["payload"]["backend"] == "neo4j"
    assert observed["payload"]["schema"].startswith("(:Entity")
    assert "private-password" not in observed["command"]
    assert "enable_toon_output: true" in observed["config"]
    assert "--graph-file" not in observed["command"]
    assert not observed["path"].exists()


def test_neo4j_temporary_file_is_cleaned_up_when_engine_fails(monkeypatch, tmp_path):
    observed = {}

    def fake_run(command, **_kwargs):
        observed["path"] = Path(command[command.index("--neo4j-file") + 1])
        raise RuntimeError("engine failed")

    monkeypatch.setattr(runner.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError, match="engine failed"):
        fast_rlm.run(
            "question",
            graph=neo4j_graph(),
            config={"primary_agent": "test-model"},
            log_dir=str(tmp_path),
            verbosity="silent",
        )

    assert not observed["path"].exists()


def test_existing_networkx_input_still_uses_graph_file(monkeypatch, tmp_path):
    observed = {}

    def fake_run(command, **_kwargs):
        graph_path = Path(command[command.index("--graph-file") + 1])
        output_path = Path(command[command.index("--output") + 1])
        observed["path"] = graph_path
        observed["artifact"] = json.loads(graph_path.read_text())
        observed["command"] = command
        output_path.write_text(json.dumps({"results": "ok", "usage": {}, "log_file": None}))
        return SimpleNamespace(returncode=0, stderr="")

    graph = nx.MultiDiGraph()
    graph.add_edge("Jamaica", "Jamaican English", relation="language")
    monkeypatch.setattr(runner.subprocess, "run", fake_run)
    result = fast_rlm.run(
        "question",
        graph=graph,
        config={"primary_agent": "test-model"},
        log_dir=str(tmp_path),
        verbosity="silent",
    )

    assert result["results"] == "ok"
    assert observed["artifact"]["graph_type"] == "MultiDiGraph"
    assert observed["artifact"]["edges"][0]["attributes"]["relation"] == "language"
    assert "--neo4j-file" not in observed["command"]
    assert not observed["path"].exists()
