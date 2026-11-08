// Logs (ticket 03) through the real handler on the in-memory table (testing/harness.ts): one-tap create,
// Details, time rules, idempotent retries, the per-Day cap, edit/delete and ownership.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harness } from "./testing/harness";

const h = harness();
const NOW = "2026-11-08T20:00:00.000Z"; // 12:00 in Los Angeles
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const minutes = (n: number) => n * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const now = Date.parse(NOW);

beforeEach(async () => {
  h.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  await h.call(h.A, "me", { homeZone: "America/Los_Angeles" });
  await h.call(h.B, "me", { homeZone: "Europe/London" });
});
afterEach(() => vi.useRealTimers());

const create = (who = h.A, log: Record<string, unknown> = {}) => h.call(who, "createLog", { log: { id: id(1), ...log } });
const mine = (who = h.A, from = "2026-11-01", to = "2026-11-30") => h.call(who, "myLogs", { from, to });

describe("one-tap Log", () => {
  it("saves a Log at the server's now, in the Profile's Home zone, with its Day", async () => {
    const log = await create();
    expect(log).toEqual({ id: id(1), instant: NOW, logZone: "America/Los_Angeles", day: "2026-11-08", flags: [] });
    expect(await mine()).toEqual([log]);
  });

  it("takes the client's instant (the moment of the tap) and buckets it by the Log zone, not UTC", async () => {
    // 23:30 on the 7th in Los Angeles is already the 8th in UTC.
    const log = await create(h.A, { instant: "2026-11-08T07:30:00Z" });
    expect(log).toMatchObject({ instant: "2026-11-08T07:30:00.000Z", day: "2026-11-07" });
  });

  it("retrying the same id never makes a second Log; the first one stands", async () => {
    const first = await create(h.A, { instant: iso(now - minutes(10)) });
    const again = await create(h.A, { instant: iso(now - minutes(2)), bristolType: 4 });
    const both = await Promise.all([create(), create()]);
    expect([again, ...both]).toEqual([first, first, first]);
    expect(await mine()).toHaveLength(1);
  });

  it("each Profile's Logs are its own; the same id from two Profiles is two Logs", async () => {
    await create(h.A);
    await create(h.B);
    expect((await mine(h.A)).map((l: { logZone: string }) => l.logZone)).toEqual(["America/Los_Angeles"]);
    expect((await mine(h.B)).map((l: { logZone: string }) => l.logZone)).toEqual(["Europe/London"]);
  });

  it("refuses an id that isn't a UUID", async () => {
    await expect(h.call(h.A, "createLog", { log: { id: "LOG#1" } })).rejects.toThrow(/^ValidationError: /);
    await expect(h.call(h.A, "createLog", { log: {} })).rejects.toThrow(/^ValidationError: /);
  });
});

describe("Details", () => {
  it("can be given on create: Duration, Bristol type, Note and Flags", async () => {
    const log = await create(h.A, { duration: 12, bristolType: 4, note: " after coffee ", flags: ["pain", "urgent"] });
    expect(log).toMatchObject({ duration: 12, bristolType: 4, note: "after coffee", flags: ["urgent", "pain"] });
  });

  it("are validated in the handler", async () => {
    for (const bad of [{ duration: 0 }, { duration: 181 }, { bristolType: 8 }, { note: "x".repeat(201) }, { flags: ["sparkly"] }]) {
      await expect(create(h.A, bad), JSON.stringify(bad)).rejects.toThrow(/^ValidationError: /);
    }
    expect(await mine()).toEqual([]);
  });
});

