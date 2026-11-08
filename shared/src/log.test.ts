// Log rules (GLOSSARY: Log, Log zone, Day, Details): the pure parts the api enforces and the web client
// shows. Expected values are worked by hand from the zones' published offsets.
import { describe, expect, it } from "vitest";
import {
  LOGS_PER_DAY_MAX, LOG_TOO_NEW, LOG_TOO_OLD, addDays, checkLogTime, dayOf, isDay, isLogId, localTime,
  logSortKey, logSortKeyRange, parseDetails, parseInstant, zonedInstant,
} from "./log";

const at = (iso: string) => Date.parse(iso);

describe("Day: the calendar date of an instant in the Log zone", () => {
  it("is the local date, not the UTC date", () => {
    // 2026-11-08 02:30 UTC is still the evening of the 7th in Los Angeles (UTC-8 after DST ends).
    expect(dayOf(at("2026-11-08T02:30:00Z"), "America/Los_Angeles")).toBe("2026-11-07");
    expect(dayOf(at("2026-11-08T02:30:00Z"), "UTC")).toBe("2026-11-08");
    expect(dayOf(at("2026-11-08T02:30:00Z"), "Asia/Tokyo")).toBe("2026-11-08");
  });

  it("crosses midnight exactly at local midnight", () => {
    expect(dayOf(at("2026-11-08T07:59:59.999Z"), "America/Los_Angeles")).toBe("2026-11-07");
    expect(dayOf(at("2026-11-08T08:00:00Z"), "America/Los_Angeles")).toBe("2026-11-08");
  });

  it("follows DST changes (the offset moves, the Day doesn't jump)", () => {
    // US DST ended 2026-11-01 02:00 EDT (06:00 UTC): midnight was 04:00 UTC that Day (EDT), 05:00 UTC the next (EST).
    expect(dayOf(at("2026-11-01T03:59:00Z"), "America/New_York")).toBe("2026-10-31");
    expect(dayOf(at("2026-11-01T04:00:00Z"), "America/New_York")).toBe("2026-11-01"); // EDT midnight
    expect(dayOf(at("2026-11-02T04:30:00Z"), "America/New_York")).toBe("2026-11-01"); // EST: still 23:30 on the 1st
    expect(dayOf(at("2026-11-02T05:00:00Z"), "America/New_York")).toBe("2026-11-02");
    // Spring forward 2026-03-08: 01:59 EST then 03:00 EDT, same Day.
    expect(dayOf(at("2026-03-08T06:59:00Z"), "America/New_York")).toBe("2026-03-08");
    expect(dayOf(at("2026-03-08T07:00:00Z"), "America/New_York")).toBe("2026-03-08");
  });

  it("works across the date line (one instant, two Days)", () => {
    expect(dayOf(at("2026-11-08T11:00:00Z"), "Pacific/Kiritimati")).toBe("2026-11-09"); // UTC+14
    expect(dayOf(at("2026-11-08T11:00:00Z"), "Pacific/Pago_Pago")).toBe("2026-11-08"); // UTC-11
  });

  it("travel: a Log keeps the Day of its own Log zone, whatever zone you read it from later", () => {
    // Logged at 23:30 in Los Angeles, then the Profile flies to London (Home zone changes).
    const instant = at("2026-11-08T07:30:00Z");
    const logZone = "America/Los_Angeles";
    expect(dayOf(instant, logZone)).toBe("2026-11-07");
    expect(dayOf(instant, "Europe/London")).toBe("2026-11-08"); // what it would be if re-bucketed: wrong
    expect(localTime(instant, logZone)).toBe("23:30");
  });
});

