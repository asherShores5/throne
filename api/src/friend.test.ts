// Friends (ticket 06) through the real handler on the in-memory table (testing/harness.ts): Friend codes,
// Friend requests (send, accept, decline, cancel, auto-accept), the cap of 3 under races, the daily send
// limit, "not found" that reveals nothing, ending a Friendship, and isFriend for later tickets.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harness, type Caller } from "./testing/harness";

const h = harness();
const NOW = "2026-11-09T18:00:00.000Z";
const HOUR = 60 * 60 * 1000;
const NOT_FOUND = "NotFound: No Profile has that Friend code.";

// Profiles beyond A-D, for the cap tests (a Profile plus 3 Friends plus one more).
const E: Caller = { sub: "sub-e", username: "e" };
const F: Caller = { sub: "sub-f", username: "f" };

const { isFriend } = await import("./resolvers/friend");

beforeEach(async () => {
  h.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  for (const [who, name] of [[h.A, "Ana"], [h.B, "Ben"], [h.C, "Cy"], [h.D, "Dee"], [E, "Eve"], [F, "Fox"]] as const) {
    await h.call(who, "me", { homeZone: "America/Los_Angeles" });
    await h.call(who, "updateProfile", { input: { displayName: name } });
  }
});
afterEach(() => vi.useRealTimers());

const code = (who: Caller): Promise<string> => h.call(who, "myFriendCode");
const send = async (from: Caller, to: Caller) => h.call(from, "sendFriendRequest", { code: await code(to) });
/** The opaque id of `from`'s waiting request (to `to`, found by the code typed; else the first). */
async function sentId(from: Caller, to?: Caller): Promise<string> {
  const sent: { id: string; code: string }[] = await h.call(from, "sentFriendRequests");
  const want = to && (await code(to));
  return (want ? sent.find((r) => r.code === want) : sent[0])!.id;
}
const accept = (who: Caller, from: Caller) => h.call(who, "acceptFriendRequest", { from: from.sub });
const friendsOf = async (who: Caller) => (await h.call(who, "friends")).map((f: { displayName: string }) => f.displayName);
async function befriend(a: Caller, b: Caller) {
  await send(a, b);
  await accept(b, a);
}

describe("Friend code", () => {
  it("is 6 characters from the unambiguous alphabet, shown as two groups of 3, and stays the same", async () => {
    const c = await code(h.A);
    expect(c).toMatch(/^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/);
    expect(await code(h.A)).toBe(c);
    expect(await code(h.B)).not.toBe(c);
  });

  it("two first calls at once still leave one code", async () => {
    const [x, y] = await Promise.all([code(h.A), code(h.A)]);
    expect(x).toBe(y);
    expect(h.db.dump().filter((r) => String(r.PK).startsWith("FRIENDCODE#"))).toHaveLength(1);
  });

  it("regenerating gives a new code; the old one is 'not found'", async () => {
    const old = await code(h.A);
    const fresh = await h.call(h.A, "regenerateFriendCode");
    expect(fresh).not.toBe(old);
    expect(await code(h.A)).toBe(fresh);
    await expect(h.call(h.B, "sendFriendRequest", { code: old })).rejects.toThrow(NOT_FOUND);
    expect(await h.call(h.B, "sendFriendRequest", { code: fresh })).toBe("SENT");
  });

  it("a code can be typed in any case, without the dash", async () => {
    const c = (await code(h.B)).replace("-", "").toLowerCase();
    expect(await h.call(h.A, "sendFriendRequest", { code: c })).toBe("SENT");
  });

  it("a code that's already taken is never handed out twice (collision retried)", async () => {
    const { setFriendCodeBytes } = await import("./resolvers/friend");
    // Every Profile draws the same first bytes; the second has to retry.
    let n = 0;
    setFriendCodeBytes(() => (n++ < 2 ? [0, 0, 0, 0, 0, 0] : [1, 1, 1, 1, 1, 1]));
    try {
      expect(await code(h.A)).toBe("222-222");
      expect(await code(h.B)).toBe("333-333");
    } finally {
      setFriendCodeBytes(undefined);
    }
  });
});

