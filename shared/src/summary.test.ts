// Summary and Awards (GLOSSARY: Summary, Award, Day, Log). Expected values are worked by hand.
// Weeks used: Mon 2026-11-02 .. Sun 2026-11-08 (the week before: 2026-10-26 .. 2026-11-01). US DST ended
// 2026-11-01, so Los Angeles is UTC-8 all of that week.
import { describe, expect, it } from "vitest";
import {
  AWARD_NAMES, dueSummaryWeek, personWeek, summaryWeekOf, weekAwards, type SummaryWeek, type WeekLog,
} from "./summary";

const WEEK: SummaryWeek = { weekStart: "2026-11-02", weekEnd: "2026-11-08" };
const UTC = "UTC";
/** A Log on `day` at HH:MM in `zone` (the instant is that wall time; tests mostly use UTC). */
const at = (day: string, time = "12:00", extra: Partial<WeekLog> = {}): WeekLog => ({
  day, instant: `${day}T${time}:00Z`, logZone: UTC, ...extra,
});
const days = (...ds: string[]) => ds.map((d) => at(d));
const MON = "2026-11-02", TUE = "2026-11-03", WED = "2026-11-04", THU = "2026-11-05", FRI = "2026-11-06", SAT = "2026-11-07", SUN = "2026-11-08";

describe("when a Summary is due: Monday 08:00 in the Home zone, for last Monday-Sunday", () => {
  it("is due from 08:00 on a Monday in the zone, for the week that ended Sunday", () => {
    // 2026-11-09 is a Monday. 16:00Z = 08:00 in Los Angeles (UTC-8).
    expect(dueSummaryWeek(Date.parse("2026-11-09T16:00:00Z"), "America/Los_Angeles")).toEqual(WEEK);
    expect(dueSummaryWeek(Date.parse("2026-11-09T23:00:00Z"), "America/Los_Angeles")).toEqual(WEEK);
  });

  it("is not due before 08:00 Monday, nor on any other weekday", () => {
    expect(dueSummaryWeek(Date.parse("2026-11-09T15:59:00Z"), "America/Los_Angeles")).toBeUndefined();
    // Tuesday 00:00 in LA: Monday is over.
    expect(dueSummaryWeek(Date.parse("2026-11-10T08:00:00Z"), "America/Los_Angeles")).toBeUndefined();
    expect(dueSummaryWeek(Date.parse("2026-11-08T16:00:00Z"), "America/Los_Angeles")).toBeUndefined(); // Sunday
  });

  it("goes by the zone's own Monday: across the date line one UTC instant is Monday in one zone, Sunday in another", () => {
    const t = Date.parse("2026-11-08T20:00:00Z"); // Mon 09:00 in Auckland (UTC+13), Sun 10:00 in Honolulu
    expect(dueSummaryWeek(t, "Pacific/Auckland")).toEqual(WEEK);
    expect(dueSummaryWeek(t, "Pacific/Honolulu")).toBeUndefined();
  });

  it("works in a half-hour zone (the hourly run lands at 08:30 in Kolkata)", () => {
    expect(dueSummaryWeek(Date.parse("2026-11-09T03:00:00Z"), "Asia/Kolkata")).toEqual(WEEK);
    expect(dueSummaryWeek(Date.parse("2026-11-09T02:00:00Z"), "Asia/Kolkata")).toBeUndefined(); // 07:30
  });

  it("summaryWeekOf gives the Monday-Sunday week that holds a Day", () => {
    expect(summaryWeekOf(MON)).toEqual(WEEK);
    expect(summaryWeekOf(SUN)).toEqual(WEEK);
    expect(summaryWeekOf("2026-12-31")).toEqual({ weekStart: "2026-12-28", weekEnd: "2027-01-03" });
  });
});

