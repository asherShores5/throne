// Logs (ticket 03). Schema: schema/log.graphql; rules: shared/src/log.ts. Items, all in the owner's
// partition PROFILE#<sub>:
//   LOG#<Day>#<instant ISO>#<id>   the Log. Sorted by Day then instant, so a month is one key range
//                                  (myLogs for the caller, friendLogs for a Friend).
//   LOGID#<id>                     { sk }: finds a Log by its id, and makes a retried create idempotent.
//   LOGDAY#<Day>                   { n }: Logs on that Day, so the 50-a-Day cap holds under races.
// Every write that touches more than one of these is a single transaction.
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  LOGS_PER_DAY_MAX, addDays, checkLogTime, dayOf, isDay, isLogId, logSortKey, logSortKeyRange, parseDetails, parseInstant,
  type Details,
} from "@throne/shared";
import { now } from "../clock";
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
}

/** The widest myLogs range: a 6-week Calendar grid. */
const MAX_RANGE_DAYS = 42;

const idSk = (id: string) => `LOGID#${id}`;
const daySk = (day: string) => `LOGDAY#${day}`;
const CAP_MESSAGE = `${LOGS_PER_DAY_MAX} Logs a Day is the limit.`;

function out(rec: Record<string, unknown>): Log {
  const log: Log = { id: rec.id as string, instant: rec.instant as string, logZone: rec.logZone as string, day: rec.day as string, flags: (rec.flags as Log["flags"]) ?? [] };
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

async function read(pk: string, id: string): Promise<Record<string, unknown> | undefined> {
  const sk = await findSk(pk, id);
  if (!sk) return undefined;
  return (await ddb().send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } }))).Item;
}

const notFound = () => new UserError("NotFound", "No such Log.");

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
    return out(rec);
  } catch (e) {
    const failed = failedConditions(e);
    if (!failed) throw e;
    // A retry (or a second tab) with the same id: the Log already exists, so answer with it unchanged.
    if (failed[0]) {
      const existing = await read(pk, id);
      if (existing) return out(existing);
    }
    if (failed[2]) throw invalid(CAP_MESSAGE);
    throw e;
  }
}

async function updateLog(ctx: Ctx, input: Record<string, unknown>): Promise<Log> {
  const pk = profilePk(ctx.sub);
  const id = logId(input.id);
  const d = details(input);
  const old = await read(pk, id);
  if (!old) throw notFound();
  const instant = instantOf(input.instant, Date.parse(old.instant as string));
  checkTime(instant);
  // The Day comes from the Log's own zone, whatever the Home zone is now.
  const logZone = old.logZone as string;
  const day = dayOf(instant, logZone);
  const sk = logSortKey(day, instant, id);
  const { duration: _d, bristolType: _b, note: _n, flags: _f, ...kept } = old;
  const rec = { ...kept, SK: sk, instant: new Date(instant).toISOString(), day, ...d, updatedAt: now() };
  const exists = { ConditionExpression: "attribute_exists(#pk)", ExpressionAttributeNames: { "#pk": "PK" } };
  try {
    if (sk === old.SK) {
      await ddb().send(new PutCommand({ TableName: TABLE, Item: rec, ...exists }));
      return out(rec);
    }
    const moveDay = day !== old.day;
    await ddb().send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: TABLE, Key: { PK: pk, SK: old.SK }, ...exists } },
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
    return out(rec);
  } catch (e) {
    if (isConditionFailed(e)) throw notFound();
    const failed = failedConditions(e);
    if (!failed) throw e;
    if (failed[3] && !failed[0] && !failed[2]) throw invalid(CAP_MESSAGE);
    // Deleted or edited at the same moment elsewhere.
    throw new UserError("Unavailable", "That Log just changed. Try again.");
  }
}

async function deleteLog(ctx: Ctx, input: Record<string, unknown>): Promise<string> {
  const pk = profilePk(ctx.sub);
  const id = logId(input.id);
  const sk = await findSk(pk, id);
  if (!sk) return id; // already gone (an undo retried), or never this Profile's
  const day = sk.split("#")[1];
  try {
    await ddb().send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: TABLE, Key: { PK: pk, SK: sk } } },
          {
            Delete: {
              TableName: TABLE, Key: { PK: pk, SK: idSk(id) },
              ConditionExpression: "#sk = :sk", ExpressionAttributeNames: { "#sk": "sk" }, ExpressionAttributeValues: { ":sk": sk },
            },
          },
          countDown(pk, day),
        ],
      }),
    );
  } catch (e) {
    if (!failedConditions(e)) throw e;
    // Someone else (another tab) deleted or moved it first.
    if (await findSk(pk, id)) throw new UserError("Unavailable", "That Log just changed. Try again.");
  }
  return id;
}

/** One Profile's Logs on the Days from..to: one key range in their partition (check the caller may see them first). */
async function logsOf(sub: string, from: unknown, to: unknown): Promise<Log[]> {
  if (!isDay(from) || !isDay(to)) throw invalid("from and to are Days (YYYY-MM-DD).");
  if (to < from) throw invalid("to is before from.");
  if (addDays(from, MAX_RANGE_DAYS - 1) < to) throw invalid(`At most ${MAX_RANGE_DAYS} Days at a time.`);
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
  return items.map(out);
}

const friendNotFound = () => new UserError("NotFound", "No such Friend.");

/**
 * A Friend's Logs (ticket 07), all the way back, on the Friend's own Days. Anyone who isn't the caller's
 * Friend right now (yourself, a stranger, an ended Friendship, junk) gets the same NotFound, checked before
 * anything else so not even the range rules answer a stranger.
 */
async function friendLogs(ctx: Ctx, { friend, from, to }: Record<string, unknown>): Promise<Log[]> {
  if (typeof friend !== "string") throw friendNotFound();
  await requireFriend(ctx, friend, friendNotFound);
  return logsOf(friend, from, to);
}

export const log: ResolverModule = {
  Query: {
    myLogs: (ctx, { from, to }) => logsOf(ctx.sub, from, to),
    friendLogs,
  },
  Mutation: {
    createLog: (ctx, { log }) => createLog(ctx, (log ?? {}) as Record<string, unknown>),
    updateLog: (ctx, { log }) => updateLog(ctx, (log ?? {}) as Record<string, unknown>),
    deleteLog,
  },
};
