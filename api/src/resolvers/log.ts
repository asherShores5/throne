// Logs (ticket 03). Schema: schema/log.graphql; rules: shared/src/log.ts. Items, all in the owner's
// partition PROFILE#<sub>:
//   LOG#<Day>#<instant ISO>#<id>   the Log. Sorted by Day then instant, so a month is one key range
//                                  (myLogs for the caller, friendLogs for a Friend).
//   LOGID#<id>                     { sk }: finds a Log by its id, and makes a retried create idempotent.
//   LOGDAY#<Day>                   { n }: Logs on that Day, so the 50-a-Day cap holds under races.
// Every write that touches more than one of these is a single transaction.
//
// The Log item also carries its Reactions and Comments (ticket 08, resolvers/reaction.ts) and `rv`, a
// counter they bump. Every write here that replaces or deletes the item is conditioned on `rv`, so it
// can't wipe a Reaction that landed in between (it reads again instead).
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  LOGS_PER_DAY_MAX, addDays, checkLogTime, dayOf, isDay, isLogId, logSortKey, logSortKeyRange, parseDetails, parseInstant,
  visibleResponses, type Comment, type Details, type Reaction,
} from "@throne/shared";
import { now } from "../clock";
import { emit } from "../events";
import { UserError, invalid } from "../errors";
import { TABLE, ddb, isConditionFailed, profilePk } from "../table";
import { requireFriend } from "./friend";
import { ensureProfile } from "./profile";
import type { Ctx, ResolverModule } from "./types";

export interface Log extends Details {
  id: string;
  instant: string;
  logZone: string;
  day: string;
  reactions: Reaction[];
  comments: Comment[];
}

/** The widest myLogs range: a 6-week Calendar grid. */
const MAX_RANGE_DAYS = 42;

/**
 * Under the Log owner's partition, one per (author, Log) the author has a Reaction or Comment on, so ending a
 * Friendship finds them with one key range (resolvers/reaction.ts). Keyed by Log id, which never moves.
 */
export const RESPONSE_POINTER_PREFIX = "RESPFROM#";
export const responsePointerSk = (author: string, logId: string) => `${RESPONSE_POINTER_PREFIX}${author}#${logId}`;

/**
 * The same pair seen from the author's side, in the author's partition (ticket 12): always written and deleted in the
 * same transaction as the RESPFROM pointer, so Delete Profile also finds what the author left on Logs of someone who
 * is no longer their Friend (an endFriendship that stopped half way and was never retried).
 */
export const RESPONSE_TO_PREFIX = "RESPTO#";
export const responseToKey = (author: string, owner: string, logId: string) => ({ PK: profilePk(author), SK: `${RESPONSE_TO_PREFIX}${owner}#${logId}` });

export const idSk = (id: string) => `LOGID#${id}`;
const daySk = (day: string) => `LOGDAY#${day}`;
const CAP_MESSAGE = `${LOGS_PER_DAY_MAX} Logs a Day is the limit.`;

/** A stored Log as `viewer` sees it: every Detail, but only the Reactions and Comments they may see. */
export function out(rec: Record<string, unknown>, viewer: string): Log {
  const owner = String(rec.PK).slice("PROFILE#".length);
  const log: Log = {
    id: rec.id as string, instant: rec.instant as string, logZone: rec.logZone as string, day: rec.day as string,
    flags: (rec.flags as Log["flags"]) ?? [],
    ...visibleResponses(rec, owner, viewer),
  };
  if (rec.duration !== undefined) log.duration = rec.duration as number;
  if (rec.bristolType !== undefined) log.bristolType = rec.bristolType as number;
  if (rec.note !== undefined) log.note = rec.note as string;
  return log;
}

function details(input: Record<string, unknown>): Details {
  const r = parseDetails(input);
  if (!r.ok) throw invalid(r.error);
  return r.details;
}

function instantOf(v: unknown, fallback: number): number {
  if (v == null) return fallback;
  const t = parseInstant(v);
  if (t === undefined) throw invalid("instant must be an ISO 8601 date-time with a zone (e.g. 2026-11-08T17:05:00Z).");
  return t;
}

