// What the screen shows while writes wait in the outbox: the server's Logs with every queued create,
// edit and delete applied on top, in queue order, each touched Log marked pending. And the message for
// a write the server refused. Pure (pending.test.ts).
import { LOG_TOO_OLD, dayOf, localTime } from "@throne/shared";
import { errorText } from "../api/errors";
import type { Log } from "../api/log";
import type { Op } from "./outbox";

export type ShownLog = Log & { pending?: true };

/** Every Detail an edit or create carries (left out = none). */
const detailsOf = (l: { duration?: number; bristolType?: number; note?: string; flags?: Log["flags"] }) => {
  const d: Partial<Log> = { flags: l.flags ?? [] };
  if (l.duration != null) d.duration = l.duration;
  if (l.bristolType != null) d.bristolType = l.bristolType;
  if (l.note != null) d.note = l.note;
  return d as Pick<Log, "flags" | "duration" | "bristolType" | "note">;
};

export function applyPending(server: readonly Log[], ops: readonly Op[]): ShownLog[] {
  const byId = new Map<string, ShownLog>(server.map((l) => [l.id, l]));
  for (const op of ops) {
    if (op.type === "delete") {
      byId.delete(op.id);
    } else if (op.type === "create") {
      const { id, instant } = op.log;
      byId.set(id, { id, instant, logZone: op.zone, day: dayOf(Date.parse(instant), op.zone), ...detailsOf(op.log), pending: true });
    } else {
      const old = byId.get(op.log.id);
      if (!old) continue;
      const instant = op.log.instant ?? old.instant;
      // The Day comes from the Log's own zone, never the current Home zone.
      byId.set(old.id, { id: old.id, instant, logZone: old.logZone, day: dayOf(Date.parse(instant), old.logZone), ...detailsOf(op.log), pending: true });
    }
  }
  return [...byId.values()];
}

/** What to tell the Profile when the server refused a queued write (it has been dropped). */
export function refusedText(op: Op, e: Error): string {
  const why = errorText(e);
  if (op.type === "create" && why === LOG_TOO_OLD) {
    const t = Date.parse(op.log.instant);
    return `Your Log from ${dayOf(t, op.zone)} at ${localTime(t, op.zone)} reached the server more than 7 days later, so it wasn't saved.`;
  }
  const what = { create: "A new Log", update: "A Log edit", delete: "A Log delete" }[op.type];
  return `${what} couldn't be saved: ${why}`;
}
