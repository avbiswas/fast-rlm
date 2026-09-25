import type { GraphArtifact } from "./graph.ts";

export interface Neo4jSource {
  version: 1;
  backend: "neo4j";
  uri: string;
  username: string;
  password: string;
  database: string;
  schema: string;
}

interface Neo4jRecordLike {
  keys: unknown[];
  get(key: unknown): unknown;
}

interface Neo4jResultLike {
  records: Neo4jRecordLike[];
}

interface Neo4jResultStreamLike extends AsyncIterable<Neo4jRecordLike> {}

interface Neo4jTransactionLike {
  run(
    query: string,
    parameters: Record<string, unknown>,
  ): Neo4jResultStreamLike | Promise<Neo4jResultLike>;
}

interface Neo4jSessionLike {
  executeRead<T>(
    work: (transaction: Neo4jTransactionLike) => Promise<T>,
    config?: { timeout?: number },
  ): Promise<T>;
  close(): Promise<void>;
}

interface Neo4jDriverLike {
  verifyConnectivity(config?: { database?: string }): Promise<void>;
  session(
    config: { database: string; defaultAccessMode: string },
  ): Neo4jSessionLike;
  close(): Promise<void>;
}

export interface Neo4jHandle {
  source: Neo4jSource;
  driver: Neo4jDriverLike;
  toInteger?: (value: string) => unknown;
}

export interface Neo4jQueryResult {
  artifact: GraphArtifact;
  rows: number;
  truncated: boolean;
}

// Pyodide otherwise represents both Python ints and floats as JavaScript numbers.
export const NEO4J_INTEGER_PARAMETER_TAG = "__fast_rlm_neo4j_integer__";

export function decodeNeo4jParameters(
  value: unknown,
  toInteger: (value: string) => unknown,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => decodeNeo4jParameters(item, toInteger));
  }
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  if (
    keys.length === 1 && keys[0] === NEO4J_INTEGER_PARAMETER_TAG &&
    typeof value[NEO4J_INTEGER_PARAMETER_TAG] === "string" &&
    /^-?(?:0|[1-9]\d*)$/.test(value[NEO4J_INTEGER_PARAMETER_TAG])
  ) {
    return toInteger(value[NEO4J_INTEGER_PARAMETER_TAG]);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      decodeNeo4jParameters(item, toInteger),
    ]),
  );
}

export function assertNeo4jSource(value: unknown): Neo4jSource {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Neo4j graph source must be an object");
  }
  const source = value as Record<string, unknown>;
  if (
    source.version !== 1 || source.backend !== "neo4j" ||
    !["uri", "username", "password", "database", "schema"].every(
      (key) =>
        typeof source[key] === "string" &&
        (source[key] as string).trim().length > 0,
    )
  ) {
    throw new Error("invalid Neo4j graph source");
  }
  return source as unknown as Neo4jSource;
}

export function neo4jSourceSummary(source: Neo4jSource) {
  return {
    backend: source.backend,
    database: source.database,
    schema_chars: source.schema.length,
  };
}

export function neo4jQueryMetadata(
  query: unknown,
  parameters: unknown,
  queryNumber: number,
) {
  const parameterNames = isObject(parameters) && !Array.isArray(parameters)
    ? Object.keys(parameters).sort()
    : [];
  return {
    cypher_query_number: queryNumber,
    parameter_names: parameterNames,
    query_chars: typeof query === "string" ? query.length : 0,
  };
}

export function neo4jErrorMetadata(error: unknown) {
  const code = isObject(error) && typeof error.code === "string" &&
      /^[A-Za-z0-9_.-]{1,160}$/.test(error.code)
    ? error.code
    : undefined;
  return {
    error: "Neo4j query failed",
    ...(code ? { error_code: code } : {}),
  };
}

