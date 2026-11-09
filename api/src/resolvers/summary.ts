// The weekly Summary (ticket 10). Schema: schema/summary.graphql; math: shared/src/summary.ts. Items:
//   PROFILE#<sub> / SUMMARY#<weekStart>   { weekStart, weekEnd, createdAt, people: [...], awards: [...] }
// The Notifier's hourly run (api/src/notifier.ts) builds them; the API only reads the caller's own.
// The item is also the run's claim: it's written with attribute_not_exists, and only the run whose write
// lands sends the push, so a repeated run never builds or pushes twice.
//
// A Summary snapshots its people's Display names, Avatars and numbers, so Delete Profile must find every stored
// Summary a Profile appears in, including those of ex-Friends (ticket 11). The claim writes, in one transaction:
//   PROFILE#<person> / INSUMMARY#<owner>#<weekStart>   {}: <person> has a row in <owner>'s Summary of that week
// for every person other than the owner, with a check that nobody in it is being deleted (their DELETED marker).
// scrubFromSummaries(person) then removes their row and their Awards from each one.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { addDays, personWeek, weekAwards, type AwardResult, type PersonWeek, type SummaryWeek, type WeekLog } from "@throne/shared";
import { now } from "../clock";
import { TABLE, ddb, deletedKey, isConditionFailed, profilePk } from "../table";
import { friendIds, profileCard } from "./friend";
import { logItems } from "./log";
import type { ResolverModule } from "./types";

export const SUMMARY_PREFIX = "SUMMARY#";
const summaryKey = (sub: string, weekStart: string) => ({ PK: profilePk(sub), SK: `${SUMMARY_PREFIX}${weekStart}` });
export const IN_SUMMARY_PREFIX = "INSUMMARY#";
const inSummaryKey = (person: string, owner: string, weekStart: string) => ({ PK: profilePk(person), SK: `${IN_SUMMARY_PREFIX}${owner}#${weekStart}` });
/** Tries before giving up when two Profiles in one Summary are deleted at the same moment. */
const SCRUB_TRIES = 5;
/** How many past Summaries `summaries` returns (two years of Mondays). */
const HISTORY_MAX = 104;

interface StoredPerson extends Omit<PersonWeek, "bristolType"> {
  id: string;
  displayName: string;
  emoji: string;
  color: string;
  bristolType?: number;
}

export interface StoredSummary extends SummaryWeek {
  people: StoredPerson[];
  awards: AwardResult[];
}

/** Memo of one person's Logs for a week, shared by every Summary one run builds (Friends overlap). */
export type LogCache = Map<string, Promise<WeekLog[]>>;

/** A person's Logs of the week and the week before (for the change), on their own Days. */
function weekLogs(sub: string, week: SummaryWeek, cache: LogCache): Promise<WeekLog[]> {
  const k = `${sub}|${week.weekStart}`;
  let p = cache.get(k);
  if (!p) {
    p = logItems(sub, addDays(week.weekStart, -7), week.weekEnd).then((items) =>
      items.map((i) => ({ day: i.day as string, instant: i.instant as string, logZone: i.logZone as string, bristolType: i.bristolType as number | undefined })),
    );
    cache.set(k, p);
  }
  return p;
}

/** True if `sub` already has the Summary for the week starting `weekStart`. */
export async function hasSummary(sub: string, weekStart: string): Promise<boolean> {
  return !!(await ddb().send(new GetCommand({ TableName: TABLE, Key: summaryKey(sub, weekStart) }))).Item;
}

/**
 * `sub`'s Summary for the week: them first, then each current Friend, plus the group's Awards. `leaveOut`: Profiles
 * being deleted (claimSummary found their marker), as if they weren't Friends.
 */
export async function buildSummary(sub: string, week: SummaryWeek, cache: LogCache = new Map(), leaveOut: ReadonlySet<string> = new Set()): Promise<StoredSummary> {
  const ids = [sub, ...(await friendIds(sub))].filter((id) => !leaveOut.has(id));
  const found = await Promise.all(ids.map(async (id) => ({ card: await profileCard(id), logs: await weekLogs(id, week, cache) })));
  // A Friend whose Profile is gone (mid-delete) is left out.
  const group = found.flatMap((f) => (f.card ? [{ ...f, card: f.card }] : []));
  const people = group.map(({ card, logs }) => {
    const { bristolType, ...numbers } = personWeek(logs, week);
    return {
      id: card.id, displayName: card.displayName, emoji: card.avatar.emoji, color: card.avatar.color, ...numbers,
      ...(bristolType === null ? {} : { bristolType }),
    };
  });
  return { ...week, people, awards: weekAwards(group.map((g) => ({ id: g.card.id, logs: g.logs })), week) };
}

/**
 * Store the Summary unless it's already there, with a pointer under each other person, refused if anyone in it
 * (the owner too) is being deleted. "stored": this call stored it (and so should push it); "exists": an earlier
 * run did; otherwise the ids of the people being deleted (build again without them).
 */
