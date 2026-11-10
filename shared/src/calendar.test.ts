// Calendar (GLOSSARY: Calendar, Day, Log): the pure parts of the month view. Expected values are worked
// by hand from real calendars (Nov 2026 starts on a Sunday, Feb 2027 on a Monday).
import { describe, expect, it } from "vitest";
import { addMonths, combinedColors, dayCounts, formatAverage, heatLevel, monthStats, isMonth, monthGrid, monthOf, monthRange } from "./calendar";

describe("heat level: how dark a Day is", () => {
  it("is blank with no Logs, then one shade per Log up to 4, and 4 for anything more", () => {
    expect([0, 1, 2, 3, 4, 5, 12, 50].map(heatLevel)).toEqual([0, 1, 2, 3, 4, 4, 4, 4]);
  });
});

describe("month grid: weeks start Monday, Days outside the month are blank", () => {
  it("pads a month that starts on a Sunday with six blanks and ends the last week with blanks", () => {
    const weeks = monthGrid("2026-11");
    expect(weeks).toHaveLength(6);
    expect(weeks[0]).toEqual([null, null, null, null, null, null, "2026-11-01"]);
    expect(weeks[1]).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
    expect(weeks[5]).toEqual(["2026-11-30", null, null, null, null, null, null]);
  });

  it("is exactly four full weeks for a 28-Day February that starts on a Monday", () => {
    const weeks = monthGrid("2027-02");
    expect(weeks).toHaveLength(4);
    expect(weeks[0][0]).toBe("2027-02-01");
    expect(weeks[3][6]).toBe("2027-02-28");
  });

  it("knows leap years", () => {
    expect(monthGrid("2028-02").flat().filter(Boolean).at(-1)).toBe("2028-02-29");
  });
});

describe("Day counts and month stats: the numbers on and under the Calendar", () => {
  const logs = ["2026-10-31", "2026-11-01", "2026-11-01", "2026-11-08", "2026-11-08", "2026-11-08"].map((day) => ({ day }));

  it("counts Logs per Day by each Log's own Day", () => {
    expect(dayCounts(logs)).toEqual({ "2026-10-31": 1, "2026-11-01": 2, "2026-11-08": 3 });
    expect(dayCounts([])).toEqual({});
  });

  it("this month: totals only this month's Logs and averages over the Days so far, today included", () => {
    // 5 Logs in November over 8 Days (1st to 8th).
    expect(monthStats(logs, "2026-11", "2026-11-08")).toEqual({ total: 5, days: 8, dailyAverage: 0.625 });
  });

  it("a past month averages over all its Days", () => {
    expect(monthStats(logs, "2026-10", "2026-11-08")).toEqual({ total: 1, days: 31, dailyAverage: 1 / 31 });
  });

  it("a future month, or one with no Logs, averages 0", () => {
    expect(monthStats(logs, "2026-12", "2026-11-08")).toEqual({ total: 0, days: 0, dailyAverage: 0 });
    expect(monthStats([], "2026-11", "2026-11-08")).toEqual({ total: 0, days: 8, dailyAverage: 0 });
  });

  it("formats the average with one decimal, dropping a trailing .0", () => {
    expect([0, 0.625, 1, 1 / 31, 2.25, 12].map(formatAverage)).toEqual(["0", "0.6", "1", "0", "2.3", "12"]);
  });
});

describe("months: which month a Day is in, moving between months, and the Days to fetch", () => {
  it("names the month of a Day and steps across year ends both ways", () => {
    expect(monthOf("2026-11-08")).toBe("2026-11");
    expect(addMonths("2026-11", 1)).toBe("2026-12");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-03", -14)).toBe("2025-01");
  });

  it("gives the first and last Day, for one range query per Profile", () => {
    expect(monthRange("2026-11")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(monthRange("2027-02")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
  });

  it("accepts only YYYY-MM months", () => {
    expect(["2026-11", "2026-01", "1999-12"].map(isMonth)).toEqual([true, true, true]);
    expect(["2026-13", "2026-00", "2026-1", "26-11", "2026-11-01", 202611, undefined].map(isMonth)).toEqual([false, false, false, false, false, false, false]);
  });
});

describe("combined grid colors: one per visible Profile, clashes told apart", () => {
  const av = (color: string, emoji = "🚽") => ({ color, emoji });

  it("keeps each Avatar's own color when they all differ, and shows no emoji", () => {
    expect(combinedColors([av("#7c5cff"), av("#e8590c", "🦆"), av("#f0b400", "🐸")])).toEqual([
      { color: "#7c5cff", text: "#000000" },
      { color: "#e8590c", text: "#000000" },
      { color: "#f0b400", text: "#000000" },
    ]);
  });

  it("gives the later Profile with the same color an alternate shade plus its emoji; the first keeps its own", () => {
    // #7c5cff mixed 40% toward black: 124*0.6=74 (4a), 92*0.6=55 (37), 255*0.6=153 (99).
    expect(combinedColors([av("#7c5cff"), av("#2b8a3e"), av("#7c5cff", "🦆")])).toEqual([
      { color: "#7c5cff", text: "#000000" },
      { color: "#2b8a3e", text: "#000000" },
      { color: "#4a3799", text: "#ffffff", emoji: "🦆" },
    ]);
  });

  it("a third and fourth of one color each get their own shade (darker, lighter, darker still)", () => {
    // #868e96 40% toward black: 80 (50), 85 (55), 90 (5a). 45% toward white: 134+0.45*121=188 (bc),
    // 142+0.45*113=193 (c1), 150+0.45*105=197 (c5). 65% toward black: 47 (2f), 50 (32), 53 (35).
    const out = combinedColors([av("#868e96"), av("#868e96", "🦆"), av("#868e96", "🐸"), av("#868e96", "🐙")]);
    expect(out.map((c) => c.color)).toEqual(["#868e96", "#50555a", "#bcc1c5", "#2f3235"]);
    expect(out.map((c) => c.emoji)).toEqual([undefined, "🦆", "🐸", "🐙"]);
  });
});
