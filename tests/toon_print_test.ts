import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { loadPyodide } from "pyodide";
import { NEO4J_INSPECTION_PY, TOON_PRINT_PY } from "../src/graph.ts";

const pyodide = await loadPyodide();
await pyodide.loadPackage("micropip");
await pyodide.runPythonAsync(`
import micropip
await micropip.install(["networkx", "toon-format==0.9.0b1"])
`);
await pyodide.runPythonAsync(TOON_PRINT_PY);
await pyodide.runPythonAsync(NEO4J_INSPECTION_PY);

async function runJson(code: string): Promise<unknown> {
  const result = await pyodide.runPythonAsync(code);
  return JSON.parse(String(result));
}

Deno.test("TOON printer preserves scalar print semantics and encodes records", async () => {
  const result = await runJson(`
import contextlib
import io
import json
from toon_format import decode

_output = io.StringIO()
print(
    "records",
    [{"id": 1, "name": "Ada"}, {"id": 2, "name": "Bob"}],
    sep="|",
    end="!",
    file=_output,
    flush=True,
)
_text = _output.getvalue()
_toon = _text[len("records|"):-1]
json.dumps({"text": _text, "decoded": decode(_toon)})
`);
  assertEquals(result, {
    text: "records|[2]{id,name}:\n  1,Ada\n  2,Bob!",
    decoded: [{ id: 1, name: "Ada" }, { id: 2, name: "Bob" }],
  });
});

Deno.test("Neo4j print detects derived graphs beyond their first element", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import networkx as nx
from toon_format import decode
_graph = nx.MultiDiGraph()
_graph.add_node("plain", properties={"name": "plain"})
_graph.add_node("internal", neo4j_element_id="internal", properties={"name": "Jamaica", "key": "jamaica-key"})
_output = io.StringIO()
with contextlib.redirect_stdout(_output):
    print(_graph)
_decoded = decode(_output.getvalue())
json.dumps({
    "name": _decoded["nodes"][1]["name"],
    "contains_internal_id": "internal" in _output.getvalue(),
})
`);
  assertEquals(result, { name: "Jamaica", contains_internal_id: false });
});

Deno.test("Neo4j graph projection supports JSON when TOON is disabled", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import networkx as nx
__graph_print_encoding__ = "json"
_graph = nx.MultiDiGraph()
_graph.add_node("internal", neo4j_element_id="internal", properties={"name": "Jamaica", "key": "jamaica-key"})
_output = io.StringIO()
with contextlib.redirect_stdout(_output):
    print(_graph)
__graph_print_encoding__ = "toon"
_decoded = json.loads(_output.getvalue())
json.dumps({"name": _decoded["nodes"][0]["name"], "has_id": "id" in _decoded["nodes"][0]})
`);
  assertEquals(result, { name: "Jamaica", has_id: false });
});

Deno.test("Neo4j graphs print compact TOON directly", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import networkx as nx
from toon_format import decode

_graph = nx.MultiDiGraph()
_graph.graph["source_backend"] = "neo4j"
_graph.add_node(
    "n1", labels=["Entity"], neo4j_element_id="n1",
    properties={"name": "Jamaican English", "key": "k1"},
)
_graph.add_node(
    "n2", labels=["Entity"], neo4j_element_id="n2",
    properties={"name": "Jamaica", "key": "k2"},
)
_graph.add_edge(
    "n1", "n2", key="r1", neo4j_element_id="r1", relation="RELATED",
    properties={"predicate": "language.human_language.countries_spoken_in"},
)
_graph.graph["records"] = [
    {"entity": {"node": "n1"}, "score": 1.0},
    {"entity": {"node": "n1"}},
]
_output = io.StringIO()
with contextlib.redirect_stdout(_output):
    print(_graph)
_decoded = decode(_output.getvalue())
json.dumps({
    "name": _decoded["nodes"][0]["name"],
    "key": _decoded["nodes"][0]["key"],
    "record_name": _decoded["records"][0]["entity_name"],
    "record_key": _decoded["records"][0]["entity_key"],
    "source_name": _decoded["edges"][0]["source_name"],
    "target_name": _decoded["edges"][0]["target_name"],
    "has_source_id": "source" in _decoded["edges"][0],
    "omitted_reference_records": _decoded["omitted_reference_records"],
    "records_truncated": _decoded["records_truncated"],
    "has_id": "id" in _decoded["nodes"][0],
    "has_properties": "properties" in _decoded["nodes"][0],
})
`);
  assertEquals(result, {
    name: "Jamaican English",
    key: "k1",
    record_name: "Jamaican English",
    record_key: "k1",
    source_name: "Jamaican English",
    target_name: "Jamaica",
    has_source_id: false,
    omitted_reference_records: 1,
    records_truncated: false,
    has_id: false,
    has_properties: false,
  });
});

Deno.test("Neo4j graph printing remains compact inside collections", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import networkx as nx
from toon_format import decode

_graph = nx.MultiDiGraph()
_graph.add_node(
    "internal-id", neo4j_element_id="internal-id",
    properties={"name": "Jamaica", "key": "k1"},
)
_output = io.StringIO()
with contextlib.redirect_stdout(_output):
    print([_graph])
_decoded = decode(_output.getvalue())
json.dumps({
    "name": _decoded[0]["nodes"][0]["name"],
    "contains_internal_id": "internal-id" in _output.getvalue(),
})
`);
  assertEquals(result, { name: "Jamaica", contains_internal_id: false });
});

