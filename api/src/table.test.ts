// The shared table helpers: prefix queries always follow every page, and cancelled transactions are read the same
// way everywhere.
import { describe, expect, it } from "vitest";
import { failedConditions, isCancelled, queryPrefix, setDocClient, type DocClient } from "./table";

/** A client that serves `pages` in turn and records each Query input. */
function paged(pages: { Items: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> }[]) {
  const inputs: Record<string, unknown>[] = [];
  const client = {
    send: async (cmd: { input: Record<string, unknown> }) => {
      inputs.push(cmd.input);
      return pages[inputs.length - 1];
    },
  } as unknown as DocClient;
  return { client, inputs };
}

describe("queryPrefix", () => {
  it("follows LastEvaluatedKey through every page", async () => {
    const { client, inputs } = paged([
      { Items: [{ SK: "X#1" }], LastEvaluatedKey: { PK: "P", SK: "X#1" } },
      { Items: [{ SK: "X#2" }], LastEvaluatedKey: { PK: "P", SK: "X#2" } },
      { Items: [{ SK: "X#3" }] },
    ]);
    setDocClient(client);
    expect((await queryPrefix("P", "X#")).map((i) => i.SK)).toEqual(["X#1", "X#2", "X#3"]);
    expect(inputs.map((i) => i.ExclusiveStartKey)).toEqual([undefined, { PK: "P", SK: "X#1" }, { PK: "P", SK: "X#2" }]);
    expect(inputs[0]).toMatchObject({
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :p)",
      ExpressionAttributeValues: { ":pk": "P", ":p": "X#" },
    });
  });

  it("stops at max and asks only for what is still missing", async () => {
    const { client, inputs } = paged([
      { Items: [{ SK: "X#9" }, { SK: "X#8" }], LastEvaluatedKey: { PK: "P", SK: "X#8" } },
      { Items: [{ SK: "X#7" }], LastEvaluatedKey: { PK: "P", SK: "X#7" } },
    ]);
    setDocClient(client);
    expect(await queryPrefix("P", "X#", { descending: true, max: 3 })).toHaveLength(3);
    expect(inputs.map((i) => i.Limit)).toEqual([3, 1]);
    expect(inputs[0].ScanIndexForward).toBe(false);
  });
});

describe("cancelled transactions", () => {
  it("reads which items failed their condition", () => {
    const e = { name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] };
    expect(isCancelled(e)).toBe(true);
    expect(failedConditions(e)).toEqual([false, true]);
  });

  it("is undefined for anything else", () => {
    expect(isCancelled({ name: "ConditionalCheckFailedException" })).toBe(false);
    expect(failedConditions(new Error("boom"))).toBeUndefined();
    expect(failedConditions(undefined)).toBeUndefined();
  });
});
