// Which DynamoDB actions each Lambda may use on the table: the single list both sides check against.
//  - infra/lib/stacks.ts grants exactly these (infra/test/iam.test.ts asserts the synthesized policy equals this,
//    and that each action really appears in that Lambda's bundle, so nothing unused is granted).
//  - testing/fakeDynamo.ts refuses, like IAM would, any action outside the list for the Lambda that is running
//    (the harness says which), including each action inside a transaction. A code path that needs a new action
//    fails its test until the action is added here, and then infra grants it.
// Kept free of imports so infra can read it.

export type DynamoAction =
  | "GetItem" | "PutItem" | "UpdateItem" | "DeleteItem" | "Query" | "Scan" | "ConditionCheckItem" | "BatchGetItem" | "BatchWriteItem";

export const DYNAMO_ACCESS = {
  /** The AppSync resolver Lambda (handler.ts). */
  api: ["GetItem", "PutItem", "UpdateItem", "DeleteItem", "Query", "ConditionCheckItem"],
  /** The Notifier (notifier.ts): pushes and the hourly Summary run. Put + ConditionCheck are for the Summary claim. */
  notifier: ["GetItem", "Query", "DeleteItem", "PutItem", "ConditionCheckItem"],
  /** The Cognito pre-sign-up trigger (preSignUp.ts): read the Invite, then spend it. */
  preSignUp: ["GetItem", "UpdateItem"],
} as const satisfies Record<string, readonly DynamoAction[]>;

export type LambdaName = keyof typeof DYNAMO_ACCESS;

/** The IAM action a document-client command name (or a transaction item kind) needs. */
export const ACTION_OF: Record<string, DynamoAction> = {
  GetCommand: "GetItem",
  PutCommand: "PutItem",
  UpdateCommand: "UpdateItem",
  DeleteCommand: "DeleteItem",
  QueryCommand: "Query",
  ScanCommand: "Scan",
  BatchGetCommand: "BatchGetItem",
  BatchWriteCommand: "BatchWriteItem",
  // TransactWriteItems is authorized per item, by the item's own action.
  Put: "PutItem",
  Update: "UpdateItem",
  Delete: "DeleteItem",
  ConditionCheck: "ConditionCheckItem",
};
