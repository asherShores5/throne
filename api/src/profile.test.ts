// The caller's Profile (ticket 01): created on the first call by a new sign-in, always found by the
// Cognito sub. Through the real handler on the in-memory table (testing/harness.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { harness } from "./testing/harness";

const h = harness();
beforeEach(() => h.reset());

const PLACEHOLDER = { displayName: "New Profile", avatar: { emoji: "🚽", color: "#7c5cff" } };

describe("first sign-in", () => {
  it("creates the Profile: placeholder Display name, default Avatar, Home zone from the device", async () => {
    const me = await h.call(h.A, "me", { homeZone: "America/Los_Angeles" });
    expect(me).toEqual({ id: h.A.sub, ...PLACEHOLDER, homeZone: "America/Los_Angeles" });
  });

  it("creates exactly one Profile record, however many calls (even at once) come first", async () => {
    const both = await Promise.all([h.call(h.A, "me", { homeZone: "Europe/London" }), h.call(h.A, "me", { homeZone: "Asia/Tokyo" })]);
    // Both racing first calls answer with the one record that was kept, not each its own.
    const stored = await h.call(h.A, "me", { homeZone: "America/Denver" });
    expect(both).toEqual([stored, stored]);
    expect(h.db.dump()).toHaveLength(1);
  });

  it("later calls return the same Profile; a different device zone doesn't overwrite it", async () => {
    const first = await h.call(h.A, "me", { homeZone: "Europe/London" });
    expect(await h.call(h.A, "me", { homeZone: "Asia/Tokyo" })).toEqual(first);
    expect(await h.call(h.A, "me")).toEqual(first);
  });

  it("an unusable device zone gives UTC", async () => {
    expect((await h.call(h.A, "me", { homeZone: "Mars/Olympus_Mons" })).homeZone).toBe("UTC");
    expect((await h.call(h.B, "me")).homeZone).toBe("UTC");
  });

  it("each sign-in gets its own Profile", async () => {
    const a = await h.call(h.A, "me", { homeZone: "UTC" });
    const b = await h.call(h.B, "me", { homeZone: "UTC" });
    expect([a.id, b.id]).toEqual([h.A.sub, h.B.sub]);
    expect(h.db.dump()).toHaveLength(2);
  });
});

describe("identity", () => {
  it("is the Cognito sub; an id the client sends is ignored", async () => {
    await h.call(h.B, "me", { homeZone: "UTC" });
    const me = await h.call(h.A, "me", { homeZone: "UTC", id: h.B.sub, profileId: h.B.sub, sub: h.B.sub });
    expect(me.id).toBe(h.A.sub);
  });

  it("a call with no Cognito identity is refused and creates nothing", async () => {
    const event = h.event(h.A, "me", {});
    await expect(h.raw({ ...event, identity: null })).rejects.toThrow("Unauthorized");
    await expect(h.raw({ ...event, identity: { ...event.identity, sub: "" } as never })).rejects.toThrow("Unauthorized");
    expect(h.db.dump()).toEqual([]);
  });

  it("an unknown field is refused", async () => {
    await expect(h.call(h.A, "dropTable")).rejects.toThrow(/no resolver/);
  });
});
