import { describe, expect, it } from "vitest";
import {
  FRIEND_CODE_ALPHABET, FRIEND_REQUEST_WINDOW_MS, FRIEND_REQUESTS_PER_WINDOW, MAX_FRIENDS, formatFriendCode, friendCodeFrom,
  parseFriendCode, sendsInWindow,
} from "./friend";

describe("Friend code", () => {
  it("uses an alphabet without look-alikes (no 0, O, 1, I or L)", () => {
    expect(FRIEND_CODE_ALPHABET).toBe("23456789ABCDEFGHJKMNPQRSTUVWXYZ");
  });

  it("is shown as two groups of 3", () => {
    expect(formatFriendCode("4KQ9XM")).toBe("4KQ-9XM");
  });

  it("reads back what a person types: any case, with or without the dash or spaces", () => {
    for (const typed of ["4KQ-9XM", "4kq9xm", " 4kq 9xm ", "4KQ–9XM"]) expect(parseFriendCode(typed)).toBe("4KQ9XM");
  });

  it("refuses anything that can't be a code", () => {
    for (const t of ["", "4KQ9X", "4KQ9XMM", "4KQ-9X0", "OKQ9XM", "1KQ9XM", "IKQ9XM", "LKQ9XM", "4KQ!XM", 123456, null, undefined])
      expect(parseFriendCode(t)).toBeUndefined();
  });

  it("is made from random bytes, each picking one character; bytes that would bias the pick are skipped", () => {
    // 31 characters: bytes 0..247 (8 * 31) map evenly; 248..255 are skipped.
    expect(friendCodeFrom([0, 1, 2, 30, 31, 61])).toBe("234Z2Z");
    expect(friendCodeFrom([255, 248, 0, 1, 2, 3, 4, 5])).toBe("234567");
    expect(friendCodeFrom([0, 1, 2, 255])).toBeUndefined(); // not enough usable bytes
  });
});

describe("Friend limits", () => {
  it("a Profile has at most 3 Friends and sends at most 10 Friend requests in any 24 hours", () => {
    expect(MAX_FRIENDS).toBe(3);
    expect(FRIEND_REQUESTS_PER_WINDOW).toBe(10);
    expect(FRIEND_REQUEST_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("counts only the sends inside the rolling day", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    expect(sendsInWindow([now - day - 1, now - day, now - 1000, now], now)).toEqual([now - 1000, now]);
  });
});
