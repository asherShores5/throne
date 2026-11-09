// One person's Calendar: a month of their Logs as a heat grid, prev/next month, the monthly total and
// daily average, and the Day sheet. Whose Logs it shows comes in as `loadLogs` (one range query per month),
// so ticket 07 can point it at a Friend (read-only) as well as at me.
import { useCallback, useEffect, useRef, useState } from "react";
import { addMonths, dayCounts, dayOf, formatAverage, heatLevel, monthOf, monthRange, monthStats } from "@throne/shared";
import { errorText, type Log } from "../../api/log";
import { DaySheet } from "./DaySheet";
import { MonthGrid } from "./MonthGrid";
import { PULL_PX, usePullToRefresh, useRefreshOnFocus } from "./refresh";
import "./calendar.css";

/** e.g. "November 2026". */
export const monthTitle = (month: string) =>
  new Date(`${month}-15T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", month: "long", year: "numeric" });

const monthName = (month: string) => new Date(`${month}-15T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", month: "long" });

const shortDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function PersonCalendar({ loadLogs, viewerZone, editable }: {
  /** That person's Logs on the Days from..to (myLogs for me). */
  loadLogs: (from: string, to: string) => Promise<Log[]>;
  /** The viewer's Home zone: decides "today" and which month opens first. */
  viewerZone: string;
  /** The viewer owns these Logs (edit/delete in the Day sheet). */
  editable: boolean;
}) {
  const today = dayOf(Date.now(), viewerZone);
  const thisMonth = monthOf(today);
  const [month, setMonth] = useState(thisMonth);
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const seq = useRef(0);

  const load = useCallback(() => {
    const n = ++seq.current;
    const { from, to } = monthRange(month);
    setLoading(true);
    loadLogs(from, to).then(
      (xs) => { if (n === seq.current) { setLogs(xs); setError(undefined); } },
      (e) => { if (n === seq.current) setError(`Couldn't load: ${errorText(e)}`); },
    ).finally(() => n === seq.current && setLoading(false));
  }, [month, loadLogs]);
  useEffect(load, [load]);
  useRefreshOnFocus(load);
  const { pull, handlers } = usePullToRefresh(load);

  const counts = dayCounts(logs);
  const stats = monthStats(logs, month, today);
  const go = (n: number) => { setLogs([]); setMonth((m) => addMonths(m, n)); };

  return (
    <section className="calendar" aria-label="Calendar" aria-busy={loading} {...handlers} onTouchCancel={handlers.onTouchEnd}>
      <div className="pull-hint" style={{ height: pull ? `${pull / 2}px` : 0 }} aria-hidden="true">
        {pull >= PULL_PX ? "Release to refresh" : pull ? "Pull to refresh" : ""}
      </div>
      <div className="month-head">
        <button type="button" className="month-nav" aria-label="Previous month" onClick={() => go(-1)}>‹</button>
        <h2>{monthTitle(month)}</h2>
        <button type="button" className="month-nav" aria-label="Next month" disabled={month >= thisMonth} onClick={() => go(1)}>›</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <MonthGrid
        month={month} today={today} onPick={setOpen}
        day={(d) => {
          const n = counts[d] ?? 0;
          return { label: `${shortDay(d)}: ${plural(n, "Log")}`, heat: heatLevel(n), content: <span className="count">{n || ""}</span> };
        }}
      />
      <section className="month-stats" aria-label="Month totals">
        <p><strong>{plural(stats.total, "Log")}</strong> in {monthName(month)}</p>
        <p><strong>{formatAverage(stats.dailyAverage)}</strong> a Day</p>
      </section>
      <button type="button" className="link refresh" onClick={load} disabled={loading}>Refresh</button>
      {open && (
        <DaySheet
          day={open} today={today} editable={editable} logs={logs.filter((l) => l.day === open)}
          onChanged={(l) => setLogs((xs) => [...xs.filter((x) => x.id !== l.id), ...(monthOf(l.day) === month ? [l] : [])])}
          onRemoved={(id) => setLogs((xs) => xs.filter((x) => x.id !== id))}
          onClose={() => setOpen(undefined)}
        />
      )}
    </section>
  );
}