function checkTime(instant: number) {
  const why = checkLogTime(instant, now());
  if (why) throw invalid(why);
}

function logId(v: unknown): string {
  if (!isLogId(v)) throw invalid("A Log id is a UUID.");
  return v.toLowerCase();
}

/** One more Log on `day`, refused (in the same transaction) when the Day is full. */
const countUp = (pk: string, day: string) => ({
  Update: {
    TableName: TABLE,
    Key: { PK: pk, SK: daySk(day) },
    UpdateExpression: "SET #n = if_not_exists(#n,:zero) + :one",
    ConditionExpression: "attribute_not_exists(#n) OR #n < :cap",
    ExpressionAttributeNames: { "#n": "n" },
    ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":cap": LOGS_PER_DAY_MAX },
  },
});

const countDown = (pk: string, day: string) => ({
  Update: {
    TableName: TABLE,
    Key: { PK: pk, SK: daySk(day) },
    UpdateExpression: "SET #n = #n - :one",
    ConditionExpression: "#n > :zero",
    ExpressionAttributeNames: { "#n": "n" },
    ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
  },
});

/**
 * The condition that the Log's Reactions and Comments are still the ones `rec` read: an expression over
 * `#rv` (name "rv") and its values. Join it to a write's own condition with AND.
 */
export function sameResponses(rec: Record<string, unknown>): { expr: string; values: Record<string, unknown> } {
  return rec.rv === undefined ? { expr: "attribute_not_exists(#rv)", values: {} } : { expr: "#rv = :rv", values: { ":rv": rec.rv } };
}

/** Which actions of a cancelled transaction failed their condition (index-aligned); undefined if it wasn't that. */
function failedConditions(e: unknown): boolean[] | undefined {
  const err = e as { name?: string; CancellationReasons?: { Code?: string }[] };
  if (err?.name !== "TransactionCanceledException") return undefined;
  return (err.CancellationReasons ?? []).map((r) => r.Code === "ConditionalCheckFailed");
}

async function findSk(pk: string, id: string): Promise<string | undefined> {
  const r = await ddb().send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: idSk(id) } }));
  return r.Item?.sk as string | undefined;
}

/** The stored Log with this id in partition `pk`, if any. */
export async function read(pk: string, id: string): Promise<Record<string, unknown> | undefined> {
  const sk = await findSk(pk, id);
  if (!sk) return undefined;
  return (await ddb().send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } }))).Item;
}

const notFound = () => new UserError("NotFound", "No such Log.");

/** Tries before giving up when Reactions or Comments keep landing between our read and our write. */
const RESPONSE_RACE_TRIES = 4;

/** True when the Log is still where `old` was but its Reactions/Comments changed since. */
async function responsesMoved(pk: string, id: string, old: Record<string, unknown>) {
  const cur = await read(pk, id);
  return !!cur && cur.SK === old.SK && cur.rv !== old.rv;
}

/** A condition (`base` AND the Reactions/Comments are unchanged) as expression fields for a write. */
function unchangedSince(old: Record<string, unknown>, base?: string) {
  const same = sameResponses(old);
  return {
    ConditionExpression: base ? `${base} AND ${same.expr}` : same.expr,
    ExpressionAttributeNames: { ...(base ? { "#pk": "PK" } : {}), "#rv": "rv" },
    ...(Object.keys(same.values).length ? { ExpressionAttributeValues: same.values } : {}),
  };
}