export function consumeCypherQuery(count: number, limit: number): number {
  if (count >= limit) {
    throw new Error(`Cypher query budget exceeded: limit is ${limit}`);
  }
  return count + 1;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cypher parameters must be JSON-compatible");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(",")}}`;
  }
  throw new Error("Cypher parameters must be JSON-compatible");
}

export function cypherQuerySignature(
  query: string,
  parameters: Record<string, unknown>,
  limit: number,
): string {
  return `${query}\n${stableJson(parameters)}\n${limit}`;
}

export class CypherAttemptGate {
  #used = 0;
  #stepAttempted = false;
  #successful = new Set<string>();

  constructor(private readonly limit: number) {}

  resetStep() {
    this.#stepAttempted = false;
  }

  reserve(signature: string) {
    if (this.#successful.has(signature)) {
      throw new Error("This identical Cypher query already succeeded");
    }
    if (this.#stepAttempted) {
      throw new Error("Only one Cypher database attempt is allowed per REPL step");
    }
    this.#used = consumeCypherQuery(this.#used, this.limit);
    this.#stepAttempted = true;
    return this.snapshot();
  }

  markSuccessful(signature: string) {
    this.#successful.add(signature);
  }

  snapshot() {
    return { attempts_used: this.#used, attempts_remaining: this.limit - this.#used };
  }
}

export async function connectNeo4j(source: Neo4jSource): Promise<Neo4jHandle> {
  // Loaded only for Neo4j-backed runs so ordinary FastRLM startup stays light.
  // deno-lint-ignore no-explicit-any
  const imported: any = await import("neo4j");
  const neo4j = imported.default ?? imported;
  const driver = neo4j.driver(
    source.uri,
    neo4j.auth.basic(source.username, source.password),
  ) as Neo4jDriverLike;
  try {
    await driver.verifyConnectivity({ database: source.database });
  } catch (error) {
    await driver.close();
    throw error;
  }
  return { source, driver, toInteger: (value) => neo4j.int(value) };
}

function maskCypher(query: string): string {
  let result = "";
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < query.length; index++) {
    const char = query[index];
    const next = query[index + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        result += "\n";
      } else result += " ";
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        result += "  ";
        blockComment = false;
        index++;
      } else result += char === "\n" ? "\n" : " ";
      continue;
    }
    if (quote) {
      result += " ";
      if (char === quote) {
        if (next === quote) {
          result += " ";
          index++;
        } else quote = null;
      } else if (char === "\\" && next !== undefined) {
        result += " ";
        index++;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      result += "  ";
      lineComment = true;
      index++;
    } else if (char === "/" && next === "*") {
      result += "  ";
      blockComment = true;
      index++;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
      result += " ";
    } else result += char;
  }
  if (quote || blockComment) {
    throw new Error("unterminated Cypher literal or comment");
  }
  return result;
}

function assertPathBounds(masked: string, maxHops: number): void {
  for (const match of masked.matchAll(/(?:<-|-)\s*\[[^\]]*\*([^\]]*)\]/g)) {
    const expansion = match[1].trim();
    const bounds = /^(\d+)(?:\s*\.\.\s*(\d+))?$/.exec(expansion);
    if (!bounds) {
      throw new Error(
        "variable-length paths require a finite bound such as *1..4",
      );
    }
    const upper = Number(bounds[2] ?? bounds[1]);
    if (upper > maxHops) {
      throw new Error(`variable-length path exceeds max_graph_hops=${maxHops}`);
    }
  }
  if (/(?:\)|\]|->|<-)\s*[+*]/.test(masked)) {
    throw new Error("quantified paths require an explicit finite upper bound");
  }
  for (
    const match of masked.matchAll(
      /(?:\)|\]|->|<-)\s*\{\s*(\d*)\s*,\s*(\d*)\s*\}/g,
    )
  ) {
    if (!match[2]) {
      throw new Error(
        "quantified paths require an explicit finite upper bound",
      );
    }
    if (Number(match[2]) > maxHops) {
      throw new Error(`quantified path exceeds max_graph_hops=${maxHops}`);
    }
  }
  for (const match of masked.matchAll(/(?:\)|\]|->|<-)\s*\{\s*(\d+)\s*\}/g)) {
    if (Number(match[1]) > maxHops) {
      throw new Error(`quantified path exceeds max_graph_hops=${maxHops}`);
    }
  }
}

