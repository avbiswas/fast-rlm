import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { loadPyodide } from "pyodide";
import {
  GRAPH_RUNTIME_PY,
  graphFinalSetup,
  NEO4J_CYPHER_PY,
  NEO4J_INSPECTION_PY,
} from "../src/graph.ts";

const pyodide = await loadPyodide();
await pyodide.loadPackage("micropip");
await pyodide.runPythonAsync(`
import micropip
await micropip.install("networkx")
`);
await pyodide.runPythonAsync(GRAPH_RUNTIME_PY);
await pyodide.runPythonAsync(NEO4J_INSPECTION_PY);
await pyodide.runPythonAsync(NEO4J_CYPHER_PY);

Deno.test("Neo4j entity helpers build prefix search and rerank Ben Franklin", async () => {
  const result = await pyodide.runPythonAsync(`
import json

candidate_graph = nx.MultiDiGraph()
candidate_graph.add_node(
    "candidate-1",
    properties={"key": "person-1", "name": "Benjamin Franklin"},
)
candidate_graph.add_node(
    "candidate-2",
    properties={"key": "person-2", "name": "Ben Stiller"},
)
candidate_graph.graph["records"] = [
    {"node": {"node": "candidate-1"}, "score": 4.0},
    {"node": {"node": "candidate-2"}, "score": 2.0},
]

relation_graph = nx.MultiDiGraph()
relation_graph.add_node(
    "relation-candidate",
    properties={"key": "person-1", "name": "Benjamin Franklin"},
)
relation_graph.add_node(
    "answer",
    properties={"key": "answer-1", "name": "Bifocals"},
)
relation_graph.add_edge(
    "relation-candidate",
    "answer",
    key="related-1",
    relation="RELATED",
    properties={"predicate": "people.person.inventions"},
)

selected = find_neo4j_entity_seeds(
    candidate_graph,
    relation_graph,
    ["Ben Franklin"],
    ["invent"],
    min_confidence=0.75,
)
json.dumps({
    "query": build_fulltext_entity_query("Ben Franklin"),
    "queries": build_fulltext_entity_queries("Jamaican people"),
    "selected": selected,
    "source": __graph_runtime_seed_source__,
    "seeds": __graph_runtime_seeds__,
})
`);
  const parsed = JSON.parse(String(result));
  assertEquals(parsed.query, "ben* AND franklin*");
  assertEquals(parsed.queries, ["jamaican* AND people*", "jamaican~1"]);
  assertEquals(parsed.selected.length, 1);
  assertEquals(parsed.selected[0].key, "person-1");
  assertEquals(parsed.selected[0].name, "Benjamin Franklin");
  assertEquals(parsed.source, "neo4j_fulltext");
  assertEquals(parsed.seeds, ["Benjamin Franklin"]);
});

Deno.test("Neo4j fallback reranking matches Jamaican people to Jamaica", async () => {
  const result = await pyodide.runPythonAsync(`
import json
candidate_graph = nx.MultiDiGraph()
candidate_graph.add_node(
    "jamaica-node",
    properties={"key": "jamaica-key", "name": "Jamaica"},
)
candidate_graph.graph["records"] = [
    {"node": {"node": "jamaica-node"}, "score": 5.0},
]
selected = find_neo4j_entity_seeds(
    candidate_graph, nx.MultiDiGraph(), ["Jamaican people"],
    min_confidence=0.75,
)
json.dumps(selected)
`);
  const parsed = JSON.parse(String(result));
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0].name, "Jamaica");
  assertEquals(parsed[0].key, "jamaica-key");
});

Deno.test("Neo4j graph snapshot exposes only compact display fields", async () => {
  const result = await pyodide.runPythonAsync(`
import json
snapshot_graph = nx.MultiDiGraph()
snapshot_graph.add_node(
    "n1", labels=["Entity"],
    properties={"name": "Jamaica", "key": "k1", "kind": "country"},
)
snapshot_graph.add_node("n2", labels=["Entity"], properties={"name": "Jamaican English"})
snapshot_graph.add_edge(
    "n1", "n2", key="r1", relation="RELATED", neo4j_element_id="rel-1",
    properties={"predicate": "language spoken"},
)
snapshot_graph.graph["records"] = [
    {"entity": {"node": "n1"}, "count": 1, "raw": {"secret": "no"}},
    {"edge": {"relationship": "rel-1"}},
]
json.dumps(neo4j_graph_snapshot(
    snapshot_graph, node_limit=1, edge_limit=1, record_limit=1
))
`);
  const parsed = JSON.parse(String(result));
  assertEquals(parsed.total_nodes, 2);
  assertEquals(parsed.shown_nodes, 1);
  assertEquals(parsed.nodes_truncated, true);
  assertEquals(parsed.nodes[0].name, "Jamaica");
  assertEquals(parsed.nodes[0].properties, undefined);
  assertEquals(parsed.edges[0].predicate, "language spoken");
  assertEquals(parsed.edges[0].relationship_id, undefined);
  assertEquals(parsed.records[0].entity_name, "Jamaica");
  assertEquals(parsed.records[0].count, 1);
  assertEquals(parsed.records[0].raw, undefined);
  assertEquals(parsed.records_truncated, false);
});

