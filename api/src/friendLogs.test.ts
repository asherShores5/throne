// A Friend's Calendar (ticket 07) through the real handler on the in-memory table: friendLogs needs a
// Friendship (else the same error as "not found"), shows full Details on the Friend's own Days, includes
// Logs from before the Friendship, and stops the moment the Friendship ends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harness, type Caller } from "./testing/harness";

const h = harness();
const NOW = "2026-11-09T18:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const NOT_FOUND = "NotFound: No such Friend.";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(async () => {
  h.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  await h.call(h.A, "me", { homeZone: "America/Los_Angeles" });
  await h.call(h.B, "me", { homeZone: "Asia/Tokyo" });
  await h.call(h.C, "me", { homeZone: "Europe/London" });
});
afterEach(() => vi.useRealTimers());

async function befriend(a: Caller, b: Caller) {
  const code = await h.call(b, "myFriendCode");
  await h.call(a, "sendFriendRequest", { code });
  await h.call(b, "acceptFriendRequest", { from: a.sub });
}
const friendLogs = (who: Caller, friend: unknown, from = "2026-11-01", to = "2026-11-30") =>
  h.call(who, "friendLogs", { friend, from, to });

describe("friendLogs", () => {
  it("shows a Friend's Logs with every Detail, on the Friend's own Days (their Log zone)", async () => {
    await befriend(h.A, h.B);
    // 18:00 UTC on the 9th is already 03:00 on the 10th in Tokyo.
    const log = await h.call(h.B, "createLog", { log: { id: id(1), duration: 5, bristolType: 4, note: "fine", flags: ["urgent"] } });
    expect(log.day).toBe("2026-11-10");
    expect(await friendLogs(h.A, h.B.sub)).toEqual([log]);
    expect(await friendLogs(h.B, h.A.sub)).toEqual([]);
  });

  it("includes Logs from before the Friendship began", async () => {
    vi.setSystemTime(new Date(Date.parse(NOW) - 30 * DAY));
    const old = await h.call(h.B, "createLog", { log: { id: id(2) } });
    vi.setSystemTime(new Date(NOW));
    await befriend(h.A, h.B);
    expect(await friendLogs(h.A, h.B.sub, "2026-10-01", "2026-10-31")).toEqual([old]);
  });

  it("a non-Friend, an unknown id, yourself and junk all get the same 'not found'", async () => {
    await h.call(h.B, "createLog", { log: { id: id(3) } });
    await befriend(h.A, h.C);
    await expect(friendLogs(h.A, h.B.sub)).rejects.toThrow(NOT_FOUND);
    await expect(friendLogs(h.A, "sub-nobody")).rejects.toThrow(NOT_FOUND);
    await expect(friendLogs(h.A, h.A.sub)).rejects.toThrow(NOT_FOUND);
    await expect(friendLogs(h.A, 42)).rejects.toThrow(NOT_FOUND);
    // A Friend of a Friend is still not a Friend.
    await befriend(h.C, h.B);
    await expect(friendLogs(h.A, h.B.sub)).rejects.toThrow(NOT_FOUND);
  });

  it("ending the Friendship removes access at once, for both sides", async () => {
    await befriend(h.A, h.B);
    await h.call(h.B, "createLog", { log: { id: id(4) } });
    expect(await friendLogs(h.A, h.B.sub)).toHaveLength(1);
    await h.call(h.B, "endFriendship", { friend: h.A.sub });
    await expect(friendLogs(h.A, h.B.sub)).rejects.toThrow(NOT_FOUND);
    await expect(friendLogs(h.B, h.A.sub)).rejects.toThrow(NOT_FOUND);
  });

  it("has myLogs' range rules (Days, in order, at most 42)", async () => {
    await befriend(h.A, h.B);
    await expect(friendLogs(h.A, h.B.sub, "2026-11-30", "2026-11-01")).rejects.toThrow(/^ValidationError: /);
    await expect(friendLogs(h.A, h.B.sub, "2026-10-01", "2026-11-30")).rejects.toThrow(/^ValidationError: /);
    await expect(friendLogs(h.A, h.B.sub, "nov", "2026-11-30")).rejects.toThrow(/^ValidationError: /);
  });

  it("a non-Friend learns nothing from the range rules either (Friendship is checked first)", async () => {
    await expect(friendLogs(h.A, h.B.sub, "2026-11-30", "2026-11-01")).rejects.toThrow(NOT_FOUND);
  });
});
