import { describe, expect, it } from "vitest";
import { longDay, monthName, monthTitle, recentDay, shortDay } from "./dayLabels";

describe("Day and month labels", () => {
  it("writes the Day as given, whatever the device zone", () => {
    expect(longDay("2026-11-08")).toContain("8");
    expect(longDay("2026-11-08")).toMatch(/Sunday/);
    expect(shortDay("2026-11-06")).toMatch(/Fri/);
    expect(shortDay("2026-11-06")).toContain("6");
    expect(shortDay("2026-01-01")).toMatch(/Thu/);
  });

  it("says Today and Yesterday, then the short Day", () => {
    expect(recentDay("2026-11-09", "2026-11-09")).toBe("Today");
    expect(recentDay("2026-11-08", "2026-11-09")).toBe("Yesterday");
    expect(recentDay("2026-11-06", "2026-11-09")).toBe(shortDay("2026-11-06"));
  });

  it("names months", () => {
    expect(monthTitle("2026-11")).toMatch(/November/);
    expect(monthTitle("2026-11")).toContain("2026");
    expect(monthName("2027-01")).toMatch(/January/);
  });
});
