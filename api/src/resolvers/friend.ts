// Friends (ticket 06). Schema: schema/friend.graphql; rules: shared/src/friend.ts. Items:
//   FRIENDCODE#<code> / FRIENDCODE       { owner }: who has that Friend code (unique by conditional put)
//   PROFILE#<sub> / FRIENDCODE           { code }: the Profile's current code
//   PROFILE#<sub> / FRIEND#<other>       { since }: one side of a Friendship (the other side mirrors it)
//   PROFILE#<sub> / FRIENDCOUNT          { n }: Friends now, so the cap of 3 holds under races
//   PROFILE#<to> / FRIENDREQ#IN#<from>   { sentAt }: a Friend request waiting for <to>
//   PROFILE#<from> / FRIENDREQ#OUT#<to>  { code, sentAt }: the same request, as its sender sees it
//   PROFILE#<sub> / FRIENDSENDS          { times, v }: send times in the last 24 hours (the daily limit)
//
// Accepting writes both FRIEND# items, bumps both counts under a condition that each stays at or below
// 3, and deletes the request items, all in one transaction. Ending a Friendship deletes both sides and
// drops both counts in one transaction.
//
// Reading another Profile's anything goes through isFriend(caller, other): one GetItem on the caller's
// own partition (ticket 07's Friend Calendar, 08's Reactions, 10's Summary).
import { randomBytes } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  FRIEND_REQUESTS_PER_WINDOW, MAX_FRIENDS, formatFriendCode, friendCodeFrom, parseFriendCode, sendsInWindow, type Avatar,
} from "@throne/shared";
import { now } from "../clock";
import { clearResponses } from "./reaction";
import { UserError, invalid } from "../errors";
import { PROFILE_SK, TABLE, ddb, isConditionFailed, profilePk } from "../table";
import type { Ctx, ResolverModule } from "./types";

export const FRIEND_PREFIX = "FRIEND#";
const IN_PREFIX = "FRIENDREQ#IN#";
const OUT_PREFIX = "FRIENDREQ#OUT#";

const codeKey = (code: string) => ({ PK: `FRIENDCODE#${code}`, SK: "FRIENDCODE" });
const myCodeKey = (sub: string) => ({ PK: profilePk(sub), SK: "FRIENDCODE" });
const friendKey = (sub: string, other: string) => ({ PK: profilePk(sub), SK: `${FRIEND_PREFIX}${other}` });
const countKey = (sub: string) => ({ PK: profilePk(sub), SK: "FRIENDCOUNT" });
const inKey = (to: string, from: string) => ({ PK: profilePk(to), SK: `${IN_PREFIX}${from}` });
const outKey = (from: string, to: string) => ({ PK: profilePk(from), SK: `${OUT_PREFIX}${to}` });
const sendsKey = (sub: string) => ({ PK: profilePk(sub), SK: "FRIENDSENDS" });

const PK_NAME = { "#pk": "PK" };
const notExists = { ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: PK_NAME };
const exists = { ConditionExpression: "attribute_exists(#pk)", ExpressionAttributeNames: PK_NAME };
const iso = (ms: number) => new Date(ms).toISOString();

const codeNotFound = () => new UserError("NotFound", "No Profile has that Friend code.");
const requestNotFound = () => new UserError("NotFound", "No such Friend request.");
const YOU_FULL = `You already have ${MAX_FRIENDS} Friends.`;
const THEY_FULL = `They already have ${MAX_FRIENDS} Friends.`;

/** Which actions of a cancelled transaction failed their condition (index-aligned); undefined if it wasn't that. */
function failedConditions(e: unknown): boolean[] | undefined {
  const err = e as { name?: string; CancellationReasons?: { Code?: string }[] };
  if (err?.name !== "TransactionCanceledException") return undefined;
  return (err.CancellationReasons ?? []).map((r) => r.Code === "ConditionalCheckFailed");
}

async function get(key: { PK: string; SK: string }) {
  return (await ddb().send(new GetCommand({ TableName: TABLE, Key: key }))).Item;
}

async function query(sub: string, prefix: string) {
  const r = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :p)",
      ExpressionAttributeNames: { "#pk": "PK", "#sk": "SK" },
      ExpressionAttributeValues: { ":pk": profilePk(sub), ":p": prefix },
    }),
  );
  return (r.Items ?? []).map((i) => ({ other: String(i.SK).slice(prefix.length), item: i }));
}

