// The Log details form's state, and turning it into an edit. Times are shown and read in the Log's own
// Log zone (so travel never shifts them); the shared rules check Details before anything is sent.
import { DURATION_MAX, DURATION_MIN, checkLogTime, dayOf, isDay, localTime, parseDetails, zonedInstant, type Flag } from "@throne/shared";
import type { Log, LogInput } from "../../api/log";

export interface LogForm {
  day: string;
  time: string;
  /** As typed. */
  duration: string;
  bristolType?: number;
  note: string;
  flags: Flag[];
}

export function formFor(log: Log): LogForm {
  const t = Date.parse(log.instant);
  return {
    day: dayOf(t, log.logZone),
    time: localTime(t, log.logZone),
    duration: log.duration === undefined ? "" : String(log.duration),
    bristolType: log.bristolType,
    note: log.note ?? "",
    flags: [...log.flags],
  };
}

/**
 * The edit to queue, or why not. A moved time is checked against `now` with the server's own rule, so
 * a bad time is caught here, online or offline, instead of coming back later from the outbox.
 */
export function editFor(log: Log, f: LogForm, now = Date.now()): { ok: true; edit: LogInput } | { ok: false; error: string } {
  const duration = f.duration.trim() === "" ? undefined : /^\d+$/.test(f.duration.trim()) ? Number(f.duration) : NaN;
  if (duration !== undefined && Number.isNaN(duration)) return { ok: false, error: `Duration is ${DURATION_MIN} to ${DURATION_MAX} minutes.` };
  const parsed = parseDetails({ duration, bristolType: f.bristolType, note: f.note, flags: f.flags });
  if (!parsed.ok) return parsed;
  const edit: LogInput = { id: log.id, ...parsed.details };
  const was = formFor(log);
  if (f.day !== was.day || f.time !== was.time) {
    if (!isDay(f.day) || !/^\d{2}:\d{2}$/.test(f.time)) return { ok: false, error: "Pick a date and a time." };
    const instant = zonedInstant(f.day, f.time, log.logZone);
    const why = checkLogTime(instant, now);
    if (why) return { ok: false, error: why };
    edit.instant = new Date(instant).toISOString();
  }
  return { ok: true, edit };
}
