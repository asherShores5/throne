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

// ---- Combined grid colors ------------------------------------------------------------

/** How the combined grid draws one visible Profile's count. */
export interface CombinedColor {
  /** Background of the count: the Avatar color, or an alternate shade of it when it clashes. */
  color: string;
  /** Text on it (black or white, whichever reads better). */
  text: string;
  /** Set when the color clashed: the Avatar emoji goes next to the count so the two can be told apart. */
  emoji?: string;
}

/** Alternate shades for the 2nd, 3rd and 4th Profile of one color: toward black, white, then black again. */
const CLASH_SHADES: readonly [toward: number, amount: number][] = [[0, 0.4], [255, 0.45], [0, 0.65]];

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, "0");
const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function mix(hex: string, toward: number, amount: number): string {
  return `#${rgbOf(hex).map((c) => hex2(c + (toward - c) * amount)).join("")}`;
}

/** Black or white text on `hex`, whichever has the higher WCAG contrast. */
function textOn(hex: string): string {
  const [r, g, b] = rgbOf(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "#000000" : "#ffffff";
}

/**
 * Colors for the combined grid, in display order (me first, then Friends in Friends-list order). The
 * first Profile with a color keeps it; each later one with the same color gets an alternate shade plus
 * its emoji (spec: Calendar UI).
 */
export function combinedColors(avatars: readonly { color: string; emoji: string }[]): CombinedColor[] {
  const seen = new Map<string, number>();
  return avatars.map(({ color, emoji }) => {
    const key = color.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n === 0) return { color: key, text: textOn(key) };
    const [toward, amount] = CLASH_SHADES[(n - 1) % CLASH_SHADES.length];
    const shade = mix(key, toward, amount);
    return { color: shade, text: textOn(shade), emoji };
  });
}
