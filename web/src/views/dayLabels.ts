// How Days and months are written on screen. A Day (YYYY-MM-DD) is shown as written, never shifted by any zone:
// each is read at noon UTC and formatted in UTC. Used by the Log list, the Calendar and the Day sheet.
import { addDays } from "@throne/shared";

const atNoon = (day: string) => new Date(`${day}T12:00:00Z`);
const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { timeZone: "UTC", ...opts });

const LONG_DAY = fmt({ weekday: "long", month: "long", day: "numeric" });
const SHORT_DAY = fmt({ weekday: "short", month: "short", day: "numeric" });
const MONTH_TITLE = fmt({ month: "long", year: "numeric" });
const MONTH_NAME = fmt({ month: "long" });

/** e.g. "Sunday, November 8". */
export const longDay = (day: string) => LONG_DAY.format(atNoon(day));

/** e.g. "Fri, Nov 6". */
export const shortDay = (day: string) => SHORT_DAY.format(atNoon(day));

/** "Today", "Yesterday" or the short Day. */
export function recentDay(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  return shortDay(day);
}

/** e.g. "November 2026" (month is YYYY-MM). */
export const monthTitle = (month: string) => MONTH_TITLE.format(atNoon(`${month}-15`));

/** e.g. "November". */
export const monthName = (month: string) => MONTH_NAME.format(atNoon(`${month}-15`));
