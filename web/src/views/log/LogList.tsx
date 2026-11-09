// A list of Logs grouped by Day, newest first, with time (in each Log's zone), Details, and edit/delete.
import { useState } from "react";
import { BRISTOL_TYPES, addDays, localTime } from "@throne/shared";
import type { Log } from "../../api/log";
import { BristolIcon } from "./BristolIcon";
import { flagLabel } from "./LogEditor";

/** "Today", "Yesterday" or e.g. "Fri 6 Nov". */
export function dayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
}

export function LogList({ logs, today, onEdit, onDelete, canEdit = () => true, canDelete = () => true, oldestFirst = false }: {
  logs: Log[];
  today: string;
  onEdit: (l: Log) => void;
  onDelete: (l: Log) => Promise<void>;
  /** Whether a Log still offers Edit (the Calendar's Day sheet hides it past the 7-day window). */
  canEdit?: (l: Log) => boolean;
  /** Whether a Log offers Delete (only the owner's do). */
  canDelete?: (l: Log) => boolean;
  /** Logs within a Day in time order (the Day sheet) instead of newest first (the recent list). */
  oldestFirst?: boolean;
}) {
  const [confirming, setConfirming] = useState<string>();
  const days = [...new Set(logs.map((l) => l.day))].sort().reverse();
  return (
    <>
      {days.map((day) => (
        <section key={day} className="log-day" aria-label={dayLabel(day, today)}>
          <h3>{dayLabel(day, today)}</h3>
          <ul>
            {logs.filter((l) => l.day === day).sort((a, b) => ((a.instant < b.instant) !== oldestFirst ? 1 : -1)).map((l) => {
              const time = localTime(Date.parse(l.instant), l.logZone);
              const bristol = BRISTOL_TYPES.find((b) => b.type === l.bristolType);
              return (
                <li key={l.id} className="log-item" aria-label={`Log at ${time}`}>
                  <span className="time">{time}</span>
                  <span className="what">
                    {bristol && (
                      <span className="tag"><BristolIcon type={bristol.type} /> {bristol.type} {bristol.label}</span>
                    )}
                    {l.duration !== undefined && <span className="tag">{l.duration} min</span>}
                    {l.flags.map((f) => <span key={f} className="tag flag">{flagLabel(f)}</span>)}
                    {l.note && <span className="note">{l.note}</span>}
                  </span>
                  {confirming === l.id ? (
                    <span className="confirm">
                      <button type="button" className="danger" onClick={() => void onDelete(l).finally(() => setConfirming(undefined))}>Delete</button>
                      <button type="button" onClick={() => setConfirming(undefined)}>Keep</button>
                    </span>
                  ) : (
                    <span className="item-actions">
                      {canEdit(l) && <button type="button" className="link" aria-label={`Edit Log at ${time}`} onClick={() => onEdit(l)}>Edit</button>}
                      {canDelete(l) && <button type="button" className="link" aria-label={`Delete Log at ${time}`} onClick={() => setConfirming(l.id)}>Delete</button>}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}
