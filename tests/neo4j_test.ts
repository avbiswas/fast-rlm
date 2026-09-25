import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1.0.0";
import {
  CypherAttemptGate,
  consumeCypherQuery,
  cypherQuerySignature,
  decodeNeo4jParameters,
  executeNeo4jRead,
  NEO4J_INTEGER_PARAMETER_TAG,
  neo4jErrorMetadata,
  neo4jQueryMetadata,
  neo4jSourceSummary,
  recordsToGraphArtifact,
  validateReadOnlyCypher,
} from "../src/neo4j.ts";
import type { Neo4jHandle } from "../src/neo4j.ts";
import { entityPrecisionRecall, seedEntityNames } from "../src/graph.ts";

class FakeRecord {
  keys: string[];
  #values: Record<string, unknown>;

  constructor(values: Record<string, unknown>) {
    this.keys = Object.keys(values);
    this.#values = values;
  }

  get(key: unknown): unknown {
    return this.#values[String(key)];
  }
}

function node(id: string, name: string) {
  return { elementId: id, labels: ["Entity"], properties: { name } };
}

function relationship(id: string, source: string, target: string) {
  return {
    elementId: id,
    startNodeElementId: source,
    endNodeElementId: target,
    type: "RELATED",
    properties: { predicate: "language.spoken_in" },
  };
}

Deno.test("read-only Cypher accepts bounded reads", () => {
  assertEquals(
    validateReadOnlyCypher(
      "MATCH p=(n {name: $name})-[:RELATED*1..4]->(m) RETURN p LIMIT 10;",
      4,
    ),
    "MATCH p=(n {name: $name})-[:RELATED*1..4]->(m) RETURN p LIMIT 10",
  );
  assertEquals(
    validateReadOnlyCypher("RETURN 'CREATE is data' AS text", 4),
    "RETURN 'CREATE is data' AS text",
  );
  assertEquals(
    validateReadOnlyCypher(
      "WITH [x IN [1, 2] | x * 2] AS values RETURN values",
      4,
    ),
    "WITH [x IN [1, 2] | x * 2] AS values RETURN values",
  );
  assertEquals(
    validateReadOnlyCypher("MATCH p=(a)-[:RELATED]->{1,4}(b) RETURN p", 4),
    "MATCH p=(a)-[:RELATED]->{1,4}(b) RETURN p",
  );
  assertEquals(
    validateReadOnlyCypher(
      "CALL db.index.fulltext.queryNodes('entities', $entity_query) " +
        "YIELD node, score RETURN node, score ORDER BY score DESC LIMIT 10;",
      4,
    ),
    "CALL db.index.fulltext.queryNodes('entities', $entity_query) " +
      "YIELD node, score RETURN node, score ORDER BY score DESC LIMIT 10",
  );
});

Deno.test("read-only Cypher rejects unsafe or unbounded statements", () => {
  for (
    const query of [
      "CREATE (n)",
      "MATCH (n) SET n.name = 'x' RETURN n",
      "CALL db.labels()",
      "CALL db.index.fulltext.queryRelationships('entities', $query) YIELD relationship RETURN relationship",
      "CALL db.index.fulltext.queryNodesEvil('entities', $query) YIELD node RETURN node",
      "CALL db.index.fulltext.queryNodes('entities', $query) YIELD node CALL db.labels() RETURN node",
      "MATCH (n) CALL db.index.fulltext.queryNodes('entities', $query) YIELD node RETURN node",
      "CALL db.index.fulltext.queryNodes('entities', $query) YIELD node DELETE node",
      "SHOW DATABASES",
      "MATCH (n) RETURN n; MATCH (m) RETURN m",
      "MATCH p=(n)-[:RELATED*]->(m) RETURN p",
      "MATCH p=(n)-[:RELATED*1..5]->(m) RETURN p",
      "MATCH p=((n)-[:RELATED]->(m))+ RETURN p",
      "MATCH p=((n)-[:RELATED]->(m)){1,} RETURN p",
      "MATCH p=(n)-[:RELATED]->+(m) RETURN p",
      "MATCH p=(n)-[:RELATED]->{1,5}(m) RETURN p",
    ]
  ) {
    assertThrows(() => validateReadOnlyCypher(query, 4));
  }
  assertThrows(() => validateReadOnlyCypher(`RETURN ${"x".repeat(20_001)}`, 4));
});

