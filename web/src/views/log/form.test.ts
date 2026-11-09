// The Log details form: what it shows for a Log (in the Log's own zone) and what it sends back.
import { describe, expect, it } from "vitest";
import type { Log } from "../../api/log";
import { editFor, formFor } from "./form";

const LOG: Log = { id: "00000000-0000-4000-8000-000000000001", instant: "2026-11-08T07:30:12.345Z", logZone: "America/Los_Angeles", day: "2026-11-07", flags: ["pain"], bristolType: 4 };

/** "Now" for the time rules: 10:00 on 8 Nov in Los Angeles. */
const NOW = Date.parse("2026-11-08T18:00:00Z");

describe("Log details form", () => {
  it("shows the Log's Day and time in its Log zone, and its Details", () => {
    expect(formFor(LOG)).toEqual({ day: "2026-11-07", time: "23:30", duration: "", bristolType: 4, note: "", flags: ["pain"] });
  });

  it("an untouched time keeps the exact instant (no edit to the time is sent)", () => {
    expect(editFor(LOG, formFor(LOG))).toEqual({ ok: true, edit: { id: LOG.id, bristolType: 4, flags: ["pain"] } });
  });

  it("a changed Day or time is read in the Log zone and sent as an instant", () => {
    const r = editFor(LOG, { ...formFor(LOG), day: "2026-11-06", time: "08:15" }, NOW);
    expect(r).toEqual({ ok: true, edit: { id: LOG.id, instant: "2026-11-06T16:15:00.000Z", bristolType: 4, flags: ["pain"] } });
  });

  it("sends every Detail, clearing the ones emptied", () => {
    const r = editFor(LOG, { ...formFor(LOG), duration: "12", bristolType: undefined, note: " hi ", flags: [] });
    expect(r).toEqual({ ok: true, edit: { id: LOG.id, duration: 12, note: "hi", flags: [] } });
  });

  it("refuses what the server would refuse, with its message", () => {
    expect(editFor(LOG, { ...formFor(LOG), duration: "181" })).toEqual({ ok: false, error: "Duration is 1 to 180 minutes." });
    expect(editFor(LOG, { ...formFor(LOG), duration: "abc" })).toEqual({ ok: false, error: "Duration is 1 to 180 minutes." });
    expect(editFor(LOG, { ...formFor(LOG), time: "" })).toMatchObject({ ok: false });
  });

  it("refuses a time in the future or more than 7 days back with the server's rule, before anything is queued", () => {
    expect(editFor(LOG, { ...formFor(LOG), day: "2026-11-08", time: "11:30" }, NOW)).toEqual({ ok: false, error: "A Log can't be in the future." });
    expect(editFor(LOG, { ...formFor(LOG), day: "2026-10-31", time: "09:00" }, NOW)).toEqual({ ok: false, error: "A Log can't be more than 7 days old." });
    expect(editFor(LOG, { ...formFor(LOG), day: "2026-11-08", time: "10:04" }, NOW)).toMatchObject({ ok: true });
  });
});
