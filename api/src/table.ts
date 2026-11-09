// Table layout. One table, keys PK/SK; every partition belongs to one Profile, keyed by its Cognito sub:
//   PROFILE#<sub> / PROFILE            the Profile record (Display name, Avatar, Home zone)
//   PROFILE#<sub> / INVITESLOT#<1-3>   one of the Profile's 3 Invite places: { token } of the Invite in it
// Later tickets add their items under the same partition (Logs: resolvers/log.ts; Friend code, Friend
// requests, Friendships: resolvers/friend.ts, which also owns the FRIENDCODE#<code> lookup items).
// The Profile directory, so the Notifier's hourly run can find every Profile without a Scan (ticket 10):
//   PROFILES / PROFILE#<sub>           one per Profile, written with the Profile record (ticket 11 deletes it too)
// Lookup items, found by a secret rather than by Profile:
//   INVITE#<token> / INVITE            the Invite: creator, createdAt, expiresAt, status open|used|revoked
//                                       (the pre-sign-up trigger only has the token)
//
// Every expression aliases its attribute names (#pk, #status, ...): testing/fakeDynamo.ts refuses a bare
// name, so a DynamoDB reserved word can't slip through to a live ValidationException.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const TABLE = process.env.TABLE_NAME!;

export const profilePk = (sub: string) => `PROFILE#${sub}`;
export const PROFILE_SK = "PROFILE";
export const DIRECTORY_PK = "PROFILES";
export const directoryKey = (sub: string) => ({ PK: DIRECTORY_PK, SK: profilePk(sub) });
export const inviteKey = (token: string) => ({ PK: `INVITE#${token}`, SK: "INVITE" });
export const INVITE_SLOT_PREFIX = "INVITESLOT#";

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
