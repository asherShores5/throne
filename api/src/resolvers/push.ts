// Push preferences and device subscriptions (ticket 09). Schema: schema/push.graphql; rules: shared/src/push.ts.
// Items, in the caller's partition:
//   PROFILE#<sub> / PROFILE           `pushPrefs` {summary, friendRequests, reactionsComments} on the Profile
//                                     record. A Profile without it has the defaults (Summary on, rest off).
//   PROFILE#<sub> / FRIEND#<other>    `notifyLogs`: "Friend logged" for that Friend (resolvers/friend.ts), so
//                                     ending the Friendship unfollows with no extra step.
//   PROFILE#<sub> / PUSH#<deviceId>   { endpoint, p256dh, auth, createdAt }: one device's Web Push
//                                     subscription. Keyed by the caller's sub, so nobody touches another's;
//                                     the Notifier deletes it when the push service says it's gone.
// The Notifier (api/src/notifier.ts) reads all three; this module only writes them.
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PUSH_DEVICES_MAX, isDeviceId, parsePushPrefsInput, parsePushSubscription, readPushPrefs, type PushPrefs } from "@throne/shared";
import { now } from "../clock";
import { invalid } from "../errors";
import { PROFILE_SK, TABLE, ddb, profilePk, queryPrefix } from "../table";
import { followedBy, friendIds, setFollow } from "./friend";
import { ensureProfile } from "./profile";
import type { Ctx, ResolverModule } from "./types";

export const PUSH_PREFIX = "PUSH#";
export const pushKey = (sub: string, deviceId: string) => ({ PK: profilePk(sub), SK: `${PUSH_PREFIX}${deviceId}` });

/** The stored toggles of `sub` (defaults if none). */
export async function pushToggles(sub: string) {
  const r = await ddb().send(new GetCommand({ TableName: TABLE, Key: { PK: profilePk(sub), SK: PROFILE_SK } }));
  return readPushPrefs(r.Item?.pushPrefs);
}

async function prefsOf(sub: string): Promise<PushPrefs> {
  const [toggles, friendLogged] = await Promise.all([pushToggles(sub), followedBy(sub)]);
  return { ...toggles, friendLogged };
}

async function updatePushPrefs(ctx: Ctx, input: unknown): Promise<PushPrefs> {
  const edit = parsePushPrefsInput(input);
  if (!edit.ok) throw invalid(edit.error);
  await ensureProfile(ctx, undefined);
  if (Object.keys(edit.toggles).length) {
    // Read-merge-write: only this Profile writes its prefs, and the newest toggle wins.
    const next = { ...(await pushToggles(ctx.sub)), ...edit.toggles };
    await ddb().send(new UpdateCommand({
      TableName: TABLE, Key: { PK: profilePk(ctx.sub), SK: PROFILE_SK },
      UpdateExpression: "SET #pp = :pp", ConditionExpression: "attribute_exists(#pk)",
      ExpressionAttributeNames: { "#pp": "pushPrefs", "#pk": "PK" }, ExpressionAttributeValues: { ":pp": next },
    }));
  }
  if (edit.friendLogged) {
    const want = new Set(edit.friendLogged);
    // Only current Friends can be followed; any other id is left out (as if it weren't sent).
    await Promise.all((await friendIds(ctx.sub)).map((f) => setFollow(ctx.sub, f, want.has(f))));
  }
  return prefsOf(ctx.sub);
}

async function deviceCount(sub: string): Promise<number> {
  return (await queryPrefix(profilePk(sub), PUSH_PREFIX)).length;
}

async function putPushSubscription(ctx: Ctx, input: unknown) {
  let sub;
  try {
    sub = parsePushSubscription(input);
  } catch {
    throw invalid("That isn't a push subscription this app can use.");
  }
  const key = pushKey(ctx.sub, sub.deviceId);
  // Re-saving a device always works (a new endpoint, same phone); a new one only under the cap.
  const have = (await ddb().send(new GetCommand({ TableName: TABLE, Key: key }))).Item;
  if (!have && (await deviceCount(ctx.sub)) >= PUSH_DEVICES_MAX) {
    throw invalid(`At most ${PUSH_DEVICES_MAX} devices can get pushes. Turn push off on one you don't use.`);
  }
  await ddb().send(new PutCommand({
    TableName: TABLE,
    Item: { ...key, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, createdAt: now() },
  }));
  return { deviceId: sub.deviceId, enabled: true };
}

async function deletePushSubscription(ctx: Ctx, deviceId: unknown) {
  if (!isDeviceId(deviceId)) throw invalid("A device id is a UUID.");
  const id = deviceId.toLowerCase();
  await ddb().send(new DeleteCommand({ TableName: TABLE, Key: pushKey(ctx.sub, id) }));
  return { deviceId: id, enabled: false };
}

export const push: ResolverModule = {
  Query: {
    async pushPrefs(ctx) {
      return prefsOf(ctx.sub);
    },
  },
  Mutation: {
    async updatePushPrefs(ctx, { input }) {
      return updatePushPrefs(ctx, input);
    },
    async putPushSubscription(ctx, { input }) {
      return putPushSubscription(ctx, input);
    },
    async deletePushSubscription(ctx, { deviceId }) {
      return deletePushSubscription(ctx, deviceId);
    },
  },
};