Deno.test("Neo4j log metadata excludes query text, values, and credentials", () => {
  const source = {
    version: 1 as const,
    backend: "neo4j" as const,
    uri: "neo4j://private-host:7687",
    username: "private-user",
    password: "private-password",
    database: "answers",
    schema: "(:Entity)",
  };
  const metadata = neo4jQueryMetadata(
    "MATCH (n {name: $name}) RETURN n",
    { name: "private-value" },
    2,
  );
  const failure = neo4jErrorMetadata({
    code: "Neo.ClientError.Statement.SyntaxError",
    message: "private-value",
  });
  const serialized = JSON.stringify({
    source: neo4jSourceSummary(source),
    metadata,
    failure,
  });

  assertEquals(metadata.parameter_names, ["name"]);
  assertEquals(failure.error_code, "Neo.ClientError.Statement.SyntaxError");
  for (
    const secret of [
      "private-host",
      "private-user",
      "private-password",
      "private-value",
      "MATCH",
    ]
  ) {
    assertEquals(serialized.includes(secret), false);
  }
});

Deno.test("Cypher query budget rejects the sixth attempt", () => {
  let count = 0;
  for (let index = 0; index < 5; index++) count = consumeCypherQuery(count, 5);
  assertEquals(count, 5);
  assertThrows(() => consumeCypherQuery(count, 5), Error, "limit is 5");
});

Deno.test("Cypher attempt gate charges only validated database attempts", () => {
  const gate = new CypherAttemptGate(2);
  assertThrows(
    () => cypherQuerySignature("RETURN $value", { value: () => null }, 1),
    Error,
    "JSON-compatible",
  );
  assertEquals(gate.snapshot(), { attempts_used: 0, attempts_remaining: 2 });
  const first = cypherQuerySignature("MATCH (n) RETURN n", { keys: ["jamaica"] }, 10);
  const reordered = cypherQuerySignature("MATCH (n) RETURN n", { keys: ["jamaica"] }, 10);
  assertEquals(first, reordered);
  assertEquals(gate.reserve(first), { attempts_used: 1, attempts_remaining: 1 });
  gate.markSuccessful(first);
  assertThrows(() => gate.reserve(first), Error, "already succeeded");
  assertEquals(gate.snapshot(), { attempts_used: 1, attempts_remaining: 1 });
  gate.resetStep();
  const second = cypherQuerySignature("MATCH (n) RETURN n", { keys: ["english"] }, 10);
  assertEquals(gate.reserve(second), { attempts_used: 2, attempts_remaining: 0 });
  assertThrows(
    () => gate.reserve(cypherQuerySignature("RETURN 1", {}, 1)),
    Error,
    "Only one Cypher database attempt",
  );
  assertEquals(gate.snapshot(), { attempts_used: 2, attempts_remaining: 0 });
});

Deno.test("Neo4j parameter transport preserves integers without changing floats", () => {
  const result = decodeNeo4jParameters({
    limit: { [NEO4J_INTEGER_PARAMETER_TAG]: "10" },
    ratio: 10.0,
    nested: [{ [NEO4J_INTEGER_PARAMETER_TAG]: "-2" }],
  }, (value) => `integer:${value}`);
  assertEquals(result, {
    limit: "integer:10",
    ratio: 10.0,
    nested: ["integer:-2"],
  });
});

Deno.test("entity detection precision and recall use unique predicted entities", () => {
  assertEquals(
    entityPrecisionRecall(["Jamaica"], ["Jamaica"]),
    { precision: 1, recall: 1 },
  );
  assertEquals(
    entityPrecisionRecall(["Jamaica", "Cuba", "Jamaica"], ["Jamaica"]),
    { precision: 0.5, recall: 1 },
  );
  assertEquals(
    entityPrecisionRecall([], ["Jamaica"]),
    { precision: 0, recall: 0 },
  );
});

Deno.test("seed entity audit keeps names and excludes Neo4j identifiers", () => {
  assertEquals(
    seedEntityNames([
      { name: "Benjamin Franklin", key: "private-key", score: 0.95 },
      { name: "Benjamin Franklin", key: "duplicate-key" },
      { name: "Ben Stiller", key: "other-key" },
    ]),
    ["Benjamin Franklin", "Ben Stiller"],
  );
});