export function validateReadOnlyCypher(
  query: unknown,
  maxHops: number,
): string {
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("query must be a non-empty string");
  }
  if (query.length > 20_000) throw new Error("query is too long");
  let normalized = query.trim();
  if (normalized.endsWith(";")) normalized = normalized.slice(0, -1).trimEnd();
  const masked = maskCypher(normalized);
  if (masked.includes(";")) {
    throw new Error("multiple Cypher statements are not allowed");
  }
  const fulltextNodeQuery =
    /^\s*CALL\s+db\.index\.fulltext\.queryNodes\s*\(/i.test(masked);
  const readClause =
    /^\s*(MATCH|OPTIONAL\s+MATCH|WITH|UNWIND|RETURN)\b/i.test(masked);
  if (!readClause && !fulltextNodeQuery) {
    throw new Error("query must start with a read-oriented Cypher clause");
  }
  const callCount = masked.match(/\bCALL\b/gi)?.length ?? 0;
  if (callCount > 0 && (!fulltextNodeQuery || callCount !== 1)) {
    throw new Error("only CALL db.index.fulltext.queryNodes is allowed");
  }
  const forbidden =
    /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|ALTER|GRANT|DENY|REVOKE|SHOW|TERMINATE|START|STOP|FOREACH|USE)\b|\bLOAD\s+CSV\b/i;
  if (forbidden.test(masked)) {
    throw new Error(
      "write, schema, procedure, or administrative Cypher is not allowed",
    );
  }
  assertPathBounds(masked, maxHops);
  return normalized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNode(value: unknown): value is {
  elementId: string;
  labels: unknown[];
  properties: Record<string, unknown>;
} {
  return isObject(value) && "elementId" in value &&
    Array.isArray(value.labels) &&
    isObject(value.properties);
}

function isRelationship(value: unknown): value is {
  elementId: string;
  startNodeElementId: string;
  endNodeElementId: string;
  type: string;
  properties: Record<string, unknown>;
} {
  return isObject(value) && "elementId" in value &&
    "startNodeElementId" in value &&
    "endNodeElementId" in value && typeof value.type === "string" &&
    isObject(value.properties);
}

function isPath(value: unknown): value is { segments: unknown[] } {
  return isObject(value) && Array.isArray(value.segments);
}

function isNeo4jInteger(value: unknown): value is {
  inSafeRange(): boolean;
  toNumber(): number;
  toString(): string;
} {
  return isObject(value) && typeof value.inSafeRange === "function" &&
    typeof value.toNumber === "function" &&
    typeof value.toString === "function";
}

function jsonSafe(value: unknown): unknown {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (isObject(value)) {
    if (isNeo4jInteger(value)) {
      return value.inSafeRange() ? value.toNumber() : value.toString();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]),
      );
    }
    return String(value);
  }
  return String(value);
}