describe("Friend request", () => {
  it("the receiver sees the sender's Display name and Avatar; the sender sees only the code they typed", async () => {
    const bCode = await code(h.B);
    expect(await h.call(h.A, "sendFriendRequest", { code: bCode })).toBe("SENT");
    expect(await h.call(h.B, "friendRequests")).toEqual([
      { id: h.A.sub, displayName: "Ana", avatar: { emoji: "🚽", color: "#7c5cff" }, sentAt: NOW },
    ]);
    const sent = await h.call(h.A, "sentFriendRequests");
    expect(sent).toEqual([{ id: expect.any(String), code: bCode, sentAt: NOW }]);
    expect(await h.call(h.A, "friendRequests")).toEqual([]);
  });

  it("a sent request's id is opaque: never the receiver's Profile id (story 62)", async () => {
    await send(h.A, h.B);
    await send(h.A, h.C);
    const sent = await h.call(h.A, "sentFriendRequests");
    expect(sent).toHaveLength(2);
    for (const r of sent) {
      expect(r.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(JSON.stringify(r)).not.toContain(h.B.sub);
      expect(JSON.stringify(r)).not.toContain(h.C.sub);
    }
    expect(sent[0].id).not.toBe(sent[1].id);
    // The receiver's id cancels nothing; a made-up or malformed id is NotFound or a no-op.
    await expect(h.call(h.A, "cancelFriendRequest", { request: h.B.sub })).rejects.toThrow("NotFound");
    expect(await h.call(h.A, "cancelFriendRequest", { request: "A".repeat(22) })).toBe(true);
    expect(await h.call(h.B, "friendRequests")).toHaveLength(1);
    // Another Profile can't cancel A's request with its id.
    expect(await h.call(h.C, "cancelFriendRequest", { request: sent[0].id })).toBe(true);
    expect(await h.call(h.A, "sentFriendRequests")).toHaveLength(2);
  });

  it("sending again to the same code is the same request", async () => {
    await send(h.A, h.B);
    vi.setSystemTime(new Date(Date.parse(NOW) + HOUR));
    expect(await send(h.A, h.B)).toBe("SENT");
    expect(await h.call(h.B, "friendRequests")).toHaveLength(1);
    expect((await h.call(h.B, "friendRequests"))[0].sentAt).toBe(NOW);
  });

  it("accepting makes both Friends (each sees the other) and clears the request", async () => {
    await send(h.A, h.B);
    const friend = await accept(h.B, h.A);
    expect(friend).toEqual({ id: h.A.sub, displayName: "Ana", avatar: { emoji: "🚽", color: "#7c5cff" }, since: NOW });
    expect(await friendsOf(h.A)).toEqual(["Ben"]);
    expect(await friendsOf(h.B)).toEqual(["Ana"]);
    expect(await h.call(h.B, "friendRequests")).toEqual([]);
    expect(await h.call(h.A, "sentFriendRequests")).toEqual([]);
  });

  it("only the receiver can accept; accepting a request that isn't there is NotFound", async () => {
    await send(h.A, h.B);
    await expect(accept(h.A, h.B)).rejects.toThrow("NotFound");
    await expect(accept(h.C, h.A)).rejects.toThrow("NotFound");
    expect(await friendsOf(h.A)).toEqual([]);
  });

  it("declining removes it for both, without making Friends", async () => {
    await send(h.A, h.B);
    expect(await h.call(h.B, "declineFriendRequest", { from: h.A.sub })).toBe(true);
    expect(await h.call(h.B, "friendRequests")).toEqual([]);
    expect(await h.call(h.A, "sentFriendRequests")).toEqual([]);
    expect(await friendsOf(h.B)).toEqual([]);
    expect(await h.call(h.B, "declineFriendRequest", { from: h.A.sub })).toBe(true);
  });

  it("the sender can cancel it", async () => {
    await send(h.A, h.B);
    expect(await h.call(h.A, "cancelFriendRequest", { request: await sentId(h.A) })).toBe(true);
    expect(await h.call(h.B, "friendRequests")).toEqual([]);
    expect(await h.call(h.A, "sentFriendRequests")).toEqual([]);
    await expect(accept(h.B, h.A)).rejects.toThrow("NotFound");
  });

  it("sending to someone who already sent you one makes you Friends at once", async () => {
    await send(h.A, h.B);
    expect(await send(h.B, h.A)).toBe("FRIENDS");
    expect(await friendsOf(h.A)).toEqual(["Ben"]);
    expect(await friendsOf(h.B)).toEqual(["Ana"]);
    for (const who of [h.A, h.B]) {
      expect(await h.call(who, "friendRequests")).toEqual([]);
      expect(await h.call(who, "sentFriendRequests")).toEqual([]);
    }
  });

  it("two requests crossing at once still end as one Friendship with no requests left", async () => {
    const [aCode, bCode] = [await code(h.A), await code(h.B)];
    await Promise.all([h.call(h.A, "sendFriendRequest", { code: bCode }), h.call(h.B, "sendFriendRequest", { code: aCode })]);
    // Whichever way it fell, one accept (if still needed) finishes it and nothing is left over.
    if ((await friendsOf(h.A)).length === 0) await accept(h.B, h.A);
    expect(await friendsOf(h.A)).toEqual(["Ben"]);
    for (const who of [h.A, h.B]) {
      expect(await h.call(who, "friendRequests")).toEqual([]);
      expect(await h.call(who, "sentFriendRequests")).toEqual([]);
    }
  });
});

describe("'not found' reveals nothing", () => {
  it("a bad code, your own code and an existing Friend's code all fail the same way", async () => {
    await befriend(h.A, h.B);
    const errors = await Promise.all(
      ["ZZZ-ZZZ", "nope", await code(h.A), await code(h.B)].map((c) => h.call(h.A, "sendFriendRequest", { code: c }).then(() => "sent", (e: Error) => e.message)),
    );
    expect(errors).toEqual([NOT_FOUND, NOT_FOUND, NOT_FOUND, NOT_FOUND]);
  });

  it("a non-Friend can't read anyone's Friends or requests; every read is the caller's own", async () => {
    await befriend(h.A, h.B);
    expect(await h.call(h.C, "friends")).toEqual([]);
    expect(await h.call(h.C, "friendRequests")).toEqual([]);
    expect(await h.call(h.C, "sentFriendRequests")).toEqual([]);
  });
});

describe("limits", () => {
  it("at most 10 sends in any 24 hours, counting misses; the window rolls", async () => {
    for (let i = 0; i < 9; i++) await expect(h.call(h.A, "sendFriendRequest", { code: "ZZZ-ZZZ" })).rejects.toThrow(NOT_FOUND);
    vi.setSystemTime(new Date(Date.parse(NOW) + HOUR));
    expect(await send(h.A, h.B)).toBe("SENT"); // the 10th
    await expect(send(h.A, h.C)).rejects.toThrow("ValidationError: You can send 10 Friend requests a day.");
    // 24 hours after the first nine, they no longer count.
    vi.setSystemTime(new Date(Date.parse(NOW) + 24 * HOUR + 1));
    expect(await send(h.A, h.C)).toBe("SENT");
  });

  it("at most 5 sent requests waiting at once; re-sending one already waiting still works", async () => {
    const G: Caller = { sub: "sub-g", username: "g" };
    await h.call(G, "me", { homeZone: "America/Los_Angeles" });
    for (const to of [h.B, h.C, h.D, E, F]) expect(await send(h.A, to)).toBe("SENT");
    await expect(send(h.A, G)).rejects.toThrow("ValidationError: You have 5 Friend requests waiting. Cancel one first.");
    expect(await send(h.A, h.B)).toBe("SENT");
    await h.call(h.A, "cancelFriendRequest", { request: await sentId(h.A, h.B) });
    expect(await send(h.A, G)).toBe("SENT");
  });

  it("the daily limit holds when sends race", async () => {
    const codes = await Promise.all([h.B, h.C, h.D, E, F].map(code));
    for (let i = 0; i < 8; i++) await h.call(h.A, "sendFriendRequest", { code: "ZZZ-ZZZ" }).catch(() => {});
    const results = await Promise.all(codes.map((c) => h.call(h.A, "sendFriendRequest", { code: c }).then(() => "ok", (e: Error) => e.message)));
    expect(results.filter((r) => r === "ok")).toHaveLength(2);
  });

  it("you can't send or accept with 3 Friends", async () => {
    await befriend(h.B, h.A);
    await befriend(h.C, h.A);
    await send(E, h.A);
    await befriend(h.D, h.A);
    await expect(send(h.A, F)).rejects.toThrow("ValidationError: You already have 3 Friends.");
    await expect(accept(h.A, E)).rejects.toThrow("ValidationError: You already have 3 Friends.");
    // Sending back to E (which would auto-accept) is refused the same way.
    await expect(send(h.A, E)).rejects.toThrow("ValidationError: You already have 3 Friends.");
    expect(await friendsOf(h.A)).toEqual(["Ben", "Cy", "Dee"]);
  });

  it("you can't send to, or accept from, someone who already has 3 Friends", async () => {
    await befriend(h.B, h.A);
    await befriend(h.C, h.A);
    await send(h.A, E);
    await befriend(h.D, h.A); // A is now full, with its request to E still waiting
    await expect(send(F, h.A)).rejects.toThrow("ValidationError: They already have 3 Friends.");
    await expect(accept(E, h.A)).rejects.toThrow("ValidationError: They already have 3 Friends.");
    expect(await friendsOf(E)).toEqual([]);
    expect(await friendsOf(h.A)).toEqual(["Ben", "Cy", "Dee"]);
    // The request stays, so E can still accept once A has room.
    await h.call(h.A, "endFriendship", { friend: h.D.sub });
    await accept(E, h.A);
    expect(await friendsOf(E)).toEqual(["Ana"]);
  });

  it("two accepts at once can't take a Profile past 3 Friends", async () => {
    await befriend(h.B, h.A);
    await befriend(h.C, h.A);
    await send(h.D, h.A);
    await send(E, h.A);
    const results = await Promise.all([accept(h.A, h.D), accept(h.A, E)].map((p) => p.then(() => "ok", (e: Error) => e.message)));
    expect(results.sort()).toEqual(["ValidationError: You already have 3 Friends.", "ok"]);
    expect(await friendsOf(h.A)).toHaveLength(3);
  });

  it("two Profiles accepting the same third Profile at once can't take it past 3", async () => {
    await befriend(h.A, E);
    await befriend(h.B, E);
    await send(E, h.C);
    await send(E, h.D);
    const results = await Promise.all([accept(h.C, E), accept(h.D, E)].map((p) => p.then(() => "ok", (e: Error) => e.message)));
    expect(results.sort()).toEqual(["ValidationError: They already have 3 Friends.", "ok"]);
    expect(await friendsOf(E)).toHaveLength(3);
  });
});

describe("ending a Friendship", () => {
  it("removes it for both and frees a place under the cap; retrying succeeds", async () => {
    await befriend(h.A, h.B);
    await befriend(h.A, h.C);
    await befriend(h.A, h.D);
    expect(await h.call(h.A, "endFriendship", { friend: h.B.sub })).toBe(true);
    expect(await friendsOf(h.A)).toEqual(["Cy", "Dee"]);
    expect(await friendsOf(h.B)).toEqual([]);
    expect(await h.call(h.A, "endFriendship", { friend: h.B.sub })).toBe(true);
    expect(await h.call(h.B, "endFriendship", { friend: h.A.sub })).toBe(true);
    await befriend(h.A, E);
    expect(await friendsOf(h.A)).toEqual(["Cy", "Dee", "Eve"]);
  });

  it("either side can end it", async () => {
    await befriend(h.A, h.B);
    await h.call(h.B, "endFriendship", { friend: h.A.sub });
    expect(await friendsOf(h.A)).toEqual([]);
  });
});

describe("isFriend (for reads of another Profile's Logs, Profile or Summary)", () => {
  it("is true both ways only while a Friendship exists, and false for yourself", async () => {
    expect(await isFriend(h.A.sub, h.B.sub)).toBe(false);
    await befriend(h.A, h.B);
    expect(await isFriend(h.A.sub, h.B.sub)).toBe(true);
    expect(await isFriend(h.B.sub, h.A.sub)).toBe(true);
    expect(await isFriend(h.A.sub, h.C.sub)).toBe(false);
    expect(await isFriend(h.A.sub, h.A.sub)).toBe(false);
    await h.call(h.A, "endFriendship", { friend: h.B.sub });
    expect(await isFriend(h.B.sub, h.A.sub)).toBe(false);
  });

  it("a Friend's Display name changes show up in the Friends list", async () => {
    await befriend(h.A, h.B);
    await h.call(h.B, "updateProfile", { input: { displayName: "Benji" } });
    expect(await friendsOf(h.A)).toEqual(["Benji"]);
  });
});