Deno.test("TOON printer bounds MultiDiGraph nodes, edges, and records", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import networkx as nx
from toon_format import decode

_graph = nx.MultiDiGraph(source="test")
for _index in range(25):
    _graph.add_node(_index, name=f"node-{_index}")
for _index in range(19):
    _graph.add_edge(_index, _index + 1, key=f"edge-{_index}", relation="NEXT")
_graph.add_edge(0, 2, key="edge-extra", relation="EXTRA")
for _index in range(20, 25):
    _graph.add_edge(_index, (_index + 1) % 25, key=f"edge-{_index}", relation="HIDDEN")
_graph.graph["records"] = [{"value": _index} for _index in range(25)]

_output = io.StringIO()
with contextlib.redirect_stdout(_output):
    print(_graph)
_decoded = decode(_output.getvalue())
json.dumps({
    "graph_type": _decoded["graph_type"],
    "totals": [_decoded["total_nodes"], _decoded["total_edges"], _decoded["total_records"]],
    "shown": [_decoded["shown_nodes"], _decoded["shown_edges"], _decoded["shown_records"]],
    "truncated": [_decoded["nodes_truncated"], _decoded["edges_truncated"], _decoded["records_truncated"]],
    "first_edge_key": _decoded["edges"][0]["key"],
    "attributes": _decoded["graph_attributes"],
    "records_in_attributes": "records" in _decoded["graph_attributes"],
})
`);
  assertEquals(result, {
    graph_type: "MultiDiGraph",
    totals: [25, 25, 25],
    shown: [20, 20, 20],
    truncated: [true, true, true],
    first_edge_key: "edge-0",
    attributes: { source: "test" },
    records_in_attributes: false,
  });
});

Deno.test("TOON printer bounds NetworkX views and sanitizes cyclic values", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import networkx as nx
from toon_format import decode

_graph = nx.Graph()
_graph.add_nodes_from((_index, {"rank": _index}) for _index in range(25))
_view_output = io.StringIO()
with contextlib.redirect_stdout(_view_output):
    print(_graph.nodes(data=True))
_view = decode(_view_output.getvalue())

_cyclic = []
_cyclic.append(_cyclic)
_cycle_output = io.StringIO()
with contextlib.redirect_stdout(_cycle_output):
    print(_cyclic)

json.dumps({
    "view_type": _view["view_type"],
    "total": _view["total_items"],
    "shown": _view["shown_items"],
    "truncated": _view["truncated"],
    "cycle": _cycle_output.getvalue(),
})
`);
  assertEquals(result, {
    view_type: "NodeDataView",
    total: 25,
    shown: 20,
    truncated: true,
    cycle: "[TOON encoding failed: list]\n",
  });
});

Deno.test("TOON printer supports graph kinds and common NetworkX views", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import networkx as nx
from toon_format import decode

def _printed(_value):
    _output = io.StringIO()
    with contextlib.redirect_stdout(_output):
        print(_value)
    return decode(_output.getvalue())

_graph_types = []
for _class in (nx.Graph, nx.DiGraph, nx.MultiGraph, nx.MultiDiGraph):
    _graph = _class()
    _graph.add_edge("a", "b", relation="LINK")
    _decoded = _printed(_graph)
    _graph_types.append([
        _decoded["graph_type"],
        _decoded["directed"],
        _decoded["multigraph"],
    ])

_view_graph = nx.MultiDiGraph()
_view_graph.add_edge("a", "b", key="rel-1", relation="LINK")
json.dumps({
    "graphs": _graph_types,
    "edges": _printed(_view_graph.edges(keys=True, data=True)),
    "degree": _printed(_view_graph.degree),
    "adjacency": _printed(_view_graph.adj),
})
`);
  const parsed = result as Record<string, unknown>;
  assertEquals(parsed.graphs, [
    ["Graph", false, false],
    ["DiGraph", true, false],
    ["MultiGraph", false, true],
    ["MultiDiGraph", true, true],
  ]);
  assertEquals(
    (parsed.edges as { items: unknown[] }).items[0],
    {
      source: "a",
      target: "b",
      key: "rel-1",
      attributes: { relation: "LINK" },
    },
  );
  assertEquals((parsed.degree as { shown_items: number }).shown_items, 2);
  assertEquals((parsed.adjacency as { shown_items: number }).shown_items, 2);
});

Deno.test("TOON printer normalizes Pydantic-style models and Pyodide proxies", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import sys
import types
from toon_format import decode

_pydantic = types.ModuleType("pydantic")
class _BaseModel:
    pass
_pydantic.BaseModel = _BaseModel
sys.modules["pydantic"] = _pydantic

class _Model(_BaseModel):
    def model_dump(self, mode=None):
        return {"kind": "model", "mode": mode}

class _Proxy:
    def to_py(self):
        return {"kind": "proxy", "values": [1, 2]}

def _printed(_value):
    _output = io.StringIO()
    with contextlib.redirect_stdout(_output):
        print(_value)
    return decode(_output.getvalue())

json.dumps({"model": _printed(_Model()), "proxy": _printed(_Proxy())})
`);
  assertEquals(result, {
    model: { kind: "model", mode: "json" },
    proxy: { kind: "proxy", values: [1, 2] },
  });
});
