// Every resolver, by GraphQL field name. One module per entity (resolvers/<entity>.ts, schema in
// schema/<entity>.graphql); infra wires an AppSync resolver for every Query/Mutation field in the
// schema, so a new field needs only its schema line and its resolver here.
import { log } from "./log";
import { profile } from "./profile";
import type { Resolver, ResolverModule } from "./types";

const MODULES: ResolverModule[] = [profile, log];

function merge(type: "Query" | "Mutation"): Record<string, Resolver> {
  const out: Record<string, Resolver> = {};
  for (const m of MODULES) {
    for (const [field, fn] of Object.entries(m[type])) {
      if (field in out) throw new Error(`two resolvers for ${type}.${field}`);
      out[field] = fn;
    }
  }
  return out;
}

const QUERIES = merge("Query");
const MUTATIONS = merge("Mutation");

export const QUERY_FIELDS = new Set(Object.keys(QUERIES));
export const RESOLVERS: Record<string, Resolver> = { ...QUERIES, ...MUTATIONS };
export type { Ctx, Resolver, ResolverModule } from "./types";
