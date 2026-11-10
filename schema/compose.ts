// Composes schema/*.graphql into the one SDL document AppSync takes. Each entity has its own file
// that adds its fields with `extend type Query { ... }` / `extend type Mutation { ... }`, so tickets
// working in parallel don't edit the same lines. base.graphql declares the root types.
// Used by infra (the AppSync definition and one resolver per root field) and e2e/backend.ts.
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import {
  Kind, parse, print,
  type DefinitionNode, type FieldDefinitionNode, type ObjectTypeDefinitionNode, type SelectionSetNode,
} from "graphql";

export const SCHEMA_DIR = __dirname;

/** One SDL document from several, with every object type extension merged into its definition. */
export function composeSchema(sources: readonly string[]): string {
  const doc = parse(sources.join("\n"));
  const defs = new Map<string, ObjectTypeDefinitionNode>();
  const rest: DefinitionNode[] = [];
  for (const d of doc.definitions) {
    if (d.kind === Kind.OBJECT_TYPE_DEFINITION) defs.set(d.name.value, { ...d, fields: [...(d.fields ?? [])] });
    else rest.push(d);
  }
  const others: DefinitionNode[] = [];
  for (const d of rest) {
    if (d.kind !== Kind.OBJECT_TYPE_EXTENSION) {
      others.push(d);
      continue;
    }
    const base = defs.get(d.name.value);
    if (!base) throw new Error(`extend type ${d.name.value}: no such type`);
    const fields = base.fields as FieldDefinitionNode[];
    for (const f of d.fields ?? []) {
      if (fields.some((x) => x.name.value === f.name.value)) throw new Error(`${d.name.value}.${f.name.value} is defined twice`);
      fields.push(f);
    }
  }
  // A root type no file has given a field yet (Mutation, early on) is invalid GraphQL: AppSync would refuse
  // it at deploy. Leave it out, and its line in `schema { ... }`, until some file extends it.
  const empty = new Set([...defs.values()].filter((d) => !d.fields?.length).map((d) => d.name.value));
  const definitions = [...defs.values(), ...others]
    .filter((d) => !(d.kind === Kind.OBJECT_TYPE_DEFINITION && empty.has(d.name.value)))
    .map((d) =>
      d.kind === Kind.SCHEMA_DEFINITION ? { ...d, operationTypes: d.operationTypes.filter((o) => !empty.has(o.type.name.value)) } : d,
    );
  return print({ ...doc, definitions });
}

/** The repo's schema: every schema/*.graphql, base.graphql first, the rest by name. */
export function composeSchemaDir(dir = SCHEMA_DIR): string {
  const files = readdirSync(dir).filter((f) => f.endsWith(".graphql")).sort((a, b) => (a === "base.graphql" ? -1 : b === "base.graphql" ? 1 : a < b ? -1 : 1));
  return composeSchema(files.map((f) => readFileSync(path.join(dir, f), "utf8")));
}

/** Field names of the Query and Mutation types, in schema order. */
export function rootFields(sdl: string): { Query: string[]; Mutation: string[] } {
  const out = { Query: [] as string[], Mutation: [] as string[] };
  for (const d of parse(sdl).definitions) {
    if (d.kind === Kind.OBJECT_TYPE_DEFINITION && (d.name.value === "Query" || d.name.value === "Mutation")) {
      out[d.name.value] = (d.fields ?? []).map((f) => f.name.value);
    }
  }
  return out;
}

/**
 * AppSync's query depth cap (infra sets it, e2e/backend.ts enforces it the same way). The root field is
 * depth 1 and every field past the cap comes back null, so it must cover the deepest selection the app sends:
 * `me > avatar > emoji` (ticket 01). A ticket that sends a deeper selection raises it (and the test in
 * infra/test/stacks.test.ts that pins it to that selection); never raise it "just in case".
 */
export const QUERY_DEPTH_LIMIT = 3;

/**
 * AppSync's resolver count cap per request (infra sets it, e2e/backend.ts enforces it the same way). Only
 * Query/Mutation fields have resolvers (the one Lambda), so a request uses one per root field it selects.
 * It must cover the widest operation the app sends (the Friends panel: myFriendCode, friends,
 * friendRequests, sentFriendRequests). Past the cap AppSync answers "Resolver invocation limit reached"
 * and nulls the rest. infra/test/webQueries.test.ts pins it to the widest real operation.
 */
export const RESOLVER_COUNT_LIMIT = 4;

/** Resolvers one request invokes: its root fields (fragments spread at the root count too). */
export function resolverCount(query: string): number {
  const doc = parse(query);
  const fragments = new Map<string, SelectionSetNode>();
  for (const d of doc.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d.selectionSet);
  const count = (set: SelectionSetNode | undefined): number => {
    let n = 0;
    for (const s of set?.selections ?? []) {
      if (s.kind === Kind.FIELD) n += 1;
      else if (s.kind === Kind.INLINE_FRAGMENT) n += count(s.selectionSet);
      else n += count(fragments.get(s.name.value));
    }
    return n;
  };
  let widest = 0;
  for (const d of doc.definitions) if (d.kind === Kind.OPERATION_DEFINITION) widest = Math.max(widest, count(d.selectionSet));
  return widest;
}

/** The deepest field in a query, counted the way AppSync does (root field = 1; fragments add no depth). */
export function queryDepth(query: string): number {
  const doc = parse(query);
  const fragments = new Map<string, SelectionSetNode>();
  for (const d of doc.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d.selectionSet);
  const walk = (set: SelectionSetNode | undefined, depth: number): number => {
    let max = depth - 1;
    for (const s of set?.selections ?? []) {
      if (s.kind === Kind.FIELD) max = Math.max(max, s.selectionSet ? walk(s.selectionSet, depth + 1) : depth);
      else if (s.kind === Kind.INLINE_FRAGMENT) max = Math.max(max, walk(s.selectionSet, depth));
      else max = Math.max(max, walk(fragments.get(s.name.value), depth));
    }
    return max;
  };
  let deepest = 0;
  for (const d of doc.definitions) if (d.kind === Kind.OPERATION_DEFINITION) deepest = Math.max(deepest, walk(d.selectionSet, 1));
  return deepest;
}