describe("one person's week: total, daily average, change, most common Bristol type", () => {
  it("counts the Logs on the week's Days and compares with the week before", () => {
    const logs = [...days(MON, MON, WED, SUN, SUN, SUN, SUN), ...days("2026-10-26", "2026-11-01", "2026-11-01")];
    expect(personWeek(logs, WEEK)).toEqual({ total: 7, dailyAverage: 1, change: 4, bristolType: null });
  });

  it("ignores Logs outside both weeks, and a quiet week is all zeros", () => {
    expect(personWeek(days("2026-10-25", "2026-11-09"), WEEK)).toEqual({ total: 0, dailyAverage: 0, change: 0, bristolType: null });
    expect(personWeek([], WEEK)).toEqual({ total: 0, dailyAverage: 0, change: 0, bristolType: null });
  });

  it("goes down as a negative change, and rounds the daily average to two places", () => {
    const logs = [...days(MON, TUE), ...days("2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31")];
    expect(personWeek(logs, WEEK)).toMatchObject({ total: 2, dailyAverage: 0.29, change: -3 });
  });

  it("uses each Log's own Day, not its instant (a Log made at 23:30 in Los Angeles is that Day's)", () => {
    // 07:30Z Tuesday is 23:30 Monday in LA; its Day says Monday, so it counts this week either way,
    // but a Sunday-23:30 LA Log (Monday 07:30Z) belongs to this week, not the next.
    const lateSunday: WeekLog = { day: SUN, instant: "2026-11-09T07:30:00Z", logZone: "America/Los_Angeles" };
    expect(personWeek([lateSunday], WEEK).total).toBe(1);
  });

  it("names the most common Bristol type among this week's Logs; a tie goes to the lower type", () => {
    const b = (day: string, t: number) => at(day, "12:00", { bristolType: t });
    expect(personWeek([b(MON, 4), b(TUE, 4), b(WED, 3), at(THU)], WEEK).bristolType).toBe(4);
    expect(personWeek([b(MON, 5), b(TUE, 3)], WEEK).bristolType).toBe(3);
    // Last week's types don't count.
    expect(personWeek([b("2026-10-30", 6), b("2026-10-31", 6), b(MON, 2)], WEEK).bristolType).toBe(2);
  });
});

/** People for weekAwards. */
const person = (id: string, logs: WeekLog[]) => ({ id, logs });
const award = (results: ReturnType<typeof weekAwards>, kind: keyof typeof AWARD_NAMES) => results.find((a) => a.award === kind)?.winners;