Deno.test("Neo4j entity helper rejects empty mentions", async () => {
  const result = await pyodide.runPythonAsync(`
error_message = None
try:
    build_fulltext_entity_query(" -- ")
except ValueError as error:
    error_message = str(error)
error_message
`);
  assertEquals(String(result), "entity mention must contain at least one word");
});

Deno.test("automatic Neo4j projection omits internal identifiers and bounds bytes", async () => {
  const result = await pyodide.runPythonAsync(`
import json
_graph = nx.MultiDiGraph()
_graph.add_node("internal-a", properties={"name": "Jamaica", "key": "jamaica-key", "secret": "no"})
_graph.add_node("internal-b", properties={"name": "Jamaican English", "key": "english-key"})
_graph.add_edge("internal-a", "internal-b", key="rel-internal", properties={"predicate": "language"}, relation="RELATED")
__neo4j_observation_bytes__ = 80
_projection = __neo4j_graph_for_print__(_graph)
_output = json.dumps(_projection)
json.dumps({"output": _output, "truncated": _projection.get("projection_bytes_truncated", False)})
`);
  const parsed = JSON.parse(String(result));
  assertEquals(parsed.output.includes("internal-a"), false);
  assertEquals(parsed.output.includes("secret"), false);
  assertEquals(parsed.truncated, true);
});

Deno.test("Neo4j GRAPH_FINAL canonicalizes evidence and rejects fabricated edges", async () => {
  await pyodide.runPythonAsync(graphFinalSetup(true, 4, true));
  const result = await pyodide.runPythonAsync(`
import json
evidence_graph.clear()
evidence_graph.graph.update({"source_backend": "neo4j", "records": [{"count": 3}], "truncated": False})
evidence_graph.add_node("seed", properties={"key": "seed-key", "name": "Seed"})
evidence_graph.add_node("answer", properties={"key": "answer-key", "name": "Answer"})
evidence_graph.add_edge("seed", "answer", key="rel-1", properties={"predicate": "answers"}, relation="RELATED")
_answer = nx.MultiDiGraph()
_answer.add_node("seed", forged=True)
_answer.add_node("answer")
_answer.add_edge("seed", "answer", key="rel-1", forged=True)
_answer.graph["facts"] = [{"name": "count", "value": 3}]
GRAPH_FINAL(_answer)
_artifact = __graph_final_result__
_forged = None
try:
    _bad = nx.MultiDiGraph()
    _bad.add_node("seed")
    _bad.add_node("answer")
    _bad.add_edge("seed", "answer", key="fake")
    GRAPH_FINAL(_bad)
except ValueError as _error:
    _forged = str(_error)
_bad_fact = None
try:
    _wrong_fact = nx.MultiDiGraph()
    _wrong_fact.graph["facts"] = [{"name": "count", "value": 4}]
    GRAPH_FINAL(_wrong_fact)
except ValueError as _error:
    _bad_fact = str(_error)
json.dumps({
    "attrs": _artifact["edges"][0]["attributes"],
    "facts": _artifact["attributes"]["facts"],
    "forged": _forged,
    "bad_fact": _bad_fact,
})
`);
  const parsed = JSON.parse(String(result));
  assertEquals(parsed.attrs.forged, undefined);
  assertEquals(parsed.attrs.relation, "RELATED");
  assertEquals(parsed.facts, [{ name: "count", value: 3 }]);
  assertEquals(parsed.forged, "final_graph_rejected: unknown_edge");
  assertEquals(parsed.bad_fact, "final_graph_rejected: facts");
});

