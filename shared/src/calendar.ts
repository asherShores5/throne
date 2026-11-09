// Calendar (GLOSSARY: Calendar, Day, Log). Pure rules for the month view: heat levels, the month grid
// (weeks start Monday, like the Summary week) and the numbers under it. No I/O. Works on any Profile's
// Logs (mine now, a Friend's or several for the combined grid in ticket 07): Days come from each Log's
// own `day` (fixed by its Log zone), never re-bucketed.

/** Heat levels 0-4: 0 is blank, 1-3 one shade per Log, 4 for four or more. */
export const HEAT_LEVELS = 4;

/** How dark a Day with `count` Logs is: 0 blank, then 1, 2, 3, and 4 for 4+. */
export function heatLevel(count: number): number {
  if (!(count > 0)) return 0;
  return Math.min(HEAT_LEVELS, Math.floor(count));
}

// ---- Counts and stats ---------------------------------------------------------------

/** Logs per Day, by each Log's own Day (its Log zone), for one Profile. */
export function dayCounts(logs: readonly { day: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { day } of logs) out[day] = (out[day] ?? 0) + 1;
  return out;
}

export interface MonthStats {
  /** Logs on the month's Days. */
  total: number;
  /** Days counted for the average: all of a past month, the 1st to today for this month, 0 for a future one. */
  days: number;
  /** total / days (0 when there are no Days yet). */
  dailyAverage: number;
}

/** The monthly total and daily average under the Calendar. `today` is the viewer's Day. */
export function monthStats(logs: readonly { day: string }[], month: string, today: string): MonthStats {
  const total = logs.filter((l) => monthOf(l.day) === month).length;
  const current = monthOf(today);
  const days = month < current ? daysIn(month) : month === current ? Number(today.slice(8, 10)) : 0;
  return { total, days, dailyAverage: days ? total / days : 0 };
}

/** A daily average for display: one decimal, no trailing ".0". */
export const formatAverage = (n: number) => String(Math.round(n * 10) / 10);

// ---- Months -------------------------------------------------------------------

/** A month written YYYY-MM. */
export function isMonth(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}$/.test(v)) return false;
  const m = Number(v.slice(5));
  return m >= 1 && m <= 12;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const parts = (month: string) => [Number(month.slice(0, 4)), Number(month.slice(5, 7))] as const;

/** The month (YYYY-MM) a Day is in. */
export const monthOf = (day: string) => day.slice(0, 7);

/** The month `n` months after `month` (negative goes back). */
export function addMonths(month: string, n: number): string {
  const [y, m] = parts(month);
  const i = y * 12 + (m - 1) + n;
  return `${pad(Math.floor(i / 12), 4)}-${pad((i % 12) + 1)}`;
}

const daysIn = (month: string) => {
  const [y, m] = parts(month);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** The first and last Day of a month: one Log range query per Profile (myLogs(from, to)). */
export const monthRange = (month: string) => ({ from: `${month}-01`, to: `${month}-${pad(daysIn(month))}` });

/** Weekday of a Day, 0 = Monday ... 6 = Sunday (weeks start Monday, like the Summary week). */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** The month as weeks of 7 cells, Monday first; cells outside the month are null (blank). */
export function monthGrid(month: string): (string | null)[][] {
  const cells: (string | null)[] = Array(weekdayOf(`${month}-01`)).fill(null);
  for (let d = 1; d <= daysIn(month); d++) cells.push(`${month}-${pad(d)}`);
  while (cells.length % 7) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