async function createLog(ctx: Ctx, input: Record<string, unknown>): Promise<Log> {
  const pk = profilePk(ctx.sub);
  const id = logId(input.id);
  const d = details(input);
  const instant = instantOf(input.instant, now());
  checkTime(instant);
  const { homeZone } = await ensureProfile(ctx, undefined);
  const day = dayOf(instant, homeZone);
  const sk = logSortKey(day, instant, id);
  const at = now();
  const rec = { PK: pk, SK: sk, id, instant: new Date(instant).toISOString(), logZone: homeZone, day, ...d, createdAt: at, updatedAt: at };
  try {
    await ddb().send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: TABLE, Item: { PK: pk, SK: idSk(id), sk }, ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "PK" } } },
          { Put: { TableName: TABLE, Item: rec } },
          countUp(pk, day),
        ],
      }),
    );
  } catch (e) {
    const failed = failedConditions(e);
    if (!failed) throw e;
    // A retry (or a second tab) with the same id: the Log already exists, so answer with it unchanged.
    if (failed[0]) {
      const existing = await read(pk, id);
      if (existing) return out(existing, ctx.sub);
    }
    if (failed[2]) throw invalid(CAP_MESSAGE);
    throw e;
  }
  // Friends who follow me get "<name> logged" (ids only; the Notifier never sees the Details).
  await emit({ kind: "friendLogged", from: ctx.sub, logId: id, day });
  return out(rec, ctx.sub);
}

async function updateLog(ctx: Ctx, input: Record<string, unknown>): Promise<Log> {
  const pk = profilePk(ctx.sub);
  const id = logId(input.id);
  const d = details(input);
  for (let attempt = 1; ; attempt++) {
    const old = await read(pk, id);
    if (!old) throw notFound();
    const instant = instantOf(input.instant, Date.parse(old.instant as string));
    checkTime(instant);
    // The Day comes from the Log's own zone, whatever the Home zone is now.
    const logZone = old.logZone as string;
    const day = dayOf(instant, logZone);
    const sk = logSortKey(day, instant, id);
    // Everything else on the item (Reactions, Comments, rv) moves with it.
    const { duration: _d, bristolType: _b, note: _n, flags: _f, ...kept } = old;
    const rec = { ...kept, SK: sk, instant: new Date(instant).toISOString(), day, ...d, updatedAt: now() };
    const unchanged = unchangedSince(old, "attribute_exists(#pk)");
    try {
      if (sk === old.SK) {
        await ddb().send(new PutCommand({ TableName: TABLE, Item: rec, ...unchanged }));
        return out(rec, ctx.sub);
      }
      const moveDay = day !== old.day;
      await ddb().send(
        new TransactWriteCommand({
          TransactItems: [
            { Delete: { TableName: TABLE, Key: { PK: pk, SK: old.SK }, ...unchanged } },
            { Put: { TableName: TABLE, Item: rec } },
            {
              Put: {
                TableName: TABLE, Item: { PK: pk, SK: idSk(id), sk },
                ConditionExpression: "#sk = :old", ExpressionAttributeNames: { "#sk": "sk" }, ExpressionAttributeValues: { ":old": old.SK },
              },
            },
            ...(moveDay ? [countUp(pk, day), countDown(pk, old.day as string)] : []),
          ],
        }),
      );
      return out(rec, ctx.sub);
    } catch (e) {
      const failed = failedConditions(e);
      if (!failed && !isConditionFailed(e)) throw e;
      // A Friend reacted or commented in between: read again so theirs is kept.
      if (attempt < RESPONSE_RACE_TRIES && (await responsesMoved(pk, id, old))) continue;
      if (!failed) throw notFound();
      if (failed[3] && !failed[0] && !failed[2]) throw invalid(CAP_MESSAGE);
      // Deleted or edited at the same moment elsewhere.
      throw new UserError("Unavailable", "That Log just changed. Try again.");
    }
  }
}

/** Every Profile with a Reaction or Comment on the Log (their RESPFROM# pointers go with it). */
function responders(rec: Record<string, unknown>): string[] {
  const reactions = Object.keys((rec.reactions as Record<string, string> | undefined) ?? {});
  const commenters = ((rec.comments as Comment[] | undefined) ?? []).map((c) => c.author);
  return [...new Set([...reactions, ...commenters])];
}

/**
 * Deleting a Log deletes its Reactions and Comments (they're on the item) and their pointers in the same
 * transaction, so there's nothing left to clean up and a retried delete (the outbox's too) is a no-op.
 */
