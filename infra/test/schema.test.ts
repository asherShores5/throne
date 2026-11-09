// The GraphQL schema is split per entity (schema/*.graphql) and composed into one document for
// AppSync and the e2e fake backend. AppSync rejects a bad schema only at deploy, so check it here.
import { buildSchema, parse, validateSchema } from "graphql";
import { describe, expect, it } from "vitest";
import { composeSchema, composeSchemaDir, rootFields } from "../../schema/compose";

/** Scalars and directives AppSync supplies; graphql-js needs them declared. */
const APPSYNC_PRELUDE = "scalar AWSJSON\nscalar AWSDate\nscalar AWSDateTime\ndirective @aws_subscribe(mutations: [String]) on FIELD_DEFINITION\n";

describe("schema composition", () => {
  it("folds each file's `extend type Query/Mutation` into one Query and one Mutation type", () => {
    const sdl = composeSchema([
      "schema { query: Query mutation: Mutation }\ntype Query\ntype Mutation",
      "# placeholder file with no definitions yet",
      "type Thing { id: ID! }\nextend type Query { things: [Thing!]! }\nextend type Mutation { putThing(id: ID!): Thing! }",
      "extend type Query { thing(id: ID!): Thing }",
    ]);
    expect(sdl).not.toMatch(/\bextend\b/);
    expect(rootFields(sdl)).toEqual({ Query: ["things", "thing"], Mutation: ["putThing"] });
    expect(() => buildSchema(APPSYNC_PRELUDE + sdl)).not.toThrow();
  });

  it("refuses the same root field in two files", () => {
    expect(() => composeSchema(["type Query", "extend type Query { a: Int }", "extend type Query { a: Int }"])).toThrow(/Query\.a/);
  });

  it("the repo's schema/ composes into a valid schema with the Profile API", () => {
    const sdl = composeSchemaDir();
    // buildSchema alone doesn't run the validation AppSync does (e.g. an empty type); validateSchema does.
    expect(validateSchema(buildSchema(APPSYNC_PRELUDE + sdl)).map((e) => e.message)).toEqual([]);
    expect(rootFields(sdl).Query).toContain("me");
  });

  it("leaves out a root type no file has added fields to yet (an empty type is invalid)", () => {
    const sdl = composeSchema(["schema { query: Query mutation: Mutation }\ntype Query\ntype Mutation", "extend type Query { a: Int }"]);
    expect(validateSchema(buildSchema(sdl)).map((e) => e.message)).toEqual([]);
    expect(rootFields(sdl)).toEqual({ Query: ["a"], Mutation: [] });
    expect(sdl).not.toMatch(/Mutation/);
  });

  it("uses # comments, not string descriptions (AppSync has rejected described types)", () => {
    const sdl = composeSchemaDir();
    const described = parse(sdl).definitions.filter((d: any) => d.description || d.fields?.some((f: any) => f.description || f.arguments?.some((a: any) => a.description)));
    expect(described.map((d: any) => d.name?.value)).toEqual([]);
  });
});