export function recordsToGraphArtifact(
  records: Neo4jRecordLike[],
  truncated = false,
): GraphArtifact {
  const nodes = new Map<
    string,
    { id: string; attributes: Record<string, unknown> }
  >();
  const edges = new Map<string, GraphArtifact["edges"][number]>();

  const addPlaceholder = (id: string) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        attributes: {
          labels: [],
          properties: {},
          neo4j_element_id: id,
          placeholder: true,
        },
      });
    }
  };
  const addNode = (node: ReturnType<typeof asNode>) => {
    if (!node) return;
    const id = String(node.elementId);
    nodes.set(id, {
      id,
      attributes: {
        labels: node.labels.map(String),
        properties: jsonSafe(node.properties) as Record<string, unknown>,
        neo4j_element_id: id,
      },
    });
  };
  const addRelationship = (relationship: ReturnType<typeof asRelationship>) => {
    if (!relationship) return;
    const source = String(relationship.startNodeElementId);
    const target = String(relationship.endNodeElementId);
    const key = String(relationship.elementId);
    addPlaceholder(source);
    addPlaceholder(target);
    edges.set(key, {
      source,
      target,
      key,
      attributes: {
        relation: relationship.type,
        type: relationship.type,
        properties: jsonSafe(relationship.properties) as Record<
          string,
          unknown
        >,
        neo4j_element_id: key,
      },
    });
  };
  const visit = (value: unknown): unknown => {
    if (isPath(value)) {
      const nodeIds: string[] = [];
      const relationshipIds: string[] = [];
      for (const rawSegment of value.segments) {
        if (!isObject(rawSegment)) continue;
        const start = asNode(rawSegment.start);
        const end = asNode(rawSegment.end);
        const relationship = asRelationship(rawSegment.relationship);
        addNode(start);
        addNode(end);
        addRelationship(relationship);
        if (start && nodeIds.at(-1) !== String(start.elementId)) {
          nodeIds.push(String(start.elementId));
        }
        if (end) nodeIds.push(String(end.elementId));
        if (relationship) relationshipIds.push(String(relationship.elementId));
      }
      return { path: nodeIds, relationships: relationshipIds };
    }
    const node = asNode(value);
    if (node) {
      addNode(node);
      return { node: String(node.elementId) };
    }
    const relationship = asRelationship(value);
    if (relationship) {
      addRelationship(relationship);
      return { relationship: String(relationship.elementId) };
    }
    if (isNeo4jInteger(value)) return jsonSafe(value);
    if (Array.isArray(value)) return value.map(visit);
    if (isObject(value) && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, visit(item)]),
      );
    }
    return jsonSafe(value);
  };
  const rows = records.map((record) =>
    Object.fromEntries(
      record.keys.map((key) => [String(key), visit(record.get(key))]),
    )
  );
  return {
    version: 1,
    backend: "networkx",
    graph_type: "MultiDiGraph",
    attributes: { source_backend: "neo4j", records: rows, truncated },
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
}

function asNode(value: unknown) {
  return isNode(value) ? value : null;
}

function asRelationship(value: unknown) {
  return isRelationship(value) ? value : null;
}

export async function executeNeo4jRead(
  handle: Neo4jHandle,
  query: string,
  parameters: Record<string, unknown>,
  limit: number,
  timeoutMs: number,
): Promise<Neo4jQueryResult> {
  const driverParameters = decodeNeo4jParameters(
    parameters,
    handle.toInteger ?? ((value) => Number(value)),
  ) as Record<string, unknown>;
  const session = handle.driver.session({
    database: handle.source.database,
    defaultAccessMode: "READ",
  });
  try {
    const { records, truncated } = await session.executeRead(
      async (transaction) => {
        const result = transaction.run(query, driverParameters);
        const stream = result as Partial<Neo4jResultStreamLike>;
        if (
          isObject(result) &&
          typeof stream[Symbol.asyncIterator] === "function"
        ) {
          const records: Neo4jRecordLike[] = [];
          let truncated = false;
          for await (const record of stream as Neo4jResultStreamLike) {
            if (records.length === limit) {
              truncated = true;
              break;
            }
            records.push(record);
          }
          return { records, truncated };
        }
        const eager = await result as Neo4jResultLike;
        return {
          records: eager.records.slice(0, limit),
          truncated: eager.records.length > limit,
        };
      },
      { timeout: timeoutMs },
    );
    return {
      artifact: recordsToGraphArtifact(records, truncated),
      rows: records.length,
      truncated,
    };
  } finally {
    await session.close();
  }
}