async function deleteLog(ctx: Ctx, input: Record<string, unknown>): Promise<string> {
  const pk = profilePk(ctx.sub);
  const id = logId(input.id);
  for (let attempt = 1; ; attempt++) {
    const rec = await read(pk, id);
    if (!rec) return id; // already gone (an undo retried), or never this Profile's
    const sk = rec.SK as string;
    try {
      await ddb().send(
        new TransactWriteCommand({
          TransactItems: [
            { Delete: { TableName: TABLE, Key: { PK: pk, SK: sk }, ...unchangedSince(rec) } },
            {
              Delete: {
                TableName: TABLE, Key: { PK: pk, SK: idSk(id) },
                ConditionExpression: "#sk = :sk", ExpressionAttributeNames: { "#sk": "sk" }, ExpressionAttributeValues: { ":sk": sk },
              },
            },
            countDown(pk, rec.day as string),
            ...responders(rec).flatMap((author) => [
              { Delete: { TableName: TABLE, Key: { PK: pk, SK: responsePointerSk(author, id) } } },
              { Delete: { TableName: TABLE, Key: responseToKey(author, ctx.sub, id) } },
            ]),
          ],
        }),
      );
      return id;
    } catch (e) {
      if (!failedConditions(e)) throw e;
      if (attempt < RESPONSE_RACE_TRIES && (await responsesMoved(pk, id, rec))) continue;
      // Someone else (another tab) deleted or moved it first.
      if (await findSk(pk, id)) throw new UserError("Unavailable", "That Log just changed. Try again.");
      return id;
    }
  }
}

/** One Profile's Logs on the Days from..to as `viewer` sees them (check the caller may see them first). */
async function logsOf(sub: string, from: unknown, to: unknown, viewer: string): Promise<Log[]> {
  if (!isDay(from) || !isDay(to)) throw invalid("from and to are Days (YYYY-MM-DD).");
  if (to < from) throw invalid("to is before from.");
  if (addDays(from, MAX_RANGE_DAYS - 1) < to) throw invalid(`At most ${MAX_RANGE_DAYS} Days at a time.`);
  return (await logItems(sub, from, to)).map((rec) => out(rec, viewer));
}

/** The stored Log items of `sub` on the Days from..to, in order (no access check: callers check first). */
export async function logItems(sub: string, from: string, to: string): Promise<Record<string, unknown>[]> {
  const range = logSortKeyRange(from, to);
  const items: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await ddb().send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :from AND :to",
        ExpressionAttributeNames: { "#pk": "PK", "#sk": "SK" },
        ExpressionAttributeValues: { ":pk": profilePk(sub), ":from": range.from, ":to": range.to },
        ExclusiveStartKey: start,
      }),
    );
    items.push(...(r.Items ?? []));
    start = r.LastEvaluatedKey;
  } while (start);
  return items;
}

const friendNotFound = () => new UserError("NotFound", "No such Friend.");

/**
 * A Friend's Logs (ticket 07), all the way back, on the Friend's own Days. Anyone who isn't the caller's
 * Friend right now (yourself, a stranger, an ended Friendship, junk) gets the same NotFound, checked before
 * anything else so not even the range rules answer a stranger. Reactions and Comments: only the caller's.
 */
async function friendLogs(ctx: Ctx, { friend, from, to }: Record<string, unknown>): Promise<Log[]> {
  if (typeof friend !== "string" || !friend || friend.length > 128) throw friendNotFound();
  await requireFriend(ctx, friend, friendNotFound);
  return logsOf(friend, from, to, ctx.sub);
}

export const log: ResolverModule = {
  Query: {
    myLogs: (ctx, { from, to }) => logsOf(ctx.sub, from, to, ctx.sub),
    friendLogs,
  },
  Mutation: {
    createLog: (ctx, { log }) => createLog(ctx, (log ?? {}) as Record<string, unknown>),
    updateLog: (ctx, { log }) => updateLog(ctx, (log ?? {}) as Record<string, unknown>),
    deleteLog,
  },
};
