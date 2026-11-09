// The Log details form's state, and turning it into an edit. Times are shown and read in the Log's own
// Log zone (so travel never shifts them); the shared rules check Details before anything is sent.
import { DURATION_MAX, DURATION_MIN, dayOf, isDay, localTime, parseDetails, zonedInstant, type Flag } from "@throne/shared";
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

export function editFor(log: Log, f: LogForm): { ok: true; edit: LogInput } | { ok: false; error: string } {
  const duration = f.duration.trim() === "" ? undefined : /^\d+$/.test(f.duration.trim()) ? Number(f.duration) : NaN;
  if (duration !== undefined && Number.isNaN(duration)) return { ok: false, error: `Duration is ${DURATION_MIN} to ${DURATION_MAX} minutes.` };
  const parsed = parseDetails({ duration, bristolType: f.bristolType, note: f.note, flags: f.flags });
  if (!parsed.ok) return parsed;
  const edit: LogInput = { id: log.id, ...parsed.details };
  const was = formFor(log);
  if (f.day !== was.day || f.time !== was.time) {
    if (!isDay(f.day) || !/^\d{2}:\d{2}$/.test(f.time)) return { ok: false, error: "Pick a date and a time." };
    edit.instant = new Date(zonedInstant(f.day, f.time, log.logZone)).toISOString();
  }
  return { ok: true, edit };
}
