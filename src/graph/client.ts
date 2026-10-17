import { FalkorDB, type Graph } from "falkordb";
import { falkordbConfig } from "@/config/server-env";

const GRAPH_SUFFIX = /^[a-z0-9][a-z0-9_]{0,63}$/;

// Graph names are always built here from the configured prefix plus an application-chosen suffix
// (a build ID, "smoke", ...). Callers, users, and LLMs never supply a raw graph name.
export function graphName(suffix: string): string {
  if (!GRAPH_SUFFIX.test(suffix)) {
    throw new Error("Graph name suffix must be lowercase letters, digits, and underscores");
  }
  return `${falkordbConfig().graphPrefix}__${suffix}`;
}

export async function connectFalkorDB(): Promise<FalkorDB> {
  const { host, port } = falkordbConfig();
  const db = await FalkorDB.connect({ socket: { host, port, connectTimeout: 5_000 } });
  // Without a listener the underlying redis client turns socket errors into unhandled exceptions.
  db.on("error", () => undefined);
  return db;
}

export type IndexSpec =
  | { kind: "range"; label: string; property: string }
  | { kind: "fulltext"; label: string; property: string }
  | { kind: "vector"; label: string; property: string; dimension: number; similarity: "cosine" | "euclidean" };

type IndexRow = { label: string; properties: string[]; types: Record<string, string[]> };

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

// FalkorDB rejects creating an index that already exists, so check db.indexes() first; this keeps
// bootstrap and checks safe to rerun. Labels/properties are code constants, validated anyway
// because index DDL cannot take them as query parameters.
export async function ensureIndex(graph: Graph, spec: IndexSpec): Promise<"created" | "exists"> {
  if (!IDENTIFIER.test(spec.label) || !IDENTIFIER.test(spec.property)) {
    throw new Error("Index label and property must be plain identifiers");
  }
  if (spec.kind === "vector" && !(Number.isInteger(spec.dimension) && spec.dimension > 0)) {
    throw new Error("Vector index dimension must be a positive integer");
  }
  // GRAPH.QUERY (not RO_QUERY) so a not-yet-created graph is created instead of erroring.
  const existing = await graph.query<IndexRow>("CALL db.indexes() YIELD label, properties, types");
  const wanted = spec.kind.toUpperCase();
  const present = (existing.data ?? []).some(
    (row) => row.label === spec.label && (row.types[spec.property] ?? []).includes(wanted),
  );
  if (present) return "exists";

  const target = `(n:${spec.label}) ON (n.${spec.property})`;
  switch (spec.kind) {
    case "range":
      await graph.query(`CREATE INDEX FOR ${target}`);
      break;
    case "fulltext":
      await graph.query(`CALL db.idx.fulltext.createNodeIndex('${spec.label}', '${spec.property}')`);
      break;
    case "vector":
      await graph.query(
        `CREATE VECTOR INDEX FOR ${target} OPTIONS {dimension: ${spec.dimension}, similarityFunction: '${spec.similarity}'}`,
      );
      break;
  }
  return "created";
}