export async function claimSummary(sub: string, s: StoredSummary): Promise<"stored" | "exists" | string[]> {
  const ids = s.people.map((p) => p.id);
  const others = ids.filter((id) => id !== sub);
  const notDeleted = (id: string) => ({
    ConditionCheck: { TableName: TABLE, Key: deletedKey(id), ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "PK" } },
  });
  const checked = [...new Set([sub, ...ids])];
  try {
    await ddb().send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE,
            Item: { ...summaryKey(sub, s.weekStart), ...s, createdAt: now() },
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "PK" },
          },
        },
        ...others.map((id) => ({ Put: { TableName: TABLE, Item: inSummaryKey(id, sub, s.weekStart) } })),
        ...checked.map(notDeleted),
      ],
    }));
    return "stored";
  } catch (e) {
    const err = e as { name?: string; CancellationReasons?: { Code?: string }[] };
    if (err?.name !== "TransactionCanceledException") throw e;
    const failed = (err.CancellationReasons ?? []).map((r) => r.Code === "ConditionalCheckFailed");
    if (failed[0]) return "exists";
    const gone = checked.filter((_, i) => failed[1 + others.length + i]);
    if (!gone.length) throw e;
    return gone;
  }
}

/**
 * Delete Profile: take `person`'s row and Awards out of every other Profile's stored Summary they're in (an Award
 * they shared stays with the others; one only they held goes). Each pointer is deleted after its Summary is
 * scrubbed, so a stopped run picks up where it was. Writes are conditioned on the Summary's version `sv`, so two
 * people deleted at once both get out.
 */
export async function scrubFromSummaries(person: string): Promise<void> {
  const pk = profilePk(person);
  const pointers: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await ddb().send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :p)",
      ExpressionAttributeNames: { "#pk": "PK", "#sk": "SK" },
      ExpressionAttributeValues: { ":pk": pk, ":p": IN_SUMMARY_PREFIX },
      ExclusiveStartKey: start,
    }));
    pointers.push(...(r.Items ?? []).map((i) => String(i.SK)));
    start = r.LastEvaluatedKey;
  } while (start);

  for (const sk of pointers) {
    const [owner, weekStart] = sk.slice(IN_SUMMARY_PREFIX.length).split("#");
    await scrubOne(owner, weekStart, person);
    await ddb().send(new DeleteCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } }));
  }
}

/**
 * Delete Profile: `owner`'s own Summaries and the pointers to them under the other people in them. Each Summary
 * goes after its pointers, so a stopped run still finds the pointers through it.
 */
export async function forgetOwnSummaries(owner: string): Promise<void> {
  for (;;) {
    const r = await ddb().send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :p)",
      ExpressionAttributeNames: { "#pk": "PK", "#sk": "SK" },
      ExpressionAttributeValues: { ":pk": profilePk(owner), ":p": SUMMARY_PREFIX },
    }));
    const items = r.Items ?? [];
    if (!items.length) return;
    for (const s of items) {
      for (const p of (s.people as StoredPerson[]) ?? []) {
        if (p.id !== owner) await ddb().send(new DeleteCommand({ TableName: TABLE, Key: inSummaryKey(p.id, owner, s.weekStart as string) }));
      }
      await ddb().send(new DeleteCommand({ TableName: TABLE, Key: { PK: s.PK, SK: s.SK } }));
    }
  }
}

async function scrubOne(owner: string, weekStart: string, person: string) {
  for (let i = 0; i < SCRUB_TRIES; i++) {
    const rec = (await ddb().send(new GetCommand({ TableName: TABLE, Key: summaryKey(owner, weekStart) }))).Item;
    if (!rec) return; // the owner was deleted too
    const people = (rec.people as StoredPerson[]) ?? [];
    const awards = (rec.awards as AwardResult[]) ?? [];
    if (!people.some((p) => p.id === person) && !awards.some((a) => a.winners.includes(person))) return;
    const next = {
      ...rec,
      people: people.filter((p) => p.id !== person),
      awards: awards.map((a) => ({ ...a, winners: a.winners.filter((w) => w !== person) })).filter((a) => a.winners.length),
      sv: ((rec.sv as number) ?? 0) + 1,
    };
    try {
      await ddb().send(new PutCommand({
        TableName: TABLE, Item: next,
        ...(rec.sv === undefined
          ? { ConditionExpression: "attribute_exists(#pk) AND attribute_not_exists(#sv)", ExpressionAttributeNames: { "#pk": "PK", "#sv": "sv" } }
          : { ConditionExpression: "#sv = :sv", ExpressionAttributeNames: { "#sv": "sv" }, ExpressionAttributeValues: { ":sv": rec.sv } }),
      }));
      return;
    } catch (e) {
      if (!isConditionFailed(e)) throw e; // changed in between: read again
    }
  }
  throw new Error("Summary kept changing");
}

function out(rec: Record<string, unknown>, viewer: string) {
  return {
    weekStart: rec.weekStart as string,
    weekEnd: rec.weekEnd as string,
    people: ((rec.people as StoredPerson[]) ?? []).map((p) => ({ ...p, me: p.id === viewer, bristolType: p.bristolType ?? null })),
    awards: (rec.awards as AwardResult[]) ?? [],
  };
}

export const summary: ResolverModule = {
  Query: {
    /** The caller's own Summaries, newest first. Never anyone else's: the partition is the caller's sub. */
    async summaries(ctx) {
      const r = await ddb().send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :p)",
        ExpressionAttributeNames: { "#pk": "PK", "#sk": "SK" },
        ExpressionAttributeValues: { ":pk": profilePk(ctx.sub), ":p": SUMMARY_PREFIX },
        ScanIndexForward: false,
        Limit: HISTORY_MAX,
      }));
      return (r.Items ?? []).map((i) => out(i, ctx.sub));
    },
  },
  Mutation: {},
};
