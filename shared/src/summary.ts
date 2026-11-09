// The weekly Summary and its Awards (ticket 10). Pure: the Notifier (api/src/notifier.ts) feeds it each
// person's Logs and stores what comes out; the web app only shows it.
//
// A Summary covers one Monday-Sunday week of Days. Each person's Logs count on their own Day (fixed by the
// Log zone when the Log was made), never re-bucketed by anyone's Home zone.
import { weekdayOf } from "./calendar";
import { addDays, dayOf, localTime } from "./log";

/** The local hour on Monday (Home zone) from which last week's Summary is due. */
export const SUMMARY_HOUR = 8;

/** One Monday-Sunday week of Days. */
export interface SummaryWeek {
  weekStart: string;
  weekEnd: string;
}

/** The Monday-Sunday week that holds `day`. */
export function summaryWeekOf(day: string): SummaryWeek {
  const weekStart = addDays(day, -weekdayOf(day));
  return { weekStart, weekEnd: addDays(weekStart, 6) };
}

/**
 * The week whose Summary is due at `now` for a Profile in `zone`: last week, on a Monday from 08:00 local
 * (any later run that Monday still finds it, so a missed hourly run catches up). Undefined otherwise.
 */
export function dueSummaryWeek(now: number, zone: string): SummaryWeek | undefined {
  const today = dayOf(now, zone);
  if (weekdayOf(today) !== 0) return undefined;
  if (localTime(now, zone) < `${String(SUMMARY_HOUR).padStart(2, "0")}:00`) return undefined;
  return summaryWeekOf(addDays(today, -7));
}

/** What the Summary needs of a Log: its Day, when, where, and the Bristol type if one was given. */
export interface WeekLog {
  day: string;
  /** ISO 8601 (as stored) or epoch ms. */
  instant: string | number;
  logZone: string;
  bristolType?: number;
}

/** One person's line in a Summary. */
export interface PersonWeek {
  total: number;
  /** Logs per Day over the 7 Days, to two places. */
  dailyAverage: number;
  /** total minus the week before's total. */
  change: number;
  /** The most common Bristol type among the week's Logs (a tie goes to the lower type); null if none had one. */
  bristolType: number | null;
}

const inWeek = (day: string, w: SummaryWeek) => day >= w.weekStart && day <= w.weekEnd;

/** One person's numbers for the week, from their Logs of this week and the week before (others are ignored). */
export function personWeek(logs: readonly WeekLog[], week: SummaryWeek): PersonWeek {
  const before = { weekStart: addDays(week.weekStart, -7), weekEnd: addDays(week.weekStart, -1) };
  const these = logs.filter((l) => inWeek(l.day, week));
  const prev = logs.filter((l) => inWeek(l.day, before)).length;
  const counts = new Map<number, number>();
  for (const l of these) if (l.bristolType != null) counts.set(l.bristolType, (counts.get(l.bristolType) ?? 0) + 1);
  let bristolType: number | null = null;
  for (const [t, n] of counts) {
    if (bristolType === null || n > counts.get(bristolType)! || (n === counts.get(bristolType) && t < bristolType)) bristolType = t;
  }
  return {
    total: these.length,
    dailyAverage: Math.round((these.length / 7) * 100) / 100,
    change: these.length - prev,
    bristolType,
  };
}

// ---- Awards -----------------------------------------------------------------

export const AWARDS = ["mostRegular", "earlyBird", "nightOwl", "streak"] as const;
export type AwardKind = (typeof AWARDS)[number];

export const AWARD_NAMES: Record<AwardKind, string> = {
  mostRegular: "Most regular",
  earlyBird: "Early bird",
  nightOwl: "Night owl",
  streak: "Streak",
};

/** Most regular needs Logs on this many of the 7 Days. */
export const REGULAR_MIN_DAYS = 5;
/** Early bird and Night owl need Logs on this many Days (a default; the spec leaves it open). */
export const TIME_AWARD_MIN_DAYS = 3;
/** The shortest run of Days that counts as a Streak. */
export const STREAK_MIN_DAYS = 3;
/** An Award needs at least this many people with enough data. */
export const AWARD_MIN_PEOPLE = 2;

export interface AwardResult {
  award: AwardKind;
  /** Profile ids, in the order they were given; more than one on a tie. */
  winners: string[];
}

const minutesOf = (l: WeekLog) => {
  const [h, m] = localTime(typeof l.instant === "number" ? l.instant : Date.parse(l.instant), l.logZone).split(":").map(Number);
  return h * 60 + m;
};

/** Twice the median (keeps an even count's midpoint a whole number, so ties compare exactly). */
function median2(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? 2 * s[mid] : s[mid - 1] + s[mid];
}

interface Scored {
  id: string;
  score: number | undefined;
}

/** The best score's people, if at least AWARD_MIN_PEOPLE have one. */
function pick(scored: Scored[], better: (a: number, b: number) => boolean): string[] {
  const ok = scored.filter((s): s is { id: string; score: number } => s.score !== undefined);
  if (ok.length < AWARD_MIN_PEOPLE) return [];
  let best = ok[0].score;
  for (const s of ok) if (better(s.score, best)) best = s.score;
  return ok.filter((s) => s.score === best).map((s) => s.id);
}

/** The Awards for a group (the recipient plus their Friends) over the week. Awards nobody earned are left out. */
export function weekAwards(people: readonly { id: string; logs: readonly WeekLog[] }[], week: SummaryWeek): AwardResult[] {
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(week.weekStart, i));
  const stats = people.map(({ id, logs }) => {
    const byDay = new Map<string, number[]>();
    for (const l of logs) if (inWeek(l.day, week)) byDay.set(l.day, [...(byDay.get(l.day) ?? []), minutesOf(l)]);
    const counts = weekDays.map((d) => byDay.get(d)?.length ?? 0);
    const daysLogged = byDay.size;
    let run = 0, longest = 0;
    for (const c of counts) longest = Math.max(longest, (run = c ? run + 1 : 0));
    const sum = counts.reduce((a, b) => a + b, 0);
    const timed = daysLogged >= TIME_AWARD_MIN_DAYS;
    return {
      id,
      // 7 * (sum of squares) - sum^2 = 49 * variance of the daily counts: a whole number.
      regular: daysLogged >= REGULAR_MIN_DAYS ? 7 * counts.reduce((a, c) => a + c * c, 0) - sum * sum : undefined,
      early: timed ? median2([...byDay.values()].map((m) => Math.min(...m))) : undefined,
      late: timed ? median2([...byDay.values()].map((m) => Math.max(...m))) : undefined,
      streak: longest >= STREAK_MIN_DAYS ? longest : undefined,
    };
  });
  const lower = (a: number, b: number) => a < b;
  const higher = (a: number, b: number) => a > b;
  const winners: Record<AwardKind, string[]> = {
    mostRegular: pick(stats.map((s) => ({ id: s.id, score: s.regular })), lower),
    earlyBird: pick(stats.map((s) => ({ id: s.id, score: s.early })), lower),
    nightOwl: pick(stats.map((s) => ({ id: s.id, score: s.late })), higher),
    streak: pick(stats.map((s) => ({ id: s.id, score: s.streak })), higher),
  };
  return AWARDS.filter((a) => winners[a].length).map((award) => ({ award, winners: winners[award] }));
}
