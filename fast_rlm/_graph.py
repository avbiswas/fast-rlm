"""NetworkX transport and reusable entity indexing for graph-native RLM runs."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

GRAPH_ARTIFACT_VERSION = 1
_LABEL_FIELDS = ("name", "label", "title", "alias", "aliases")
_LABEL_RELATIONS = {
    "name", "label", "title", "alias", "type_object_name", "common_topic_alias",
}


def normalize_entity_label(value: Any) -> str:
    return re.sub(r"[^\w]+", " ", str(value).casefold()).strip()


def _relation_name(value: Any) -> str:
    return str(value).casefold().replace(".", "_").replace("/", "_").replace(" ", "_")


def _readable(value: Any) -> bool:
    text = str(value)
    return bool(text) and len(text) <= 200 and not text.startswith(("m.", "g.", "/"))


def _values(value: Any) -> list[Any]:
    return list(value) if isinstance(value, (list, tuple, set)) else [value]


def _trigrams(label: str) -> set[str]:
    return {label[index : index + 3] for index in range(max(0, len(label) - 2))}


def build_entity_index(graph: Any) -> dict[str, Any]:
    """Build the compact JSON-compatible exact/trigram entity index once."""
    exact: dict[str, list[Any]] = {}
    trigrams: dict[str, list[Any]] = {}
    node_labels: dict[str, list[str]] = {}

    def add(node: Any, label: Any) -> None:
        normalized = normalize_entity_label(label)
        if not normalized:
            return
        labels = node_labels.setdefault(str(node), [])
        if normalized not in labels:
            labels.append(normalized)
        posting = exact.setdefault(normalized, [])
        if node not in posting:
            posting.append(node)
        for trigram in _trigrams(normalized):
            trigram_posting = trigrams.setdefault(trigram, [])
            if node not in trigram_posting:
                trigram_posting.append(node)

    for node, attributes in graph.nodes(data=True):
        if _readable(node):
            add(node, node)
        for field in _LABEL_FIELDS:
            if field in attributes:
                for value in _values(attributes[field]):
                    add(node, value)

    if graph.is_multigraph():
        edges = graph.edges(keys=True, data=True)
        labelled_edges = (
            (source, target, attributes.get("relation", key))
            for source, target, key, attributes in edges
        )
    else:
        edges = graph.edges(data=True)
        labelled_edges = (
            (source, target, attributes.get("relation", ""))
            for source, target, attributes in edges
        )
    for source, target, relation in labelled_edges:
        if _relation_name(relation) not in _LABEL_RELATIONS:
            continue
        if _readable(target):
            add(source, target)
        if _readable(source):
            add(target, source)

    return {"exact_index": exact, "trigram_index": trigrams, "node_labels": node_labels}


class IndexedGraph:
    """A NetworkX graph paired with its reusable graph-native entity index."""

    def __init__(self, graph: Any, entity_index: dict[str, Any]):
        self.graph = graph
        self.entity_index = entity_index


@dataclass(frozen=True, kw_only=True)
class Neo4jGraph:
    """Connection details for a Neo4j-backed graph-native run."""

    uri: str
    username: str
    password: str = field(repr=False)
    schema: str
    database: str = "neo4j"

    def __post_init__(self) -> None:
        for name in ("uri", "username", "password", "schema", "database"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name} must be a non-empty string")


def encode_neo4j_graph(graph: Neo4jGraph) -> dict[str, Any]:
    """Encode private Neo4j connection details for the Deno host only."""
    return {
        "version": GRAPH_ARTIFACT_VERSION,
        "backend": "neo4j",
        "uri": graph.uri,
        "username": graph.username,
        "password": graph.password,
        "database": graph.database,
        "schema": graph.schema,
    }


def _validate_graph_type(graph: Any) -> None:
    try:
        import networkx as nx
    except ImportError as exc:
        raise ImportError(
            "NetworkX graph support requires the optional 'graph' dependency: "
            "pip install 'fast-rlm[graph]'"
        ) from exc
    if type(graph) not in {nx.Graph, nx.DiGraph, nx.MultiGraph, nx.MultiDiGraph}:
        raise TypeError(
            "graph must be a networkx Graph, DiGraph, MultiGraph, or MultiDiGraph"
        )


def prepare_graph(graph: Any) -> IndexedGraph:
    """Prepare a graph for reuse; repeat after label or alias mutations."""
    _validate_graph_type(graph)
    entity_index = build_entity_index(graph)
    json.dumps(entity_index, allow_nan=False)
    return IndexedGraph(graph, entity_index)


def encode_networkx_graph(graph: Any) -> dict[str, Any]:
    """Encode a raw or prepared NetworkX graph as a graph-channel artifact."""
    indexed = graph if isinstance(graph, IndexedGraph) else None
    graph = indexed.graph if indexed is not None else graph
    _validate_graph_type(graph)
    import networkx as nx
    graph_types = {
        nx.Graph: "Graph", nx.DiGraph: "DiGraph",
        nx.MultiGraph: "MultiGraph", nx.MultiDiGraph: "MultiDiGraph",
    }
    nodes = [{"id": node, "attributes": dict(attributes)}
             for node, attributes in graph.nodes(data=True)]
    if graph.is_multigraph():
        edges = [{"source": source, "target": target, "key": key,
                  "attributes": dict(attributes)}
                 for source, target, key, attributes
                 in graph.edges(keys=True, data=True)]
    else:
        edges = [{"source": source, "target": target,
                  "attributes": dict(attributes)}
                 for source, target, attributes in graph.edges(data=True)]
    artifact = {
        "version": GRAPH_ARTIFACT_VERSION, "backend": "networkx",
        "graph_type": graph_types[type(graph)], "attributes": dict(graph.graph),
        "nodes": nodes, "edges": edges,
    }
    if indexed is not None:
        artifact["entity_index"] = indexed.entity_index
    try:
        encoded = json.dumps(artifact, allow_nan=False)
        if json.loads(encoded) != artifact:
            raise TypeError
    except (TypeError, ValueError) as exc:
        raise TypeError(
            "graph nodes, edge keys, attributes, and entity indexes must be JSON-compatible"
        ) from exc
    return artifact