describe("Awards: each needs 2+ people with enough data; ties share", () => {
  it("has the four Awards with their names", () => {
    expect(AWARD_NAMES).toEqual({ mostRegular: "Most regular", earlyBird: "Early bird", nightOwl: "Night owl", streak: "Streak" });
  });

  it("gives nothing to a group of one, however much they logged", () => {
    expect(weekAwards([person("a", days(MON, TUE, WED, THU, FRI, SAT, SUN))], WEEK)).toEqual([]);
  });

  describe("Most regular: smallest spread of daily counts, needs Logs on 5+ Days", () => {
    it("goes to the steadier person (1 a Day every Day beats 1-3 a Day)", () => {
      const steady = person("a", days(MON, TUE, WED, THU, FRI, SAT, SUN));
      const bumpy = person("b", days(MON, TUE, TUE, TUE, WED, THU, FRI, SAT, SUN, SUN));
      expect(award(weekAwards([steady, bumpy], WEEK), "mostRegular")).toEqual(["a"]);
    });

    it("counts a Day with no Logs in the spread", () => {
      // a: 1,1,1,1,1,0,0 (5 Days). b: 2,2,2,2,2,2,2 (no spread at all).
      const a = person("a", days(MON, TUE, WED, THU, FRI));
      const b = person("b", [MON, TUE, WED, THU, FRI, SAT, SUN].flatMap((d) => days(d, d)));
      expect(award(weekAwards([a, b], WEEK), "mostRegular")).toEqual(["b"]);
    });

    it("needs Logs on at least 5 Days: 4 Days doesn't qualify, so there aren't 2 people with enough data", () => {
      const a = person("a", days(MON, TUE, WED, THU, FRI));
      const four = person("b", days(MON, TUE, WED, THU));
      expect(award(weekAwards([a, four], WEEK), "mostRegular")).toBeUndefined();
    });

    it("is shared on a tie", () => {
      const a = person("a", days(MON, TUE, WED, THU, FRI));
      const b = person("b", days(TUE, WED, THU, FRI, SAT));
      expect(award(weekAwards([a, b], WEEK), "mostRegular")).toEqual(["a", "b"]);
    });
  });

  describe("Early bird / Night owl: median time of the first / last Log of each Day, needs Logs on 3+ Days", () => {
    const times = (id: string, ...entries: [string, string][]) => person(id, entries.map(([d, t]) => at(d, t)));

    it("Early bird goes to the earliest median first Log; Night owl to the latest median last Log", () => {
      const a = times("a", [MON, "06:00"], [MON, "23:00"], [TUE, "06:30"], [WED, "07:00"]);
      const b = times("b", [MON, "09:00"], [TUE, "10:00"], [WED, "22:00"]);
      const r = weekAwards([a, b], WEEK);
      // a's firsts 06:00, 06:30, 07:00 (median 06:30); b's 09:00, 10:00, 22:00 (median 10:00).
      expect(award(r, "earlyBird")).toEqual(["a"]);
      // a's lasts 23:00, 06:30, 07:00 (median 07:00); b's lasts median 10:00.
      expect(award(r, "nightOwl")).toEqual(["b"]);
    });

    it("takes the middle two's average for an even number of Days", () => {
      // a: 06:00, 07:00, 09:00, 10:00 -> median 08:00. b: 08:00, 08:00, 08:00 -> 08:00. Tie.
      const a = times("a", [MON, "06:00"], [TUE, "07:00"], [WED, "09:00"], [THU, "10:00"]);
      const b = times("b", [MON, "08:00"], [TUE, "08:00"], [WED, "08:00"]);
      expect(award(weekAwards([a, b], WEEK), "earlyBird")).toEqual(["a", "b"]);
      // one more minute on a's side breaks it.
      const a2 = times("a", [MON, "06:00"], [TUE, "07:00"], [WED, "09:01"], [THU, "10:00"]);
      expect(award(weekAwards([a2, b], WEEK), "earlyBird")).toEqual(["b"]);
    });

    it("reads the time in each Log's own Log zone", () => {
      // a logs at 14:00Z from Los Angeles = 06:00 local; b logs at 07:00 UTC.
      const la = (day: string): WeekLog => ({ day, instant: `${day}T14:00:00Z`, logZone: "America/Los_Angeles" });
      const a = person("a", [la(MON), la(TUE), la(WED)]);
      const b = times("b", [MON, "07:00"], [TUE, "07:00"], [WED, "07:00"]);
      expect(award(weekAwards([a, b], WEEK), "earlyBird")).toEqual(["a"]);
    });

    it("needs Logs on 3+ Days from 2+ people", () => {
      const a = times("a", [MON, "06:00"], [TUE, "06:00"], [WED, "06:00"]);
      const two = times("b", [MON, "05:00"], [TUE, "05:00"]);
      const r = weekAwards([a, two], WEEK);
      expect(award(r, "earlyBird")).toBeUndefined();
      expect(award(r, "nightOwl")).toBeUndefined();
    });
  });

  describe("Streak: longest run of consecutive Days with a Log, at least 3", () => {
    it("goes to the longest run, counted inside the week", () => {
      const a = person("a", days(MON, TUE, WED, FRI, SAT, SUN)); // runs 3 and 3
      const b = person("b", days(WED, THU, FRI, SAT)); // run 4
      expect(award(weekAwards([a, b], WEEK), "streak")).toEqual(["b"]);
    });

    it("needs a run of 3: two people with runs of 2 get nothing, a run of 3 vs one of 2 isn't 2 people", () => {
      expect(award(weekAwards([person("a", days(MON, TUE, THU, FRI)), person("b", days(SAT, SUN))], WEEK), "streak")).toBeUndefined();
      expect(award(weekAwards([person("a", days(MON, TUE, WED)), person("b", days(SAT, SUN))], WEEK), "streak")).toBeUndefined();
    });

    it("is shared on a tie, and ignores Days of the week before", () => {
      const a = person("a", days("2026-10-31", "2026-11-01", MON, TUE, WED)); // 3 inside the week
      const b = person("b", days(FRI, SAT, SUN));
      expect(award(weekAwards([a, b], WEEK), "streak")).toEqual(["a", "b"]);
    });
  });

  it("lists the Awards in a fixed order and leaves out the ones nobody earned", () => {
    const all = [MON, TUE, WED, THU, FRI, SAT, SUN];
    const a = person("a", all.map((d) => at(d, "06:00")));
    const b = person("b", all.flatMap((d, i) => (i % 2 ? [at(d, "09:00"), at(d, "23:00")] : [at(d, "09:00")])));
    const r = weekAwards([a, b], WEEK);
    expect(r.map((x) => x.award)).toEqual(["mostRegular", "earlyBird", "nightOwl", "streak"]);
    expect(r).toEqual([
      { award: "mostRegular", winners: ["a"] },
      { award: "earlyBird", winners: ["a"] },
      { award: "nightOwl", winners: ["b"] }, // b's lasts 09:00,23:00,09:00,23:00,09:00,23:00,09:00 -> median 09:00 > 06:00
      { award: "streak", winners: ["a", "b"] },
    ]);
  });
});