Deno.test("full-text reads automatically record considered seed names", async () => {
  const result = await pyodide.runPythonAsync(`
__graph_runtime_seed_candidates__ = []
__graph_runtime_candidate_count__ = 0
__neo4j_seed_names_seen__.clear()

async def __js_execute_read_only_cypher__(query, parameters, limit):
    return {"budget": {"attempts_used": 1, "attempts_remaining": 4}, "artifact": {
        "version": 1,
        "backend": "networkx",
        "graph_type": "MultiDiGraph",
        "attributes": {
            "records": [{"name": "Jamaica"}, {"name": "Jamaican Senate"}],
            "truncated": False,
        },
        "nodes": [],
        "edges": [],
    }}

await execute_read_only_cypher(
    "CALL db.index.fulltext.queryNodes('entities', $entity_query) "
    "YIELD node RETURN node"
)
json.dumps({
    "count": __graph_runtime_candidate_count__,
    "candidates": __graph_runtime_seed_candidates__,
})
`);
  const parsed = JSON.parse(String(result));
  assertEquals(parsed.count, 2);
  assertEquals(
    parsed.candidates.map((candidate: { name: string }) => candidate.name),
    ["Jamaica", "Jamaican Senate"],
  );
});

Deno.test("Cypher reads accumulate while returning individual graphs", async () => {
  const result = await pyodide.runPythonAsync(`
import json
import contextlib
import io
evidence_graph.clear()
evidence_graph.graph.update({"records": [], "truncated": False})
_responses = iter([
    {"budget": {"attempts_used": 1, "attempts_remaining": 4}, "artifact": {
        "version": 1, "backend": "networkx", "graph_type": "MultiDiGraph",
        "attributes": {"records": [{"value": "first-secret"}], "truncated": False},
        "nodes": [
            {"id": "shared", "attributes": {"properties": {"name": "Concrete Name"}}},
            {"id": "answer", "attributes": {}},
        ],
        "edges": [{"source": "shared", "target": "answer", "key": "rel-1", "attributes": {}}],
    }},
    {"budget": {"attempts_used": 2, "attempts_remaining": 3}, "artifact": {
        "version": 1, "backend": "networkx", "graph_type": "MultiDiGraph",
        "attributes": {"records": [{"value": "second-secret"}], "truncated": True},
        "nodes": [{"id": "shared", "attributes": {"placeholder": True}}],
        "edges": [{"source": "shared", "target": "answer", "key": "rel-1", "attributes": {}}],
    }},
])
async def __js_execute_read_only_cypher__(query, parameters, limit):
    return next(_responses)
_output = io.StringIO()
with contextlib.redirect_stdout(_output):
    first = await execute_read_only_cypher("RETURN 1")
    second = await execute_read_only_cypher("RETURN 2")
json.dumps({
    "first_nodes": sorted(first.nodes),
    "second_nodes": sorted(second.nodes),
    "accumulated_nodes": sorted(evidence_graph.nodes),
    "accumulated_edges": evidence_graph.number_of_edges(),
    "shared": dict(evidence_graph.nodes["shared"]),
    "records": evidence_graph.graph["records"],
    "truncated": evidence_graph.graph["truncated"],
    "receipt": _output.getvalue(),
})
`);
  const parsed = JSON.parse(String(result));
  assertEquals(parsed.first_nodes, ["answer", "shared"]);
  assertEquals(parsed.second_nodes, ["answer", "shared"]);
  assertEquals(parsed.accumulated_nodes, ["answer", "shared"]);
  assertEquals(parsed.accumulated_edges, 1);
  assertEquals(parsed.shared.properties.name, "Concrete Name");
  assertEquals(parsed.records, [
    { value: "first-secret" }, { value: "second-secret" },
  ]);
  assertEquals(parsed.truncated, true);
  assertEquals(parsed.receipt.includes("first-secret"), false);
  assertEquals(parsed.receipt.includes("Concrete Name"), false);
  assertEquals(parsed.receipt.includes("result rows=1"), true);
  assertEquals(parsed.receipt.includes("accumulated rows=2"), true);
  assertEquals(parsed.receipt.includes("attempts used=2, remaining=3"), true);
});

Deno.test("failed Cypher reads leave accumulated evidence unchanged", async () => {
  const result = await pyodide.runPythonAsync(`
import json
before = (evidence_graph.number_of_nodes(), evidence_graph.number_of_edges(), list(evidence_graph.graph["records"]))
async def __js_execute_read_only_cypher__(query, parameters, limit):
    raise RuntimeError("database failure")
try:
    await execute_read_only_cypher("RETURN 3")
except RuntimeError:
    pass
after = (evidence_graph.number_of_nodes(), evidence_graph.number_of_edges(), list(evidence_graph.graph["records"]))
json.dumps({"unchanged": before == after})
`);
  assertEquals(JSON.parse(String(result)), { unchanged: true });
});
