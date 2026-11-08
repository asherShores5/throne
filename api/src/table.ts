// Table layout. One table, keys PK/SK; every partition belongs to one Profile, keyed by its Cognito sub:
//   PROFILE#<sub> / PROFILE    the Profile record (Display name, Avatar, Home zone)
// Later tickets add their items under the same partition (Logs, Friendships, Invites, ...).
//
// Every expression aliases its attribute names (#pk, #status, ...): testing/fakeDynamo.ts refuses a bare
// name, so a DynamoDB reserved word can't slip through to a live ValidationException.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const TABLE = process.env.TABLE_NAME!;

export const profilePk = (sub: string) => `PROFILE#${sub}`;
export const PROFILE_SK = "PROFILE";

export type DocClient = Pick<DynamoDBDocumentClient, "send">;

let client: DocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/** The document client every resolver uses. */
export const ddb = (): DocClient => client;

/** Test seam: swap the document client (see testing/harness.ts). Production never calls this. */
export function setDocClient(c: DocClient) {
  client = c;
}

/** True for a failed condition on a single write (DynamoDB and the fake both name it so). */
export const isConditionFailed = (e: unknown) => (e as { name?: string })?.name === "ConditionalCheckFailedException";