/** A Profile id from the arguments (another Profile, never the caller); anything else is not found. */
function otherId(v: unknown, notFound: () => UserError): string {
  if (typeof v !== "string" || !v || v.length > 128) throw notFound();
  return v;
}

// ---- for later tickets ------------------------------------------------------

/** True when `sub` and `other` are Friends. One GetItem in `sub`'s own partition. */
export async function isFriend(sub: string, other: string): Promise<boolean> {
  if (sub === other) return false;
  return !!(await get(friendKey(sub, other)));
}

/**
 * For any read of another Profile's data: returns if the caller is that Profile's Friend, else throws
 * `notFound` (the same error the resolver gives for something that doesn't exist, so nothing leaks).
 */
export async function requireFriend(ctx: Ctx, other: string, notFound: () => UserError): Promise<void> {
  if (!(await isFriend(ctx.sub, other))) throw notFound();
}

/** The Profile ids of `sub`'s Friends (e.g. for the Summary). */
export async function friendIds(sub: string): Promise<string[]> {
  return (await query(sub, FRIEND_PREFIX)).map((f) => f.other);
}

/** What a Friend (or a Friend request's receiver) may see of a Profile. Undefined if it's gone. */
export async function profileCard(sub: string): Promise<{ id: string; displayName: string; avatar: Avatar } | undefined> {
  const p = await get({ PK: profilePk(sub), SK: PROFILE_SK });
  return p && { id: sub, displayName: p.displayName as string, avatar: p.avatar as Avatar };
}

// ---- Friend code ------------------------------------------------------------

let codeBytes: (() => Iterable<number>) | undefined;
/** Test seam: where new codes get their bytes (undefined = crypto). */
export function setFriendCodeBytes(fn: (() => Iterable<number>) | undefined) {
  codeBytes = fn;
}

function newCode(): string {
  for (;;) {
    const c = friendCodeFrom(codeBytes ? codeBytes() : randomBytes(16));
    if (c) return c;
  }
}

const COLLISION_TRIES = 5;

/** The caller's code, made on first use. Two first calls at once still leave one code. */
async function ensureCode(sub: string): Promise<string> {
  for (let i = 0; i < COLLISION_TRIES; i++) {
    const have = await get(myCodeKey(sub));
    if (have) return have.code as string;
    const code = newCode();
    try {
      await ddb().send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: TABLE, Item: { ...codeKey(code), owner: sub }, ...notExists } },
            { Put: { TableName: TABLE, Item: { ...myCodeKey(sub), code }, ...notExists } },
          ],
        }),
      );
      return code;
    } catch (e) {
      // A collision (someone has that code) or another call made one first: either way, look again.
      if (!failedConditions(e)) throw e;
    }
  }
  throw new UserError("Unavailable", "Couldn't make a Friend code. Try again.");
}

async function regenerate(sub: string): Promise<string> {
  for (let i = 0; i < COLLISION_TRIES; i++) {
    const old = await ensureCode(sub);
    const code = newCode();
    if (code === old) continue;
    try {
      await ddb().send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: TABLE, Key: codeKey(old), ConditionExpression: "#owner = :me",
                ExpressionAttributeNames: { "#owner": "owner" }, ExpressionAttributeValues: { ":me": sub },
              },
            },
            { Put: { TableName: TABLE, Item: { ...codeKey(code), owner: sub }, ...notExists } },
            {
              Put: {
                TableName: TABLE, Item: { ...myCodeKey(sub), code }, ConditionExpression: "#code = :old",
                ExpressionAttributeNames: { "#code": "code" }, ExpressionAttributeValues: { ":old": old },
              },
            },
          ],
        }),
      );
      return code;
    } catch (e) {
      if (!failedConditions(e)) throw e; // a collision, or a regenerate elsewhere at once: go again
    }
  }
  throw new UserError("Unavailable", "Couldn't make a Friend code. Try again.");
}

async function ownerOf(code: string): Promise<string | undefined> {
  return (await get(codeKey(code)))?.owner as string | undefined;
}

// ---- Friend requests --------------------------------------------------------

