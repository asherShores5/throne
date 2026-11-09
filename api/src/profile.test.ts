// The caller's Profile (ticket 01): created on the first call by a new sign-in, always found by the
// Cognito sub. Through the real handler on the in-memory table (testing/harness.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { harness } from "./testing/harness";

const h = harness();
beforeEach(() => h.reset());

const PLACEHOLDER = { displayName: "New Profile", avatar: { emoji: "🚽", color: "#7c5cff" }, homeZoneAuto: true };

describe("first sign-in", () => {
  it("creates the Profile: placeholder Display name, default Avatar, Home zone from the device", async () => {
    const me = await h.call(h.A, "me", { homeZone: "America/Los_Angeles" });
    expect(me).toEqual({ id: h.A.sub, ...PLACEHOLDER, homeZone: "America/Los_Angeles" });
  });

  it("creates exactly one Profile record, however many calls (even at once) come first", async () => {
    const both = await Promise.all([h.call(h.A, "me", { homeZone: "Europe/London" }), h.call(h.A, "me", { homeZone: "Asia/Tokyo" })]);
    // Both racing first calls answer with the one record that was kept, not each its own.
    const stored = await h.call(h.A, "me");
    expect(both).toEqual([stored, stored]);
    expect(h.db.dump()).toHaveLength(1);
  });

  it("later calls return the same Profile; a call with no usable device zone changes nothing", async () => {
    const first = await h.call(h.A, "me", { homeZone: "Europe/London" });
    expect(await h.call(h.A, "me")).toEqual(first);
    expect(await h.call(h.A, "me", { homeZone: "Nowhere/Land" })).toEqual(first);
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

describe("Home zone follows the device", () => {
  it("until overridden, each call with a new device zone moves the Home zone", async () => {
    await h.call(h.A, "me", { homeZone: "Europe/London" });
    expect((await h.call(h.A, "me", { homeZone: "Asia/Tokyo" })).homeZone).toBe("Asia/Tokyo");
    expect((await h.call(h.A, "me")).homeZone).toBe("Asia/Tokyo");
  });

  it("an override sticks whatever the device says; following again takes the device's zone", async () => {
    await h.call(h.A, "me", { homeZone: "Europe/London" });
    const set = await h.call(h.A, "updateProfile", { input: { homeZone: "America/New_York", homeZoneAuto: false } });
    expect(set).toMatchObject({ homeZone: "America/New_York", homeZoneAuto: false });
    expect((await h.call(h.A, "me", { homeZone: "Asia/Tokyo" })).homeZone).toBe("America/New_York");
    const back = await h.call(h.A, "updateProfile", { input: { homeZone: "Asia/Tokyo", homeZoneAuto: true } });
    expect(back).toMatchObject({ homeZone: "Asia/Tokyo", homeZoneAuto: true });
    expect((await h.call(h.A, "me", { homeZone: "Europe/Paris" })).homeZone).toBe("Europe/Paris");
  });

  it("refuses a zone that isn't an IANA name", async () => {
    for (const homeZone of ["Mars/Olympus_Mons", "-08:00", ""]) {
      await expect(h.call(h.A, "updateProfile", { input: { homeZone, homeZoneAuto: false } })).rejects.toThrow(/^ValidationError/);
    }
    await expect(h.call(h.A, "updateProfile", { input: { homeZoneAuto: false } })).rejects.toThrow(/^ValidationError/);
  });
});

describe("editing the Profile", () => {
  it("sets the Display name (trimmed) and Avatar; the next read has them", async () => {
    await h.call(h.A, "me", { homeZone: "UTC" });
    const p = await h.call(h.A, "updateProfile", { input: { displayName: "  Sam  ", avatar: { emoji: "🦆", color: "#2b8a3e" } } });
    expect(p).toEqual({ id: h.A.sub, displayName: "Sam", avatar: { emoji: "🦆", color: "#2b8a3e" }, homeZone: "UTC", homeZoneAuto: true });
    expect(await h.call(h.A, "me")).toEqual(p);
  });

  it("changes only the fields sent", async () => {
    await h.call(h.A, "updateProfile", { input: { displayName: "Sam", avatar: { emoji: "🦆", color: "#2b8a3e" } } });
    const p = await h.call(h.A, "updateProfile", { input: { displayName: "Sammy" } });
    expect(p).toMatchObject({ displayName: "Sammy", avatar: { emoji: "🦆", color: "#2b8a3e" } });
  });

  it("works on a brand-new sign-in (the sign-up form sends it straight after the first sign-in)", async () => {
    const p = await h.call(h.B, "updateProfile", { input: { displayName: "Bo", avatar: { emoji: "🐸", color: "#1c7ed6" }, homeZone: "Europe/London" } });
    expect(p).toMatchObject({ id: h.B.sub, displayName: "Bo", homeZone: "Europe/London", homeZoneAuto: true });
    expect(h.db.dump().filter((r) => r.SK === "PROFILE")).toHaveLength(1);
  });

  it("refuses a bad Display name or an Avatar not from the fixed choices, changing nothing", async () => {
    const before = await h.call(h.A, "me", { homeZone: "UTC" });
    for (const input of [{ displayName: "" }, { displayName: "x".repeat(25) }, { avatar: { emoji: "💩", color: "#2b8a3e" } }, { avatar: { emoji: "🦆", color: "red" } }]) {
      await expect(h.call(h.A, "updateProfile", { input })).rejects.toThrow(/^ValidationError/);
    }
    expect(await h.call(h.A, "me")).toEqual(before);
  });

  it("only ever edits the caller's own Profile", async () => {
    await h.call(h.B, "me", { homeZone: "UTC" });
    await h.call(h.A, "updateProfile", { input: { displayName: "Not Bo", id: h.B.sub } });
    expect((await h.call(h.B, "me")).displayName).toBe("New Profile");
  });
});
