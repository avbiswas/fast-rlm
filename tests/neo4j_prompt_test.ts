import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  graphFinalSetup,
  NEO4J_CYPHER_PY,
  NEO4J_GRAPH_QUERY_PY,
  NEO4J_INSPECTION_PY,
} from "../src/graph.ts";
import { buildSystemPrompt } from "../src/prompt.ts";

Deno.test("NetworkX graph prompt retains explicit graph delegation", () => {
  const prompt = buildSystemPrompt(false, {
    graphAvailable: true,
    graphBackend: "networkx",
  });
  assert(prompt.includes("graph_query(context, graph=graph"));
  assert(prompt.includes("rendered as TOON"));
  assert(prompt.includes("limited to 20 nodes, 20 edges"));
  assertEquals(prompt.includes("execute_read_only_cypher"), false);
});

Deno.test("graph prompts omit TOON instructions when output encoding is disabled", () => {
  const prompt = buildSystemPrompt(false, {
    graphAvailable: true,
    graphBackend: "networkx",
    enableToonOutput: false,
  });
  assertEquals(prompt.includes("rendered as TOON"), false);
});

Deno.test("Neo4j prompts expose schema and Cypher only to the graph child", () => {
  const root = buildSystemPrompt(false, {
    graphAvailable: true,
    graphBackend: "neo4j",
  });
  const child = buildSystemPrompt(false, {
    graphAvailable: true,
    graphMode: true,
    graphBackend: "neo4j",
    neo4jSchema: "(:Entity {name})",
    maxCypherQueries: 5,
    maxCypherRows: 100,
  });
  assert(root.includes("graph_query(context, instruction="));
  assertEquals(root.includes("execute_read_only_cypher"), false);
  assert(child.includes("execute_read_only_cypher"));
  assert(child.includes("(:Entity {name})"));
  assert(child.includes("at most 5 database attempts"));
  assert(child.includes("at most 100 rows"));
  assert(child.includes("build_fulltext_entity_query"));
  assert(child.includes("build_fulltext_entity_queries"));
  assert(child.includes("find_neo4j_entity_seeds"));
  assert(child.includes("returns a query-local `nx.MultiDiGraph`"));
  assert(child.includes("print(graph)"));
  assert(child.includes("do not import them from a module"));
  assert(child.includes("Only one validated Cypher database attempt"));
  assert(root.includes("print(subgraph)"));
  assert(root.includes("never compare `u` or `v` with a name"));
  assert(child.includes("globally unique stable `key`"));
  assertEquals(child.includes("neo4j_graph_snapshot"), false);
  assertEquals(root.includes("neo4j_graph_snapshot"), false);
  assert(child.includes("persistent `nx.MultiDiGraph` named `evidence_graph`"));
  assert(child.includes("merges it into `evidence_graph`"));
  assertEquals(child.includes("entity resolution is mandatory"), false);
  assertEquals(child.includes("strict query returns zero"), false);
  assert(child.includes("at most 20 answer-supporting edges and 40 nodes"));
  assert(child.includes("db.index.fulltext.queryNodes"));
  assert(child.includes("Never carry Neo4j element IDs into later Cypher"));
  assertEquals(root.includes("GRAPH_" + "OBSERVE"), false);
  assertEquals(child.includes("GRAPH_" + "OBSERVE"), false);
  assertEquals(child.includes("password"), false);
});

Deno.test("Neo4j runtime wrappers use NetworkX and provenanced final validation", () => {
  assert(NEO4J_CYPHER_PY.includes("__artifact_to_graph__"));
  assert(NEO4J_CYPHER_PY.includes('return " AND ".join'));
  assert(NEO4J_CYPHER_PY.includes("build_fulltext_entity_queries"));
  assert(NEO4J_CYPHER_PY.includes("neo4j_fulltext"));
  assert(NEO4J_CYPHER_PY.includes("evidence_graph = nx.MultiDiGraph()"));
  assert(NEO4J_CYPHER_PY.includes("__merge_neo4j_evidence__"));
  assert(NEO4J_CYPHER_PY.includes("Cypher result stored in evidence_graph"));
  assertEquals(NEO4J_CYPHER_PY.includes('print("Rows:"'), false);
  assertEquals(NEO4J_CYPHER_PY.includes('print("Nodes:"'), false);
  assertEquals(NEO4J_GRAPH_QUERY_PY.includes("Evidence rows"), false);
  assert(NEO4J_INSPECTION_PY.includes("def neo4j_graph_snapshot"));
  const neo4jFinal = graphFinalSetup(true, 4, true);
  assert(neo4jFinal.includes("at most 20 edges and 40 nodes"));
  assertEquals(neo4jFinal.includes("verified seed"), false);
  assertEquals(NEO4J_INSPECTION_PY.includes("def GRAPH_" + "OBSERVE"), false);
});

Deno.test("active Neo4j contract is key-only", async () => {
  const retiredIdentity = "example_" + "id";
  for (const path of ["src/graph.ts", "src/prompt.ts", "README.md"]) {
    assertEquals((await Deno.readTextFile(path)).includes(retiredIdentity), false);
  }
});