/** Count one send against the daily limit (every well-formed attempt counts, found or not). */
async function spendSend(sub: string) {
  for (let i = 0; i < FRIEND_REQUESTS_PER_WINDOW + 5; i++) {
    const t = now();
    const rec = await get(sendsKey(sub));
    const times = sendsInWindow((rec?.times as number[] | undefined) ?? [], t);
    if (times.length >= FRIEND_REQUESTS_PER_WINDOW) throw invalid(`You can send ${FRIEND_REQUESTS_PER_WINDOW} Friend requests a day.`);
    const v = (rec?.v as number | undefined) ?? 0;
    try {
      await ddb().send(
        new PutCommand({
          TableName: TABLE,
          Item: { ...sendsKey(sub), times: [...times, t], v: v + 1 },
          ...(rec
            ? { ConditionExpression: "#v = :v", ExpressionAttributeNames: { "#v": "v" }, ExpressionAttributeValues: { ":v": v } }
            : notExists),
        }),
      );
      return;
    } catch (e) {
      if (!isConditionFailed(e)) throw e; // another send at once: re-read and count again
    }
  }
  throw new UserError("Unavailable", "Too many Friend requests at once. Try again.");
}

const friendCount = async (sub: string) => ((await get(countKey(sub)))?.n as number | undefined) ?? 0;

const countUp = (sub: string) => ({
  Update: {
    TableName: TABLE,
    Key: countKey(sub),
    UpdateExpression: "SET #n = if_not_exists(#n,:zero) + :one",
    ConditionExpression: "attribute_not_exists(#n) OR #n < :cap",
    ExpressionAttributeNames: { "#n": "n" },
    ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":cap": MAX_FRIENDS },
  },
});

const countDown = (sub: string) => ({
  Update: {
    TableName: TABLE,
    Key: countKey(sub),
    UpdateExpression: "SET #n = #n - :one",
    ConditionExpression: "#n > :zero",
    ExpressionAttributeNames: { "#n": "n" },
    ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
  },
});

/** Every request item between two Profiles, both ways (crossing requests leave two pairs). */
const clearRequests = (a: string, b: string) => [inKey(b, a), outKey(a, b), inKey(a, b), outKey(b, a)].map((Key) => ({ Delete: { TableName: TABLE, Key } }));

/**
 * `me` accepts the Friend request `sender` sent: one transaction writes both Friendship sides and bumps
 * both counts (each refused past 3) and clears the requests. Already Friends (a crossing auto-accept
 * won first) counts as done.
 */
async function befriend(me: string, sender: string): Promise<void> {
  const since = now();
  const [mustHaveRequest, ...otherClears] = clearRequests(sender, me); // first: inKey(me, sender)
  try {
    await ddb().send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { ...mustHaveRequest.Delete, ...exists } },
          ...otherClears,
          { Put: { TableName: TABLE, Item: { ...friendKey(me, sender), since }, ...notExists } },
          { Put: { TableName: TABLE, Item: { ...friendKey(sender, me), since }, ...notExists } },
          countUp(me),
          countUp(sender),
        ],
      }),
    );
  } catch (e) {
    const failed = failedConditions(e);
    if (!failed) throw e;
    if (failed[4] || failed[5]) return;
    if (failed[0]) throw requestNotFound();
    if (failed[6]) throw invalid(YOU_FULL);
    if (failed[7]) throw invalid(THEY_FULL);
    throw e;
  }
}

async function friendOut(me: string, other: string) {
  const [card, side] = await Promise.all([profileCard(other), get(friendKey(me, other))]);
  if (!card || !side) throw requestNotFound();
  return { ...card, since: iso(side.since as number) };
}

async function sendRequest(ctx: Ctx, typed: unknown): Promise<"SENT" | "FRIENDS"> {
  const code = parseFriendCode(typed);
  if (!code) throw codeNotFound(); // can't be anyone's: not counted, nothing to guess
  await spendSend(ctx.sub);
  const to = await ownerOf(code);
  // A bad code, your own code and an existing Friend's code look the same.
  if (!to || to === ctx.sub || (await isFriend(ctx.sub, to)) || !(await profileCard(to))) throw codeNotFound();
  if ((await friendCount(ctx.sub)) >= MAX_FRIENDS) throw invalid(YOU_FULL);
  if ((await friendCount(to)) >= MAX_FRIENDS) throw invalid(THEY_FULL);
  // They already asked you: that's a yes from both.
  if (await get(inKey(ctx.sub, to))) {
    await befriend(ctx.sub, to);
    return "FRIENDS";
  }
  const sentAt = now();
  try {
    await ddb().send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: TABLE, Item: { ...inKey(to, ctx.sub), sentAt }, ...notExists } },
          { Put: { TableName: TABLE, Item: { ...outKey(ctx.sub, to), code, sentAt }, ...notExists } },
        ],
      }),
    );
  } catch (e) {
    if (!failedConditions(e)) throw e; // already sent: the first request stands
  }
  // They sent one at the same moment: finish it now rather than leave two waiting.
  if (await get(inKey(ctx.sub, to))) {
    await befriend(ctx.sub, to);
    return "FRIENDS";
  }
  return "SENT";
}

