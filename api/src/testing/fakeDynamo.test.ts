import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { FakeDocClient, asLambda } from "./fakeDynamo";

const put = (Item: Record<string, unknown>, ConditionExpression: string, ExpressionAttributeValues = {}, ExpressionAttributeNames?: Record<string, string>) =>
  new PutCommand({ TableName: "t", Item, ConditionExpression, ExpressionAttributeValues, ExpressionAttributeNames });

describe("fakeDynamo matches DynamoDB", () => {
  it("`<>` against a missing attribute is false", async () => {
    const db = new FakeDocClient();
    db.seed({ PK: "p", SK: "s" });
    await expect(db.send(put({ PK: "p", SK: "s", x: 1 }, "#x <> :v", { ":v": 1 }, { "#x": "x" }))).rejects.toThrow("condition failed");
  });

  it("a conditional put refuses to overwrite, and leaves the old record", async () => {
    const db = new FakeDocClient();
    db.seed({ PK: "p", SK: "s", v: 1 });
    await expect(db.send(put({ PK: "p", SK: "s", v: 2 }, "attribute_not_exists(#pk)", undefined, { "#pk": "PK" }))).rejects.toMatchObject({
      name: "ConditionalCheckFailedException",
    });
    expect(db.dump()).toEqual([{ PK: "p", SK: "s", v: 1 }]);
  });

  it("a transaction with one failed condition writes nothing", async () => {
    const db = new FakeDocClient();
    db.seed({ PK: "p", SK: "a" });
    const tx = new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: "t", Item: { PK: "p", SK: "a" }, ConditionExpression: "attribute_not_exists(#sk)", ExpressionAttributeNames: { "#sk": "SK" } } },
        { Put: { TableName: "t", Item: { PK: "p", SK: "b" } } },
      ],
    });
    await expect(db.send(tx)).rejects.toMatchObject({
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
    });
    expect(db.dump().map((r) => r.SK)).toEqual(["a"]);
  });

  it("Select COUNT returns a Count and no Items", async () => {
    const db = new FakeDocClient();
    db.seed({ PK: "p", SK: "X#1" }, { PK: "p", SK: "X#2" }, { PK: "p", SK: "Y#1" });
    const r = await db.send(
      new QueryCommand({
        TableName: "t", KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :p)",
        ExpressionAttributeNames: { "#pk": "PK", "#sk": "SK" },
        ExpressionAttributeValues: { ":pk": "p", ":p": "X#" }, Select: "COUNT",
      }),
    );
    expect(r).toEqual({ Count: 2, LastEvaluatedKey: undefined });
  });

  it("transaction Updates count with if_not_exists and are refused together", async () => {
    const db = new FakeDocClient();
    const bump = (SK: string, cap: number) => ({
      Update: {
        TableName: "t", Key: { PK: "p", SK },
        UpdateExpression: "SET #n = if_not_exists(#n,:zero) + :one, #e = :e",
        ConditionExpression: "attribute_not_exists(#n) OR #n < :cap",
        ExpressionAttributeNames: { "#n": "count", "#e": "e" }, ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":cap": cap, ":e": 9 },
      },
    });
    await db.send(new TransactWriteCommand({ TransactItems: [bump("a", 1), bump("b", 5)] }));
    expect(db.dump()).toEqual([{ PK: "p", SK: "a", count: 1, e: 9 }, { PK: "p", SK: "b", count: 1, e: 9 }]);
    await expect(db.send(new TransactWriteCommand({ TransactItems: [bump("a", 1), bump("b", 5)] }))).rejects.toMatchObject({
      name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
    });
    expect(db.dump().map((r) => r.count)).toEqual([1, 1]);
  });
});

