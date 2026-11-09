// Delete Profile (ticket 11). Schema: schema/profile.graphql. The caller permanently deletes themselves; afterwards
// no item anywhere is theirs or names them, except the content-free DELETED marker (table.ts), which DynamoDB's
// TTL removes a day after the Cognito user is gone.
//
// Order (each step is safe to repeat, and a stopped run is finished by calling deleteProfile again; the web app
// does that by itself when any call answers ProfileDeleted):
//   1. the DELETED marker: from here on handler.ts refuses every other call of this Profile, and a Summary claim
//      that includes them is refused (resolvers/summary.ts), so nothing new of theirs can appear;
//   2. the directory entry, so the hourly run stops building their Summary;
//   3. Friend code, Friend requests, Friendships and their Reactions/Comments on Friends' Logs (friend.ts);
//   4. their Invites (invite.ts);
//   5. their rows and Awards in other Profiles' stored Summaries, and their own Summaries with the pointers to
//      them under the people in them (summary.ts);
//   6. the sweep: every item left in their own partition (Profile record and push prefs, Logs with the
//      Reactions/Comments on them, LOGID/LOGDAY, push devices, their own Summaries, pointers, counters). Blind
//      deletes are fine here, against the usual rv rule: no Friendship is left, so no Reaction can land;
//   7. the Cognito user (cognito.ts), then the marker's TTL.
import { DeleteCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { deleteUser } from "../cognito";
import { now } from "../clock";
import { TABLE, ddb, deletedKey, directoryKey, isConditionFailed, profilePk } from "../table";
import { forgetFriendsOf } from "./friend";
import { forgetInvitesOf } from "./invite";
import { forgetOwnSummaries, scrubFromSummaries } from "./summary";
import type { Ctx, ResolverModule } from "./types";

/** How long the marker outlives the Cognito user: longer than any token it issued (1 hour) could be used. */
const MARKER_DAYS = 1;

async function mark(sub: string) {
  try {
    await ddb().send(new PutCommand({
      TableName: TABLE, Item: { ...deletedKey(sub), deletedAt: now() },
      ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "PK" },
    }));
  } catch (e) {
    if (!isConditionFailed(e)) throw e; // a retry: already marked
  }
}

/** Delete every item in `sub`'s partition but the marker. */
async function sweep(sub: string) {
  const marker = deletedKey(sub).SK;
  for (;;) {
    const r = await ddb().send(new QueryCommand({
      TableName: TABLE, KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "PK" }, ExpressionAttributeValues: { ":pk": profilePk(sub) },
    }));
    const left = (r.Items ?? []).filter((i) => i.SK !== marker);
    if (!left.length && !r.LastEvaluatedKey) return;
    for (const i of left) await ddb().send(new DeleteCommand({ TableName: TABLE, Key: { PK: i.PK, SK: i.SK } }));
  }
}

async function deleteProfile(ctx: Ctx): Promise<true> {
  const me = ctx.sub;
  if (!ctx.username) throw new Error("no username in the token");
  await mark(me);
  await ddb().send(new DeleteCommand({ TableName: TABLE, Key: directoryKey(me) }));
  await forgetFriendsOf(me);
  await forgetInvitesOf(me);
  await scrubFromSummaries(me);
  await forgetOwnSummaries(me);
  // Again, for anything that slipped in while the steps above ran (a Friend request accepted at that moment).
  await forgetFriendsOf(me);
  await sweep(me);
  await deleteUser(ctx.username);
  await ddb().send(new UpdateCommand({
    TableName: TABLE, Key: deletedKey(me),
    UpdateExpression: "SET #ttl = :ttl", ConditionExpression: "attribute_exists(#pk)",
    ExpressionAttributeNames: { "#ttl": "ttl", "#pk": "PK" },
    ExpressionAttributeValues: { ":ttl": Math.floor(now() / 1000) + MARKER_DAYS * 86_400 },
  }));
  return true;
}

export const deleteProfileModule: ResolverModule = {
  Query: {},
  Mutation: { deleteProfile: (ctx) => deleteProfile(ctx) },
};