async function deleteAll(keys: { PK: string; SK: string }[]) {
  await ddb().send(new TransactWriteCommand({ TransactItems: keys.map((Key) => ({ Delete: { TableName: TABLE, Key } })) }));
}

async function endFriendship(me: string, other: string): Promise<true> {
  try {
    await ddb().send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: TABLE, Key: friendKey(me, other), ...exists } },
          { Delete: { TableName: TABLE, Key: friendKey(other, me), ...exists } },
          countDown(me),
          countDown(other),
        ],
      }),
    );
  } catch (e) {
    const failed = failedConditions(e);
    if (!failed) throw e;
    // failed[0]: already over (a retry, or the other side ended it first). Still run the cleanup below:
    // a retry may be finishing one that stopped half way.
    if (!failed[0]) throw e;
  }
  // Every Reaction and Comment either left on the other's Logs. Nothing new can land now (each write checks
  // the Friendship in its transaction), and each step is safe to repeat. Ticket 11's Profile delete reuses it.
  await Promise.all([clearResponses(me, other), clearResponses(other, me)]);
  return true;
}

const bySentAt = (a: { sentAt: number }, b: { sentAt: number }) => a.sentAt - b.sentAt;

export const friend: ResolverModule = {
  Query: {
    async myFriendCode(ctx) {
      return formatFriendCode(await ensureCode(ctx.sub));
    },

    async friends(ctx) {
      const sides = (await query(ctx.sub, FRIEND_PREFIX)).sort((a, b) => (a.item.since as number) - (b.item.since as number));
      const cards = await Promise.all(sides.map((s) => profileCard(s.other)));
      return sides.flatMap((s, i) => (cards[i] ? [{ ...cards[i], since: iso(s.item.since as number) }] : []));
    },

    async friendRequests(ctx) {
      const reqs = (await query(ctx.sub, IN_PREFIX)).map((r) => ({ other: r.other, sentAt: r.item.sentAt as number })).sort(bySentAt);
      const cards = await Promise.all(reqs.map((r) => profileCard(r.other)));
      return reqs.flatMap((r, i) => (cards[i] ? [{ ...cards[i], sentAt: iso(r.sentAt) }] : []));
    },

    async sentFriendRequests(ctx) {
      return (await query(ctx.sub, OUT_PREFIX))
        .map((r) => ({ id: r.other, code: formatFriendCode(r.item.code as string), sentAt: r.item.sentAt as number }))
        .sort(bySentAt)
        .map((r) => ({ ...r, sentAt: iso(r.sentAt) }));
    },
  },
  Mutation: {
    async regenerateFriendCode(ctx) {
      return formatFriendCode(await regenerate(ctx.sub));
    },

    async sendFriendRequest(ctx, { code }) {
      return sendRequest(ctx, code);
    },

    async acceptFriendRequest(ctx, { from }) {
      const sender = otherId(from, requestNotFound);
      if (sender === ctx.sub) throw requestNotFound();
      await befriend(ctx.sub, sender);
      return friendOut(ctx.sub, sender);
    },

    async declineFriendRequest(ctx, { from }) {
      const sender = otherId(from, requestNotFound);
      await deleteAll([inKey(ctx.sub, sender), outKey(sender, ctx.sub)]);
      return true;
    },

    async cancelFriendRequest(ctx, { to }) {
      const receiver = otherId(to, requestNotFound);
      await deleteAll([outKey(ctx.sub, receiver), inKey(receiver, ctx.sub)]);
      return true;
    },

    async endFriendship(ctx, { friend: other }) {
      const id = otherId(other, () => new UserError("NotFound", "No such Friend."));
      if (id === ctx.sub) return true;
      return endFriendship(ctx.sub, id);
    },
  },
};
