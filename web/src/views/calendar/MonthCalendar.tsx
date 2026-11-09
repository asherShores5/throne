// A month on the Calendar for the people picked in the Avatar row (Calendar.tsx): one person (me or a
// Friend) as a heat grid with the monthly total and daily average, or everyone as the combined grid (a
// small count per person per Day in their Avatar color; clashing colors get another shade plus the
// emoji, shared combinedColors). Prev/next month, refresh on focus and pull-to-refresh, and the Day
// sheet (my Logs editable, a Friend's read-only). Each Log sits on its own Day (its Log zone).
import { useState } from "react";
import { addMonths, combinedColors, dayCounts, dayOf, formatAverage, heatLevel, monthOf, monthStats, type Avatar } from "@throne/shared";
import { monthName, monthTitle, shortDay } from "../dayLabels";
import { DaySheet } from "./DaySheet";
import { MonthGrid } from "./MonthGrid";
import { useMonthLogs } from "./monthLogs";
import { PULL_PX, usePullToRefresh, useRefreshOnFocus } from "./refresh";
import "./calendar.css";

/** Someone whose Logs the Calendar shows. */
export interface Person {
  id: string;
  /** The viewer (their Logs come from the outbox store and are editable). */
  me?: boolean;
  /** What the Calendar calls them ("Me" for the viewer). */
  name: string;
  avatar: Avatar;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function AvatarDot({ avatar, label }: { avatar: Avatar; label?: string }) {
  return (
    <span className="avatar small" style={{ background: avatar.color }} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {avatar.emoji}
    </span>
  );
}

export function MonthCalendar({ people, directory, combined, viewerZone, openDay }: {
  /** One person, or everyone (me first, then Friends in Friends-list order) when `combined`. */
  people: readonly Person[];
  /** Me and every Friend: names for Reactions and Comments, whoever's Calendar this is. */
  directory: readonly Person[];
  combined: boolean;
  /** The viewer's Home zone: decides "today" and which month opens first. */
  viewerZone: string;
  /** A Day to open at once (a tapped push): its month shows with its Day sheet open. */
  openDay?: string;
}) {
  const today = dayOf(Date.now(), viewerZone);
  const thisMonth = monthOf(today);
  const [month, setMonth] = useState(openDay && openDay <= today ? monthOf(openDay) : thisMonth);
  const [open, setOpen] = useState<string | undefined>(openDay && openDay <= today ? openDay : undefined);
  const { logs, loading, error, reload, replace } = useMonthLogs(month, people);
  const viewer = (directory.find((p) => p.me) ?? people[0]).id;
  const names = new Map(directory.map((p) => [p.id, { name: p.name, avatar: p.avatar }]));
  // Days with Reactions or Comments the viewer can see (the server sends only those).
  const marked = new Set(people.flatMap((p) => (logs[p.id] ?? []).filter((l) => l.reactions.length || l.comments.length).map((l) => l.day)));
  useRefreshOnFocus(reload);
  const { pull, handlers } = usePullToRefresh(reload);

  const counts = Object.fromEntries(people.map((p) => [p.id, dayCounts(logs[p.id] ?? [])]));
  const colors = combinedColors(people.map((p) => p.avatar));
  const one = people[0];

  const dayCell = (d: string) => {
    if (!combined) {
      const n = counts[one.id][d] ?? 0;
      return { label: `${shortDay(d)}: ${plural(n, "Log")}`, heat: heatLevel(n), marker: marked.has(d), content: <span className="count">{n || ""}</span> };
    }
    const ns = people.map((p) => counts[p.id][d] ?? 0);
    return {
      label: `${shortDay(d)}: ${people.map((p, i) => `${p.name} ${ns[i]}`).join(", ")}`,
      marker: marked.has(d),
      content: (
        <span className={`counts n${people.length}`} aria-hidden="true">
          {people.map((p, i) => (
            <span key={p.id} className="mini" data-person={p.id} style={ns[i] ? { background: colors[i].color, color: colors[i].text } : undefined}>
              {ns[i] ? <>{colors[i].emoji && <span className="mini-emoji">{colors[i].emoji}</span>}{ns[i]}</> : ""}
            </span>
          ))}
        </span>
      ),
    };
  };

  const go = (n: number) => setMonth((m) => addMonths(m, n));
  const theirs = !combined && !one.me ? `${one.name}'s Logs` : undefined;

  return (
    <section className={`calendar${combined ? " combined" : ""}`} aria-label="Calendar" aria-busy={loading} {...handlers} onTouchCancel={handlers.onTouchEnd}>
      <div className="pull-hint" style={{ height: pull ? `${pull / 2}px` : 0 }} aria-hidden="true">
        {pull >= PULL_PX ? "Release to refresh" : pull ? "Pull to refresh" : ""}
      </div>
      <div className="month-head">
        <button type="button" className="month-nav" aria-label="Previous month" onClick={() => go(-1)}>‹</button>
        <h2>{monthTitle(month)}</h2>
        <button type="button" className="month-nav" aria-label="Next month" disabled={month >= thisMonth} onClick={() => go(1)}>›</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <MonthGrid month={month} today={today} onPick={setOpen} day={dayCell} />
      {combined ? (
        <section className="month-stats legend" aria-label="Month totals">
          <ul>
            {people.map((p, i) => {
              const s = monthStats(logs[p.id] ?? [], month, today);
              return (
                <li key={p.id} aria-label={`${p.name}: ${plural(s.total, "Log")}, ${formatAverage(s.dailyAverage)} a Day`}>
                  <span className="mini" style={{ background: colors[i].color, color: colors[i].text }} aria-hidden="true">{colors[i].emoji ?? ""}</span>
                  <span className="who">{p.name}</span>
                  <span><strong>{s.total}</strong> · {formatAverage(s.dailyAverage)} a Day</span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        (() => {
          const s = monthStats(logs[one.id] ?? [], month, today);
          return (
            <section className="month-stats" aria-label="Month totals">
              <p><strong>{plural(s.total, "Log")}</strong> in {monthName(month)}</p>
              <p><strong>{formatAverage(s.dailyAverage)}</strong> a Day</p>
            </section>
          );
        })()
      )}
      <button type="button" className="link refresh" onClick={reload} disabled={loading}>Refresh</button>
      {open && (
        <DaySheet
          day={open} today={today} subtitle={theirs} onClose={() => setOpen(undefined)}
          viewer={viewer} people={names}
          groups={people.map((p) => ({
            id: p.id, onChanged: (l) => replace(p, l), label: combined ? (p.me ? "My Logs" : `${p.name}'s Logs`) : undefined, editable: !!p.me,
            title: combined ? <><AvatarDot avatar={p.avatar} /> {p.name}</> : undefined,
            logs: (logs[p.id] ?? []).filter((l) => l.day === open),
          }))}
        />
      )}
    </section>
  );
}
