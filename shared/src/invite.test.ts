import { describe, expect, it } from "vitest";
import { INVITE_TTL_MS, MAX_OPEN_INVITES, inviteLink, inviteTokenFromHash, isInviteToken } from "./invite";

describe("Invite token", () => {
  it("is exactly 128 bits as unpadded base64url (22 characters, the last carrying 2 bits)", () => {
    // 16 bytes 0x00..0x0f and 16 bytes 0xff, encoded independently of the code under test.
    expect(isInviteToken("AAECAwQFBgcICQoLDA0ODw")).toBe(true);
    expect(isInviteToken("_____________________w")).toBe(true);
  });

  it("refuses anything else", () => {
    for (const t of ["", "short", "A".repeat(21), "A".repeat(23), "A".repeat(21) + "!", "A".repeat(21) + "B", 12, null, undefined])
      expect(isInviteToken(t)).toBe(false);
  });
});

describe("Invite rules", () => {
  it("an Invite lasts 7 days; a Profile has at most 3 open", () => {
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(MAX_OPEN_INVITES).toBe(3);
  });
});

describe("Invite link", () => {
  it("carries the token after # (browsers never send it to the server) and reads it back", () => {
    const t = "AAECAwQFBgcICQoLDA0ODw";
    expect(inviteLink("https://throne.ashershores.com", t)).toBe("https://throne.ashershores.com/invite#AAECAwQFBgcICQoLDA0ODw");
    expect(inviteTokenFromHash("#AAECAwQFBgcICQoLDA0ODw")).toBe(t);
    expect(inviteTokenFromHash("#nope")).toBeUndefined();
    expect(inviteTokenFromHash("")).toBeUndefined();
  });
});
