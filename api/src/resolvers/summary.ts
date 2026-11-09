// The weekly Summary (ticket 10). Schema: schema/summary.graphql; math: shared/src/summary.ts. Items:
//   PROFILE#<sub> / SUMMARY#<weekStart>   { weekStart, weekEnd, createdAt, people: [...], awards: [...] }
// The Notifier's hourly run (api/src/notifier.ts) builds them; the API only reads the caller's own.
// The item is also the run's claim: it's written with attribute_not_exists, and only the run whose write
// lands sends the push, so a repeated run never builds or pushes twice.
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { addDays, personWeek, weekAwards, type AwardResult, type PersonWeek, type SummaryWeek, type WeekLog } from "@throne/shared";
import { now } from "../clock";
import { TABLE, ddb, isConditionFailed, profilePk } from "../table";
import { friendIds, profileCard } from "./friend";
import { logItems } from "./log";
import type { ResolverModule } from "./types";

export const SUMMARY_PREFIX = "SUMMARY#";
const summaryKey = (sub: string, weekStart: string) => ({ PK: profilePk(sub), SK: `${SUMMARY_PREFIX}${weekStart}` });
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

/** `sub`'s Summary for the week: them first, then each current Friend, plus the group's Awards. */
export async function buildSummary(sub: string, week: SummaryWeek, cache: LogCache = new Map()): Promise<StoredSummary> {
  const ids = [sub, ...(await friendIds(sub))];
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

/** Store the Summary unless it's already there. True if this call stored it (and so should push it). */
export async function claimSummary(sub: string, s: StoredSummary): Promise<boolean> {
  try {
    await ddb().send(new PutCommand({
      TableName: TABLE,
      Item: { ...summaryKey(sub, s.weekStart), ...s, createdAt: now() },
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeNames: { "#pk": "PK" },
    }));
    return true;
  } catch (e) {
    if (isConditionFailed(e)) return false;
    throw e;
  }
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
