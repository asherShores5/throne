// The Day sheet: one Day's Logs in time order with time (in each Log's zone) and Details, one group per
// person shown (just one on a single Calendar; everyone with Logs that Day on the combined grid). My own
// Logs can be deleted, and edited while inside the 7-day window (the server's rule); a Friend's are
// read-only, but I can react and comment on them (log/Responses.tsx). My Log writes go through the outbox (sync/logs.ts), so the grid behind updates by itself.
import { useEffect, useState, type ReactNode } from "react";
import { checkLogTime } from "@throne/shared";
import type { Log } from "../../api/log";
import { removeLog } from "../../sync/logs";
import type { ShownLog } from "../../sync/pending";
import { LogEditor } from "../log/LogEditor";
import { LogList } from "../log/LogList";
import { Responses, type Directory } from "../log/Responses";
import "../log/log.css";

/** e.g. "Sunday, November 8" (the Day as written, not shifted by any zone). */
export const longDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });

export interface DayGroup {
  id: string;
  /** Whose Logs, e.g. "Sam's Logs" (screen readers); left out on a single Calendar. */
  label?: string;
  /** Shown above the group (Avatar + name). */
  title?: ReactNode;
  logs: ShownLog[];
  /** The viewer owns these Logs. */
  editable: boolean;
  /** The server's newer copy of one of these Logs (a Reaction or Comment changed). */
  onChanged: (l: Log) => void;
}

export function DaySheet({ day, today, groups, subtitle, viewer, people, onClose }: {
  day: string;
  today: string;
  groups: DayGroup[];
  /** The signed-in Profile's id. */
  viewer: string;
  /** Names for Reaction and Comment authors. */
  people: Directory;
  /** Under the title, e.g. "Sam's Logs" on a Friend's Calendar. */
  subtitle?: string;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<Log>();

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !editing && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [editing, onClose]);

  async function remove(l: Log) {
    removeLog(l.id);
  }

  const title = longDay(day);
  const shown = groups.filter((g) => g.logs.length);
  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet day-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="link" onClick={onClose}>Close</button>
        </div>
        {subtitle && <p className="hint day-whose">{subtitle}</p>}
        {shown.length ? (
          shown.map((g) => (
            <section key={g.id} className="day-logs" aria-label={g.label}>
              {g.title && <h3 className="day-group">{g.title}</h3>}
              <LogList
                logs={g.logs} today={today} oldestFirst onEdit={setEditing} onDelete={remove}
                canEdit={(l) => g.editable && checkLogTime(Date.parse(l.instant), Date.now()) === undefined}
                canDelete={() => g.editable}
                below={(l) => <Responses log={l} owner={g.id} viewer={viewer} people={people} onChanged={g.onChanged} />}
              />
            </section>
          ))
        ) : (
          <p className="hint">No Logs this Day.</p>
        )}
      </div>
      {editing && <LogEditor log={editing} onClose={() => setEditing(undefined)} onSaved={() => setEditing(undefined)} />}
    </div>
  );
}
