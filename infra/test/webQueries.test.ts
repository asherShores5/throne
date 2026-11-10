// Every GraphQL operation the web app sends, read straight from web/src (no list to keep up to date), is
// checked against the composed schema and against QUERY_DEPTH_LIMIT. A new selection deeper than the cap
// fails here (AppSync would answer it with nulls), and so does a cap set higher than any real selection.
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { buildSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import { QUERY_DEPTH_LIMIT, composeSchemaDir, queryDepth, rootFields } from "../../schema/compose";

const WEB_SRC = path.join(__dirname, "..", "..", "web", "src");
const APPSYNC_PRELUDE = "scalar AWSJSON\nscalar AWSDate\nscalar AWSDateTime\n";

function sources(dir: string): { file: string; text: string }[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    if (!/\.tsx?$/.test(f) || /\.test\.tsx?$/.test(f)) return [];
    return [{ file: path.relative(WEB_SRC, p), text: readFileSync(p, "utf8") }];
  });
}

/** The app's operations with every `${CONST}` selection filled in from its `const CONST = \`...\`` definition. */
export function webOperations(): { file: string; op: string }[] {
  const files = sources(WEB_SRC);
  const consts = new Map<string, string>();
  for (const { text } of files) for (const m of text.matchAll(/\bconst (\w+)\s*=\s*(?:`([^`]*)`|"([^"]*)")/g)) consts.set(m[1], m[2] ?? m[3]);
  const fill = (s: string, file: string): string =>
    s.replace(/\$\{\s*(\w+)\s*\}/g, (_, name: string) => {
      const v = consts.get(name);
      if (v === undefined) throw new Error(`${file}: \${${name}} in a GraphQL operation isn't a plain string constant`);
      return fill(v, file);
    });
  const ops: { file: string; op: string }[] = [];
  for (const { file, text } of files) {
    for (const m of text.matchAll(/`(\s*(?:query|mutation|subscription)\b[^`]*)`/g)) ops.push({ file, op: fill(m[1], file) });
  }
  return ops;
}

describe("the web app's GraphQL operations", () => {
  const ops = webOperations();
  const schema = buildSchema(APPSYNC_PRELUDE + composeSchemaDir());

  it("are found (the scan works)", () => {
    expect(ops.length).toBeGreaterThan(20);
  });

  it("are all valid against the composed schema", () => {
    const bad = ops.flatMap(({ file, op }) => validate(schema, parse(op)).map((e) => `${file}: ${e.message}`));
    expect(bad).toEqual([]);
  });

  it("fit under QUERY_DEPTH_LIMIT, and the deepest is exactly the cap (never raised just in case)", () => {
    const over = ops.filter(({ op }) => queryDepth(op) > QUERY_DEPTH_LIMIT).map(({ file, op }) => `${file}: depth ${queryDepth(op)}: ${op.trim().slice(0, 80)}`);
    expect(over).toEqual([]);
    expect(Math.max(...ops.map(({ op }) => queryDepth(op)))).toBe(QUERY_DEPTH_LIMIT);
  });

  it("use every root field the API exposes (no unused API surface)", () => {
    const used = new Set<string>();
    for (const { op } of ops) {
      for (const d of parse(op).definitions) {
        if (d.kind === "OperationDefinition") for (const s of d.selectionSet.selections) if (s.kind === "Field") used.add(s.name.value);
      }
    }
    const { Query, Mutation } = rootFields(composeSchemaDir());
    expect([...Query, ...Mutation].filter((f) => !used.has(f))).toEqual([]);
  });
});
