/**
 * Read-only live probe for the FastRLM Pyodide -> Neo4j parameter bridge.
 *
 * It deliberately compares two otherwise identical full-text reads: a literal
 * Cypher LIMIT and a parameterized Cypher LIMIT. It emits no returned rows,
 * credentials, or graph properties.
 */
import { loadPyodide } from "pyodide";
import { NEO4J_PARAMETER_TRANSPORT_PY } from "../src/graph.ts";
import {
  assertNeo4jSource,
  connectNeo4j,
  executeNeo4jRead,
  NEO4J_INTEGER_PARAMETER_TAG,
  validateReadOnlyCypher,
} from "../src/neo4j.ts";
import { pyProxyToJs } from "../src/pyodide.ts";

const MAX_ROWS = 100;
const TIMEOUT_MS = 15_000;

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function parameterTypes(parameters: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parameters).map(([name, value]) => [
      name,
      typeof value === "object" && value !== null && !Array.isArray(value) &&
          Object.keys(value).length === 1 && NEO4J_INTEGER_PARAMETER_TAG in value
        ? "neo4j-integer"
        : typeof value,
    ]),
  );
}

const source = assertNeo4jSource({
  version: 1,
  backend: "neo4j",
  uri: requiredEnvironment("NEO4J_URI"),
  username: requiredEnvironment("NEO4J_USERNAME"),
  password: requiredEnvironment("NEO4J_PASSWORD"),
  database: requiredEnvironment("NEO4J_DATABASE"),
  schema: "FastRLM Neo4j parameter smoke test",
});

const literalLimitQuery = `
CALL db.index.fulltext.queryNodes("webqsp_entity_names", $mention) YIELD node, score
WHERE node.key IS NOT NULL
RETURN node.key AS key, node.name AS name, score
ORDER BY score DESC LIMIT 10
`;
const parameterizedLimitQuery = `
CALL db.index.fulltext.queryNodes("webqsp_entity_names", $mention) YIELD node, score
WHERE node.key IS NOT NULL
RETURN node.key AS key, node.name AS name, score
ORDER BY score DESC LIMIT $limit
`;

const handle = await connectNeo4j(source);
const pyodide = await loadPyodide();
await pyodide.runPythonAsync(NEO4J_PARAMETER_TRANSPORT_PY);

pyodide.globals.set("__js_fast_rlm_parameter_smoke__", async (
  rawQuery: unknown,
  rawParameters: unknown,
  rawLimit: unknown,
) => {
  const parameters = pyProxyToJs(rawParameters) ?? {};
  if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
    throw new Error("Cypher parameters must be a dict");
  }
  let limit = MAX_ROWS;
  if (rawLimit != null) {
    const convertedLimit = pyProxyToJs(rawLimit);
    const value = Number(convertedLimit);
    if (typeof convertedLimit === "boolean" || !Number.isInteger(value) || value < 1) {
      throw new Error("Cypher limit must be a positive integer");
    }
    limit = Math.min(value, MAX_ROWS);
  }
  const query = validateReadOnlyCypher(rawQuery, 4);
  const typedParameters = parameters as Record<string, unknown>;
  try {
    const result = await executeNeo4jRead(handle, query, typedParameters, limit, TIMEOUT_MS);
    return { status: "ok", rows: result.rows, parameter_types: parameterTypes(typedParameters) };
  } catch (error) {
    const value = error as { code?: unknown; message?: unknown };
    return {
      status: "error",
      code: typeof value.code === "string" ? value.code : "unknown",
      message: typeof value.message === "string" ? value.message : "unknown error",
      parameter_types: parameterTypes(typedParameters),
    };
  }
});

try {
  pyodide.globals.set("__literal_limit_query__", literalLimitQuery);
  pyodide.globals.set("__parameterized_limit_query__", parameterizedLimitQuery);
  const rawResult = await pyodide.runPythonAsync(`
import json

async def __run_fast_rlm_parameter_smoke__():
    literal_limit = await __js_fast_rlm_parameter_smoke__(
        __literal_limit_query__,
        __neo4j_transport_parameters__({"mention": "jamaica*"}),
        None
    )
    parameterized_limit = await __js_fast_rlm_parameter_smoke__(
        __parameterized_limit_query__,
        __neo4j_transport_parameters__({"mention": "jamaica*", "limit": 10}),
        None
    )
    return json.dumps({
        "literal_limit": literal_limit.to_py() if hasattr(literal_limit, "to_py") else literal_limit,
        "parameterized_limit": parameterized_limit.to_py() if hasattr(parameterized_limit, "to_py") else parameterized_limit,
    })

await __run_fast_rlm_parameter_smoke__()
`);
  const result = JSON.parse(String(rawResult)) as {
    literal_limit: { status: string; rows?: number };
    parameterized_limit: { status: string; rows?: number };
  };
  console.log(JSON.stringify(result, null, 2));
  if (
    result.literal_limit.status !== "ok" ||
    result.parameterized_limit.status !== "ok" ||
    result.literal_limit.rows !== result.parameterized_limit.rows
  ) {
    Deno.exitCode = 1;
  }
} finally {
  await handle.driver.close();
}