Deno.test("Neo4j records become a MultiDiGraph artifact with scalar rows", () => {
  const jamaica = node("node-1", "Jamaica");
  const english = node("node-2", "Jamaican English");
  const related = relationship("rel-1", "node-1", "node-2");
  const path = {
    segments: [{ start: jamaica, relationship: related, end: english }],
  };
  const largeInteger = {
    inSafeRange: () => false,
    toNumber: () => 0,
    toString: () => "9007199254740993",
  };
  const artifact = recordsToGraphArtifact([
    new FakeRecord({ path, count: largeInteger, values: [null, "answer"] }),
  ]);

  assertEquals(artifact.graph_type, "MultiDiGraph");
  assertEquals(artifact.nodes.length, 2);
  assertEquals(artifact.edges.length, 1);
  assertEquals(artifact.edges[0].attributes.relation, "RELATED");
  assertEquals(
    (artifact.attributes.records as Record<string, unknown>[])[0].count,
    "9007199254740993",
  );
  const firstNode = artifact.nodes.find((item) => item.id === "node-1");
  assertEquals(
    (firstNode?.attributes.properties as Record<string, unknown>).name,
    "Jamaica",
  );
});

Deno.test("Neo4j conversion enriches placeholders and normalizes nested temporal values", () => {
  class FakeTemporal {
    toString() {
      return "2026-09-03T10:30:00Z";
    }
  }
  const temporal = new FakeTemporal();
  const artifact = recordsToGraphArtifact([
    new FakeRecord({ edge: relationship("rel-2", "node-3", "node-4") }),
    new FakeRecord({
      entity: node("node-3", "complete node"),
      nested: { observed_at: temporal, nullable: null },
    }),
  ]);

  const enriched = artifact.nodes.find((item) => item.id === "node-3");
  const placeholder = artifact.nodes.find((item) => item.id === "node-4");
  const rows = artifact.attributes.records as Record<string, unknown>[];
  assertEquals(enriched?.attributes.placeholder, undefined);
  assertEquals(
    (enriched?.attributes.properties as Record<string, unknown>).name,
    "complete node",
  );
  assertEquals(placeholder?.attributes.placeholder, true);
  assertEquals(
    (rows[1].nested as Record<string, unknown>).observed_at,
    "2026-09-03T10:30:00Z",
  );
  assertEquals((rows[1].nested as Record<string, unknown>).nullable, null);
});

Deno.test("Neo4j reads use configured database, timeout, row cap, and close session", async () => {
  let sessionClosed = false;
  let sessionConfig: Record<string, unknown> | null = null;
  let transactionConfig: Record<string, unknown> | null = null;
  let recordsRead = 0;
  const records = [
    new FakeRecord({ node: node("1", "one") }),
    new FakeRecord({ node: node("2", "two") }),
  ];
  const driver = {
    verifyConnectivity: async () => {},
    session: (config: Record<string, unknown>) => {
      sessionConfig = config;
      return {
        executeRead: async (
          work: (
            transaction: {
              run: () => AsyncIterable<FakeRecord>;
            },
          ) => Promise<unknown>,
          configValue: Record<string, unknown>,
        ) => {
          transactionConfig = configValue;
          return await work({
            run: () => ({
              async *[Symbol.asyncIterator]() {
                for (const record of records) {
                  recordsRead++;
                  yield record;
                }
              },
            }),
          });
        },
        close: () => {
          sessionClosed = true;
          return Promise.resolve();
        },
      };
    },
    close: async () => {},
  };
  const handle = {
    source: {
      version: 1,
      backend: "neo4j",
      uri: "neo4j://localhost:7687",
      username: "neo4j",
      password: "secret",
      database: "answers",
      schema: "(:Entity)",
    },
    driver,
  } as unknown as Neo4jHandle;

  const result = await executeNeo4jRead(
    handle,
    "MATCH (n) RETURN n",
    {},
    1,
    1234,
  );
  assertEquals(result.rows, 1);
  assertEquals(result.truncated, true);
  assertEquals(sessionConfig, {
    database: "answers",
    defaultAccessMode: "READ",
  });
  assertEquals(transactionConfig, { timeout: 1234 });
  assertEquals(sessionClosed, true);
  assertEquals(recordsRead, 2);

  const failingHandle = {
    ...handle,
    driver: {
      ...driver,
      session: () => ({
        executeRead: () => Promise.reject(new Error("query failed")),
        close: () => {
          sessionClosed = true;
          return Promise.resolve();
        },
      }),
    },
  } as unknown as Neo4jHandle;
  sessionClosed = false;
  await assertRejects(
    () => executeNeo4jRead(failingHandle, "MATCH (n) RETURN n", {}, 1, 1234),
    Error,
    "query failed",
  );
  assertEquals(sessionClosed, true);
});
