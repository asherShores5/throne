// Logs (schema/log.graphql). The client makes each Log's id, so a retried create is the same Log.
import type { Comment, Details, Reaction } from "@throne/shared";
import { gql } from "./gql";

export interface Log extends Details {
  id: string;
  /** ISO 8601 UTC. */
  instant: string;
  logZone: string;
  /** YYYY-MM-DD in logZone. */
  day: string;
  /** Only the ones the viewer may see (the owner: all; a Friend: their own). */
  reactions: Reaction[];
  comments: Comment[];
}

/** Depth 3 (myLogs > reactions > author): exactly QUERY_DEPTH_LIMIT. */
export const LOG = `id instant logZone day duration bristolType note flags reactions { author emoji } comments { id author text at }`;

/** What a create or edit sends: the time (optional) and every Detail (left out = none). */
export interface LogInput extends Partial<Details> {
  id: string;
  instant?: string;
}

/** GraphQL drops nulls into the Log as `null`; the shared type uses "absent". */
export function clean(l: Log): Log {
  const out = { ...l } as Record<string, unknown>;
  // A Log saved on the device before Reactions existed has none.
  out.reactions ??= [];
  out.comments ??= [];
  for (const k of ["duration", "bristolType", "note"]) if (out[k] == null) delete out[k];
  return out as unknown as Log;
}

export const newLogId = () => crypto.randomUUID();

export async function createLog(log: LogInput): Promise<Log> {
  const r = await gql<{ createLog: Log }>(`mutation Create($log: NewLog!) { createLog(log: $log) { ${LOG} } }`, { log });
  return clean(r.createLog);
}

export async function updateLog(log: LogInput): Promise<Log> {
  const r = await gql<{ updateLog: Log }>(`mutation Update($log: LogEdit!) { updateLog(log: $log) { ${LOG} } }`, { log });
  return clean(r.updateLog);
}

export async function deleteLog(id: string): Promise<void> {
  await gql(`mutation Delete($id: ID!) { deleteLog(id: $id) }`, { id });
}

/** The signed-in Profile's Logs on the Days from..to (inclusive, at most 42), oldest first. */
export async function myLogs(from: string, to: string): Promise<Log[]> {
  const r = await gql<{ myLogs: Log[] }>(`query Mine($from: String!, $to: String!) { myLogs(from: $from, to: $to) { ${LOG} } }`, { from, to });
  return r.myLogs.map(clean);
}

/** A Friend's Logs on the Days from..to (their own Days). NotFound once they aren't a Friend. Never cached or queued. */
export async function friendLogs(friend: string, from: string, to: string): Promise<Log[]> {
  const r = await gql<{ friendLogs: Log[] }>(
    `query Theirs($friend: ID!, $from: String!, $to: String!) { friendLogs(friend: $friend, from: $from, to: $to) { ${LOG} } }`,
    { friend, from, to },
  );
  return r.friendLogs.map(clean);
}

export { errorText } from "./errors";