describe("local date and time in a zone, and back", () => {
  it("formats the time of day in the Log zone (24h)", () => {
    expect(localTime(at("2026-11-08T17:05:00Z"), "America/Los_Angeles")).toBe("09:05");
    expect(localTime(at("2026-11-08T00:00:00Z"), "UTC")).toBe("00:00");
  });

  it("turns a Day and time in a zone into the instant", () => {
    expect(new Date(zonedInstant("2026-11-07", "23:30", "America/Los_Angeles")).toISOString()).toBe("2026-11-08T07:30:00.000Z");
    expect(new Date(zonedInstant("2026-07-01", "09:00", "America/Los_Angeles")).toISOString()).toBe("2026-07-01T16:00:00.000Z");
    expect(new Date(zonedInstant("2026-11-09", "00:30", "Pacific/Kiritimati")).toISOString()).toBe("2026-11-08T10:30:00.000Z");
  });

  it("round-trips through DST changes; a time skipped by spring-forward lands just after the gap", () => {
    // 01:30 on fall-back night happens twice; either reading is that local time.
    const t = zonedInstant("2026-11-01", "01:30", "America/New_York");
    expect([dayOf(t, "America/New_York"), localTime(t, "America/New_York")]).toEqual(["2026-11-01", "01:30"]);
    // 02:30 on 2026-03-08 doesn't exist in New York.
    expect(localTime(zonedInstant("2026-03-08", "02:30", "America/New_York"), "America/New_York")).toBe("03:30");
  });

  it("checks and steps Days", () => {
    expect(isDay("2026-11-08")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "26-11-08", "2026-11-8", "", 20261108, null]) expect(isDay(bad)).toBe(false);
    expect(addDays("2026-11-08", -8)).toBe("2026-10-31");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("time rules (server time)", () => {
  const now = at("2026-11-08T12:00:00Z");
  it("allows now, up to 5 minutes ahead (clock skew) and up to 7 days back", () => {
    expect(checkLogTime(now, now)).toBeUndefined();
    expect(checkLogTime(now + 5 * 60_000, now)).toBeUndefined();
    expect(checkLogTime(now - 7 * 24 * 3_600_000, now)).toBeUndefined();
  });
  it("refuses more than 5 minutes in the future or more than 7 days in the past", () => {
    expect(checkLogTime(now + 5 * 60_000 + 1, now)).toBe(LOG_TOO_NEW);
    expect(checkLogTime(now - 7 * 24 * 3_600_000 - 1, now)).toBe(LOG_TOO_OLD);
  });
  it("reads ISO instants with a zone designator only", () => {
    expect(parseInstant("2026-11-08T12:00:00Z")).toBe(now);
    expect(parseInstant("2026-11-08T04:00:00-08:00")).toBe(now);
    expect(parseInstant("2026-11-08T12:00:00.250Z")).toBe(now + 250);
    for (const bad of ["2026-11-08T12:00:00", "2026-11-08", "yesterday", "", 1762603200000, null]) expect(parseInstant(bad)).toBeUndefined();
  });
});

describe("Details", () => {
  it("are all optional", () => {
    expect(parseDetails({})).toEqual({ ok: true, details: { flags: [] } });
  });

  it("takes Duration 1-180 minutes, Bristol type 1-7, a Note up to 200 characters and known Flags", () => {
    const r = parseDetails({ duration: 180, bristolType: 7, note: "x".repeat(200), flags: ["pain", "urgent"] });
    // Flags come back in the fixed order, whatever order they were sent in.
    expect(r).toEqual({ ok: true, details: { duration: 180, bristolType: 7, note: "x".repeat(200), flags: ["urgent", "pain"] } });
    expect(parseDetails({ duration: 1, bristolType: 1 })).toEqual({ ok: true, details: { duration: 1, bristolType: 1, flags: [] } });
  });

  it("counts a Note in characters, not UTF-16 units, trims it, and drops an empty one", () => {
    expect(parseDetails({ note: "💩".repeat(200) }).ok).toBe(true);
    expect(parseDetails({ note: "💩".repeat(201) }).ok).toBe(false);
    expect(parseDetails({ note: "  ok  " })).toEqual({ ok: true, details: { note: "ok", flags: [] } });
    expect(parseDetails({ note: "   " })).toEqual({ ok: true, details: { flags: [] } });
  });

  it("treats null as not given", () => {
    expect(parseDetails({ duration: null, bristolType: null, note: null, flags: null })).toEqual({ ok: true, details: { flags: [] } });
  });

  it("refuses anything out of range", () => {
    for (const bad of [
      { duration: 0 }, { duration: 181 }, { duration: 2.5 }, { duration: "5" },
      { bristolType: 0 }, { bristolType: 8 }, { bristolType: 3.5 },
      { note: "x".repeat(201) }, { note: 5 },
      { flags: ["urgent", "sparkly"] }, { flags: "urgent" }, { flags: ["urgent", "urgent"] },
    ]) {
      expect(parseDetails(bad as never), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });
});

describe("ids and keys", () => {
  it("a Log id is a UUID the client made", () => {
    expect(isLogId("3b241101-e2bb-4255-8caf-4136c566a962")).toBe(true);
    for (const bad of ["", "abc", "3b241101e2bb42558caf4136c566a962", "LOG#x", 5, null, "3B241101-E2BB-4255-8CAF-4136C566A962x"]) expect(isLogId(bad)).toBe(false);
  });

  it("sort keys order Logs by Day then instant, so a range of Days is one key range", () => {
    const k = (day: string, iso: string) => logSortKey(day, at(iso), "00000000-0000-4000-8000-000000000000");
    const keys = [
      k("2026-11-01", "2026-11-01T08:00:00Z"), k("2026-11-01", "2026-11-01T20:00:00Z"),
      k("2026-11-02", "2026-11-02T09:00:00Z"), k("2026-11-30", "2026-12-01T07:59:00Z"),
    ];
    expect([...keys].sort()).toEqual(keys);
    const { from, to } = logSortKeyRange("2026-11-01", "2026-11-30");
    expect(keys.every((x) => x >= from && x <= to)).toBe(true);
    expect(k("2026-10-31", "2026-11-01T06:00:00Z") < from).toBe(true);
    expect(k("2026-12-01", "2026-12-01T08:00:00Z") > to).toBe(true);
  });

  it("caps a Day at 50 Logs", () => {
    expect(LOGS_PER_DAY_MAX).toBe(50);
  });
});