describe("time rules (server time)", () => {
  it("allow up to 5 minutes ahead and 7 days back", async () => {
    await create(h.A, { id: id(1), instant: iso(now + minutes(5)) });
    await create(h.A, { id: id(2), instant: iso(now - 7 * 24 * minutes(60)) });
    expect(await mine()).toHaveLength(2);
  });

  it("refuse more than 5 minutes ahead or more than 7 days back, with a message the outbox can show", async () => {
    await expect(create(h.A, { instant: iso(now + minutes(6)) })).rejects.toThrow("ValidationError: A Log can't be in the future.");
    await expect(create(h.A, { instant: iso(now - 7 * 24 * minutes(60) - 1000) })).rejects.toThrow("ValidationError: A Log can't be more than 7 days old.");
    await expect(create(h.A, { instant: "yesterday" })).rejects.toThrow(/^ValidationError: /);
    await expect(create(h.A, { instant: "2026-11-08T12:00:00" })).rejects.toThrow(/^ValidationError: /); // no zone: ambiguous
  });
});

describe("cap", () => {
  it("allows 50 Logs a Day per Profile, then refuses; other Days and other Profiles are unaffected", async () => {
    for (let i = 1; i <= 50; i++) await create(h.A, { id: id(i), instant: iso(now - minutes(i)) });
    await expect(create(h.A, { id: id(51), instant: iso(now - minutes(51)) })).rejects.toThrow(/^ValidationError: .*50/);
    await create(h.A, { id: id(52), instant: "2026-11-07T20:00:00Z" }); // the 7th
    await create(h.B, { id: id(53) });
    // Deleting one makes room again; a retry of an existing id still answers, cap or not.
    await h.call(h.A, "deleteLog", { id: id(1) });
    await create(h.A, { id: id(51), instant: iso(now - minutes(51)) });
    await expect(create(h.A, { id: id(2) })).resolves.toMatchObject({ id: id(2) });
    expect((await mine(h.A, "2026-11-08", "2026-11-08"))).toHaveLength(50);
  });

  it("moving a Log onto a full Day is refused too", async () => {
    for (let i = 1; i <= 50; i++) await create(h.A, { id: id(i), instant: iso(now - minutes(i)) });
    await create(h.A, { id: id(99), instant: "2026-11-07T20:00:00Z" });
    await expect(h.call(h.A, "updateLog", { log: { id: id(99), instant: iso(now - minutes(60)) } })).rejects.toThrow(/^ValidationError: .*50/);
    expect((await mine(h.A, "2026-11-07", "2026-11-07")).map((l: { id: string }) => l.id)).toEqual([id(99)]);
  });
});

describe("edit", () => {
  it("replaces the Details; leaving the time out keeps it", async () => {
    await create(h.A, { duration: 5, note: "first" });
    const edited = await h.call(h.A, "updateLog", { log: { id: id(1), bristolType: 3, flags: ["blood"] } });
    expect(edited).toEqual({ id: id(1), instant: NOW, logZone: "America/Los_Angeles", day: "2026-11-08", bristolType: 3, flags: ["blood"] });
    expect(await mine()).toEqual([edited]);
  });

  it("can move the time (and the Day), in the Log's own zone even after the Home zone changed", async () => {
    await create(h.A);
    // A flies to Tokyo; ticket 02 changes the Home zone through the Profile, here it's written directly.
    const [profile] = h.db.dump().filter((r) => r.PK === `PROFILE#${h.A.sub}` && r.SK === "PROFILE");
    h.db.seed({ ...profile, homeZone: "Asia/Tokyo" });
    const moved = await h.call(h.A, "updateLog", { log: { id: id(1), instant: "2026-11-08T07:30:00Z" } });
    expect(moved).toMatchObject({ logZone: "America/Los_Angeles", day: "2026-11-07" });
    expect((await mine(h.A, "2026-11-07", "2026-11-07")).map((l: { id: string }) => l.id)).toEqual([id(1)]);
    expect(await mine(h.A, "2026-11-08", "2026-11-08")).toEqual([]);
    // New Logs take the new Home zone; the old one keeps its Day.
    expect(await create(h.A, { id: id(2) })).toMatchObject({ logZone: "Asia/Tokyo", day: "2026-11-09" });
  });

  it("follows the same time rules for the new time", async () => {
    await create(h.A);
    await expect(h.call(h.A, "updateLog", { log: { id: id(1), instant: iso(now + minutes(6)) } })).rejects.toThrow("ValidationError: A Log can't be in the future.");
    await expect(h.call(h.A, "updateLog", { log: { id: id(1), instant: iso(now - 8 * 24 * minutes(60)) } })).rejects.toThrow("ValidationError: A Log can't be more than 7 days old.");
  });

  it("a Log that has aged past 7 days can't be edited any more", async () => {
    await create(h.A);
    vi.setSystemTime(new Date(now + 7 * 24 * minutes(60) + 1000));
    await expect(h.call(h.A, "updateLog", { log: { id: id(1), note: "late" } })).rejects.toThrow("ValidationError: A Log can't be more than 7 days old.");
  });

  it("validates Details on edit", async () => {
    await create(h.A);
    await expect(h.call(h.A, "updateLog", { log: { id: id(1), duration: 500 } })).rejects.toThrow(/^ValidationError: /);
  });

  it("can't touch someone else's Log: it's just not found", async () => {
    await create(h.A, { note: "mine" });
    await expect(h.call(h.B, "updateLog", { log: { id: id(1), note: "hacked" } })).rejects.toThrow(/^NotFound: /);
    expect((await mine(h.A))[0].note).toBe("mine");
  });
});