// Throne's rule (spec: every DynamoDB expression aliases attribute names) is stricter than DynamoDB's own
// reserved-word check, so a bare `status`, `name` or `count` can never slip through to a live
// ValidationException. Like DynamoDB, unused placeholders are refused too.
describe("fakeDynamo refuses expressions DynamoDB (or Throne's rule) would refuse", () => {
  const update = (UpdateExpression: string, names?: Record<string, string>, values?: Record<string, unknown>, ConditionExpression?: string) =>
    new UpdateCommand({ TableName: "t", Key: { PK: "p", SK: "s" }, UpdateExpression, ConditionExpression, ExpressionAttributeNames: names, ExpressionAttributeValues: values });

  it("a bare attribute name in an update, condition or key condition", async () => {
    const db = new FakeDocClient();
    await expect(db.send(update("SET status = :v", undefined, { ":v": "open" }))).rejects.toThrow(/un-aliased attribute name "status"/);
    await expect(db.send(update("SET #s = :v", { "#s": "status" }, { ":v": 1 }, "attribute_not_exists(PK)"))).rejects.toThrow(/un-aliased attribute name "PK"/);
    await expect(
      db.send(new QueryCommand({ TableName: "t", KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": "p" } })),
    ).rejects.toThrow(/un-aliased attribute name "PK"/);
    expect(db.dump()).toEqual([]);
  });

  it("an ExpressionAttributeNames or Values entry the expressions never use", async () => {
    const db = new FakeDocClient();
    await expect(db.send(update("SET #s = :v", { "#s": "status", "#x": "x" }, { ":v": 1 }))).rejects.toThrow(/unused.*#x/);
    await expect(db.send(update("SET #s = :v", { "#s": "status" }, { ":v": 1, ":w": 2 }))).rejects.toThrow(/unused.*:w/);
    await expect(db.send(put({ PK: "p", SK: "s" }, "attribute_not_exists(#pk)", { ":v": 1 }, { "#pk": "PK" }))).rejects.toThrow(/unused.*:v/);
  });

  it("the aliased form of the same writes works", async () => {
    const db = new FakeDocClient();
    await db.send(update("SET #s = :v", { "#s": "status" }, { ":v": "open" }));
    expect(db.dump()).toEqual([{ PK: "p", SK: "s", status: "open" }]);
  });
});

describe("fakeDynamo stands in for IAM (api/src/dynamoAccess.ts)", () => {
  const check = { ConditionCheck: { TableName: "t", Key: { PK: "p", SK: "s" }, ConditionExpression: "attribute_exists(#pk)", ExpressionAttributeNames: { "#pk": "PK" } } };

  it("refuses an action the running Lambda isn't granted", async () => {
    const db = new FakeDocClient();
    await expect(asLambda("preSignUp", () => db.send(new QueryCommand({
      TableName: "t", KeyConditionExpression: "#pk = :p", ExpressionAttributeNames: { "#pk": "PK" }, ExpressionAttributeValues: { ":p": "p" },
    })))).rejects.toMatchObject({ name: "AccessDeniedException", message: expect.stringContaining("dynamodb:Query") });
    await expect(asLambda("preSignUp", () => db.send(new GetCommand({ TableName: "t", Key: { PK: "p", SK: "s" } })))).resolves.toBeDefined();
  });

  it("checks each action inside a transaction, and writes nothing when one is refused", async () => {
    const db = new FakeDocClient();
    db.seed({ PK: "p", SK: "s" });
    const tx = new TransactWriteCommand({ TransactItems: [{ Put: { TableName: "t", Item: { PK: "q", SK: "s" } } }, check] });
    await expect(asLambda("preSignUp", () => db.send(tx))).rejects.toMatchObject({ message: expect.stringContaining("dynamodb:PutItem") });
    expect(db.dump()).toHaveLength(1);
    await expect(asLambda("api", () => db.send(tx))).resolves.toEqual({});
  });

  it("checks nothing outside a Lambda (seeding and direct test reads)", async () => {
    const db = new FakeDocClient();
    await expect(db.send(new TransactWriteCommand({ TransactItems: [check] }))).rejects.toMatchObject({ name: "TransactionCanceledException" });
  });
});
