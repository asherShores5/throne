// The Day sheet: one Day's Logs in time order with time (in each Log's zone) and Details. On my own
// Calendar each Log can be deleted, and edited while it's inside the 7-day window (the server's rule);
// on a Friend's (ticket 07) it's read-only.
import { useEffect, useState } from "react";
import { checkLogTime } from "@throne/shared";
import type { Log } from "../../api/log";
import { removeLog } from "../../sync/logs";
import { LogEditor } from "../log/LogEditor";
import { LogList } from "../log/LogList";
import "../log/log.css";

/** e.g. "Sunday, November 8" (the Day as written, not shifted by any zone). */
export const longDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });

export function DaySheet({ day, today, logs, editable, onChanged, onRemoved, onClose }: {
  day: string;
  today: string;
  /** This Day's Logs. */
  logs: Log[];
  /** The viewer owns these Logs. */
  editable: boolean;
  onChanged: (l: Log) => void;
  onRemoved: (id: string) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<Log>();

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !editing && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [editing, onClose]);

  /** Through the outbox (sync/logs.ts), like the Log tab: works offline, sent when possible. */
  async function remove(l: Log) {
    removeLog(l.id);
    onRemoved(l.id);
  }

  const title = longDay(day);
  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet day-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="link" onClick={onClose}>Close</button>
        </div>
        {logs.length ? (
          <div className="day-logs">
            <LogList
              logs={logs} today={today} oldestFirst onEdit={setEditing} onDelete={remove}
              canEdit={(l) => editable && checkLogTime(Date.parse(l.instant), Date.now()) === undefined}
              canDelete={() => editable}
            />
          </div>
        ) : (
          <p className="hint">No Logs this Day.</p>
        )}
      </div>
      {editing && (
        <LogEditor log={editing} onClose={() => setEditing(undefined)} onSaved={(l) => { onChanged(l); setEditing(undefined); }} />
      )}
    </div>
  );
}