describe("delete", () => {
  it("removes the Log (undo uses this); deleting again is fine", async () => {
    await create(h.A);
    expect(await h.call(h.A, "deleteLog", { id: id(1) })).toBe(id(1));
    expect(await mine()).toEqual([]);
    expect(await h.call(h.A, "deleteLog", { id: id(1) })).toBe(id(1));
    // Nothing of the Log is left behind but the Profile and the Day's count.
    expect(h.db.dump().filter((r) => r.PK === `PROFILE#${h.A.sub}` && /^LOG(ID)?#/.test(String(r.SK)))).toEqual([]);
  });

  it("after a delete the same id can be logged again (undo, then tap)", async () => {
    await create(h.A);
    await h.call(h.A, "deleteLog", { id: id(1) });
    await create(h.A, { note: "again" });
    expect((await mine()).map((l: { note?: string }) => l.note)).toEqual(["again"]);
  });

  it("can't delete someone else's Log", async () => {
    await create(h.A);
    await h.call(h.B, "deleteLog", { id: id(1) });
    expect(await mine(h.A)).toHaveLength(1);
  });

  it("refuses an id that isn't a UUID", async () => {
    await expect(h.call(h.A, "deleteLog", { id: "PROFILE" })).rejects.toThrow(/^ValidationError: /);
  });
});

describe("myLogs", () => {
  it("lists the caller's Logs on a range of Days, in time order, and nobody else's", async () => {
    await create(h.A, { id: id(3), instant: "2026-11-02T18:00:00Z" });
    await create(h.A, { id: id(1), instant: "2026-11-02T16:00:00Z" });
    await create(h.A, { id: id(2), instant: "2026-11-08T07:30:00Z" }); // the 7th, LA
    await create(h.B, { id: id(4), instant: "2026-11-05T12:00:00Z" });
    expect((await mine(h.A, "2026-11-02", "2026-11-07")).map((l: { id: string }) => l.id)).toEqual([id(1), id(3), id(2)]);
    expect((await mine(h.A, "2026-11-03", "2026-11-06"))).toEqual([]);
  });

  it("takes a month-sized range at most, of real Days", async () => {
    await expect(mine(h.A, "2026-11-30", "2026-11-01")).rejects.toThrow(/^ValidationError: /);
    await expect(mine(h.A, "2026-10-01", "2026-11-30")).rejects.toThrow(/^ValidationError: /);
    await expect(mine(h.A, "2026-11-01", "2026-11-31")).rejects.toThrow(/^ValidationError: /);
    await expect(mine(h.A, "2026-10-26", "2026-12-06")).resolves.toEqual([]); // a 6-week Calendar grid
  });
});
