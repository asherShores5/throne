// The month grid: weeks start Monday (like the Summary week), cells outside the month are blank, today
// is marked. What a Day shows comes from `day()`, so the same grid serves one person's heat view (this
// ticket) and the combined grid of several people (ticket 07).
import type { ReactNode } from "react";
import { monthGrid } from "@throne/shared";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface DayCell {
  /** What a screen reader hears for the Day, e.g. "Fri, Nov 6: 5 Logs". */
  label: string;
  /** Heat level 0-4 (heatLevel in shared); left out for cells that shade themselves. */
  heat?: number;
  content: ReactNode;
  /** The Day has Reactions or Comments the viewer can see: a small dot in the corner. */
  marker?: boolean;
}

export function MonthGrid({ month, today, day, onPick }: {
  month: string;
  /** The viewer's Day, highlighted if it's in this month. */
  today: string;
  day: (day: string) => DayCell;
  onPick: (day: string) => void;
}) {
  return (
    <div role="grid" className="month-grid" aria-readonly="true">
      <div role="row" className="week head">
        {WEEKDAYS.map((w) => <div role="columnheader" key={w}>{w}</div>)}
      </div>
      {monthGrid(month).map((week, i) => (
        <div role="row" className="week" key={i}>
          {week.map((d, j) => {
            if (!d) return <div role="gridcell" className="day blank" key={j} />;
            const c = day(d);
            return (
              <div
                role="gridcell" key={d} className="day" data-day={d} data-heat={c.heat}
                aria-current={d === today ? "date" : undefined}
              >
                <button type="button" aria-label={c.marker ? `${c.label}, with Reactions or Comments` : c.label} onClick={() => onPick(d)}>
                  <span className="date" aria-hidden="true">{Number(d.slice(8))}</span>
                  {c.marker && <span className="marker" data-marker aria-hidden="true" />}
                  {c.content}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
