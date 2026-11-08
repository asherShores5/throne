import { describe, expect, it } from "vitest";
import { AVATAR_COLORS, AVATAR_EMOJI, DEFAULT_HOME_ZONE, homeZoneOr, isHomeZone, newProfile } from "./profile";

describe("Avatar choices", () => {
  it("a fixed palette of 8 distinct colors and a fixed list of distinct emoji", () => {
    expect(AVATAR_COLORS).toHaveLength(8);
    expect(new Set(AVATAR_COLORS).size).toBe(8);
    for (const c of AVATAR_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(AVATAR_EMOJI.length).toBeGreaterThanOrEqual(8);
    expect(new Set(AVATAR_EMOJI).size).toBe(AVATAR_EMOJI.length);
  });
});

describe("Home zone", () => {
  it("accepts IANA zone names", () => {
    for (const z of ["America/Los_Angeles", "Europe/London", "Pacific/Kiritimati", "UTC"]) expect(isHomeZone(z)).toBe(true);
  });

  it("refuses anything that isn't a zone name", () => {
    for (const z of ["", "Mars/Olympus", "not a zone", "-08:00", 42, null, undefined, "A".repeat(80)]) expect(isHomeZone(z)).toBe(false);
  });

  it("falls back to UTC when the device sends nothing usable", () => {
    expect(DEFAULT_HOME_ZONE).toBe("UTC");
    expect(homeZoneOr("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(homeZoneOr("Nowhere/Land")).toBe("UTC");
    expect(homeZoneOr(undefined)).toBe("UTC");
  });
});

describe("newProfile", () => {
  it("a placeholder Display name, the default Avatar and the device's Home zone", () => {
    expect(newProfile("America/Denver")).toEqual({
      displayName: "New Profile",
      avatar: { emoji: AVATAR_EMOJI[0], color: AVATAR_COLORS[0] },
      homeZone: "America/Denver",
    });
    expect(newProfile("bogus").homeZone).toBe("UTC");
  });
});
