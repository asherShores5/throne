// Reactions and Comments (ticket 08) through the real handler on the in-memory table: who may leave them,
// who sees them (the privacy triangle: A is Friends with B and C, B and C are not, so C never sees B's),
// and the two cascades (deleting a Log, ending a Friendship), each safe to retry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { harness, type Caller } from "./testing/harness";

const TABLE = process.env.TABLE_NAME!;

const h = harness();
const NOW = "2026-11-09T18:00:00.000Z";
const NO_LOG = "NotFound: No such Log.";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;

beforeEach(async () => {
  h.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  for (const who of [h.A, h.B, h.C, h.D]) await h.call(who, "me", { homeZone: "America/Los_Angeles" });
});
afterEach(() => vi.useRealTimers());

async function befriend(a: Caller, b: Caller) {
  const code = await h.call(b, "myFriendCode");
  await h.call(a, "sendFriendRequest", { code });
  await h.call(b, "acceptFriendRequest", { from: a.sub });
}
/** A friends with B and C; B and C are not Friends. A has made one Log (id 1). */
async function triangle() {
  await befriend(h.A, h.B);
  await befriend(h.A, h.C);
  return h.call(h.A, "createLog", { log: { id: id(1), note: "mine" } });
}
const react = (who: Caller, owner: Caller, log: string, emoji: string | null) => h.call(who, "setReaction", { owner: owner.sub, log, emoji });
const comment = (who: Caller, owner: Caller, log: string, n: number, text: string) =>
  h.call(who, "addComment", { owner: owner.sub, log, id: cid(n), text });
const uncomment = (who: Caller, owner: Caller, log: string, n: number) => h.call(who, "deleteComment", { owner: owner.sub, log, id: cid(n) });
const myLog = async (who: Caller, logId = id(1)) => (await h.call(who, "myLogs", { from: "2026-11-01", to: "2026-11-30" })).find((l: { id: string }) => l.id === logId);
const theirLog = async (who: Caller, owner: Caller, logId = id(1)) =>
  (await h.call(who, "friendLogs", { friend: owner.sub, from: "2026-11-01", to: "2026-11-30" })).find((l: { id: string }) => l.id === logId);
/** Every item in the table that isn't a Log, a Profile, or Friend bookkeeping: what a cascade must clear. */
const leftovers = () => h.db.dump().filter((r) => String(r.SK).startsWith("RESPFROM#"));

describe("Reactions", () => {
  it("a Friend puts one of the 6 emoji on a Log, can change it and remove it; one per person per Log", async () => {
    await triangle();
    const after = await react(h.B, h.A, id(1), "👏");
    expect(after.reactions).toEqual([{ author: h.B.sub, emoji: "👏" }]);
    await react(h.B, h.A, id(1), "😂");
    expect((await myLog(h.A)).reactions).toEqual([{ author: h.B.sub, emoji: "😂" }]);
    const removed = await react(h.B, h.A, id(1), null);
    expect(removed.reactions).toEqual([]);
    expect((await myLog(h.A)).reactions).toEqual([]);
    // Removing one that's gone succeeds.
    expect((await react(h.B, h.A, id(1), null)).reactions).toEqual([]);
  });

  it("refuses anything outside the 6", async () => {
    await triangle();
    await expect(react(h.B, h.A, id(1), "🍕")).rejects.toThrow(/^ValidationError: /);
    await expect(react(h.B, h.A, id(1), 7 as unknown as string)).rejects.toThrow(/^ValidationError: /);
  });
});

describe("Comments", () => {
  it("up to 200 characters; a retried add with the same id is one Comment", async () => {
    await triangle();
    const out = await comment(h.B, h.A, id(1), 1, "  nice one  ");
    expect(out.comments).toEqual([{ id: cid(1), author: h.B.sub, text: "nice one", at: NOW }]);
    await comment(h.B, h.A, id(1), 1, "nice one");
    expect((await myLog(h.A)).comments).toHaveLength(1);
    await expect(comment(h.B, h.A, id(1), 2, "x".repeat(201))).rejects.toThrow(/^ValidationError: /);
    await expect(comment(h.B, h.A, id(1), 2, "   ")).rejects.toThrow(/^ValidationError: /);
    await expect(h.call(h.B, "addComment", { owner: h.A.sub, log: id(1), id: "nope", text: "hi" })).rejects.toThrow(/^ValidationError: /);
  });

  it("stops at 20 Comments on a Log", async () => {
    await triangle();
    for (let i = 0; i < 20; i++) await comment(i % 2 ? h.B : h.C, h.A, id(1), i, `c${i}`);
    await expect(comment(h.B, h.A, id(1), 99, "one more")).rejects.toThrow(/^ValidationError: .*20/);
  });

  it("the author can delete their own; the Log owner can delete anyone's; nobody else can", async () => {
    await triangle();
    await comment(h.B, h.A, id(1), 1, "from B");
    await comment(h.C, h.A, id(1), 2, "from C");
    // C can't delete B's (C can't even see it); it stays.
    await uncomment(h.C, h.A, id(1), 1);
    expect((await myLog(h.A)).comments.map((c: { id: string }) => c.id)).toEqual([cid(1), cid(2)]);
    expect((await uncomment(h.B, h.A, id(1), 1)).comments).toEqual([]);
    expect((await uncomment(h.A, h.A, id(1), 2)).comments).toEqual([]);
    // Deleting one that's gone succeeds.
    expect((await uncomment(h.B, h.A, id(1), 1)).comments).toEqual([]);
    expect(leftovers()).toEqual([]);
  });
});

describe("who may react or comment", () => {
  it("only a current Friend of the Log's owner; everyone else gets 'no such Log'", async () => {
    await triangle();
    // D is nobody's Friend; A can't react on their own Log; a Log id that doesn't exist.
    await expect(react(h.D, h.A, id(1), "👏")).rejects.toThrow(NO_LOG);
    await expect(comment(h.D, h.A, id(1), 1, "hi")).rejects.toThrow(NO_LOG);
    await expect(react(h.A, h.A, id(1), "👏")).rejects.toThrow(NO_LOG);
    await expect(comment(h.A, h.A, id(1), 1, "hi")).rejects.toThrow(NO_LOG);
    await expect(react(h.B, h.A, id(9), "👏")).rejects.toThrow(NO_LOG);
    await expect(uncomment(h.D, h.A, id(1), 1)).rejects.toThrow(NO_LOG);
    // A stranger learns nothing from the input rules either.
    await expect(react(h.D, h.A, id(1), "🍕")).rejects.toThrow(NO_LOG);
    await expect(h.call(h.D, "setReaction", { owner: 5, log: id(1), emoji: "👏" })).rejects.toThrow(NO_LOG);
    expect((await myLog(h.A)).reactions).toEqual([]);
  });

  it("an ex-Friend can't", async () => {
    await triangle();
    await h.call(h.A, "endFriendship", { friend: h.B.sub });
    await expect(react(h.B, h.A, id(1), "👏")).rejects.toThrow(NO_LOG);
  });
});

describe("the privacy triangle", () => {
  it("the owner sees all; each Friend sees only their own, in friendLogs and in every mutation's answer", async () => {
    await triangle();
    await react(h.B, h.A, id(1), "👏");
    await comment(h.B, h.A, id(1), 1, "B says");
    const cAfter = await react(h.C, h.A, id(1), "💩");
    expect(cAfter.reactions).toEqual([{ author: h.C.sub, emoji: "💩" }]);
    expect(cAfter.comments).toEqual([]);
    const cComment = await comment(h.C, h.A, id(1), 2, "C says");
    expect(cComment.comments.map((c: { text: string }) => c.text)).toEqual(["C says"]);

    const owner = await myLog(h.A);
    expect(owner.reactions).toEqual([{ author: h.B.sub, emoji: "👏" }, { author: h.C.sub, emoji: "💩" }]);
    expect(owner.comments.map((c: { text: string }) => c.text)).toEqual(["B says", "C says"]);

    const b = await theirLog(h.B, h.A);
    expect(b.reactions).toEqual([{ author: h.B.sub, emoji: "👏" }]);
    expect(b.comments.map((c: { text: string }) => c.text)).toEqual(["B says"]);
    const c = await theirLog(h.C, h.A);
    expect(c.reactions).toEqual([{ author: h.C.sub, emoji: "💩" }]);
    expect(c.comments.map((c: { text: string }) => c.text)).toEqual(["C says"]);

    // The owner deleting a Comment answers with everything; B's delete answers with only B's.
    expect((await uncomment(h.A, h.A, id(1), 2)).comments.map((c: { text: string }) => c.text)).toEqual(["B says"]);
    expect((await uncomment(h.B, h.A, id(1), 1)).reactions).toEqual([{ author: h.B.sub, emoji: "👏" }]);
  });

  it("the owner's own edits keep the Reactions and Comments, even when the Log moves Day", async () => {
    await triangle();
    await react(h.B, h.A, id(1), "👏");
    await comment(h.C, h.A, id(1), 1, "hi");
    const edited = await h.call(h.A, "updateLog", { log: { id: id(1), instant: "2026-11-07T18:00:00Z", bristolType: 4 } });
    expect(edited.day).toBe("2026-11-07");
    expect(edited.reactions).toEqual([{ author: h.B.sub, emoji: "👏" }]);
    expect(edited.comments).toHaveLength(1);
    expect((await theirLog(h.B, h.A)).reactions).toEqual([{ author: h.B.sub, emoji: "👏" }]);
    // And B can still react on it at its new place.
    expect((await react(h.B, h.A, id(1), "😮")).reactions).toEqual([{ author: h.B.sub, emoji: "😮" }]);
  });
});

describe("at the same moment", () => {
  it("two Friends reacting and the owner editing at once all land; none wipes another", async () => {
    await triangle();
    await Promise.all([
      react(h.B, h.A, id(1), "👏"),
      react(h.C, h.A, id(1), "💩"),
      comment(h.B, h.A, id(1), 1, "hi"),
      h.call(h.A, "updateLog", { log: { id: id(1), bristolType: 4 } }),
    ]);
    const log = await myLog(h.A);
    expect(log.bristolType).toBe(4);
    expect(log.reactions).toHaveLength(2);
    expect(log.comments).toHaveLength(1);
  });
});

describe("cascades", () => {
  it("deleting a Log deletes its Reactions and Comments (and a retried delete is fine)", async () => {
    await triangle();
    await react(h.B, h.A, id(1), "👏");
    await comment(h.C, h.A, id(1), 1, "hi");
    expect(leftovers()).toHaveLength(2);
    await h.call(h.A, "deleteLog", { id: id(1) });
    await h.call(h.A, "deleteLog", { id: id(1) });
    expect(leftovers()).toEqual([]);
    expect(h.db.dump().filter((r) => r.reactions || r.comments)).toEqual([]);
    await expect(react(h.B, h.A, id(1), "👏")).rejects.toThrow(NO_LOG);
    // A new Log with a new id starts clean.
    const fresh = await h.call(h.A, "createLog", { log: { id: id(2) } });
    expect(fresh).toMatchObject({ reactions: [], comments: [] });
  });

  it("ending a Friendship deletes what each side left on the other's Logs, and nothing else", async () => {
    await triangle();
    await h.call(h.B, "createLog", { log: { id: id(2) } });
    await react(h.B, h.A, id(1), "👏");
    await comment(h.B, h.A, id(1), 1, "B on A");
    await react(h.A, h.B, id(2), "😂");
    await comment(h.A, h.B, id(2), 2, "A on B");
    await react(h.C, h.A, id(1), "💩");
    await comment(h.C, h.A, id(1), 3, "C on A");

    await h.call(h.B, "endFriendship", { friend: h.A.sub });

    const a = await myLog(h.A);
    expect(a.reactions).toEqual([{ author: h.C.sub, emoji: "💩" }]);
    expect(a.comments.map((c: { text: string }) => c.text)).toEqual(["C on A"]);
    expect(await myLog(h.B, id(2))).toMatchObject({ reactions: [], comments: [] });
    expect(leftovers().map((r) => r.SK)).toEqual([`RESPFROM#${h.C.sub}#${id(1)}`]);
    // Retrying the end (from either side) is fine and changes nothing.
    await h.call(h.B, "endFriendship", { friend: h.A.sub });
    await h.call(h.A, "endFriendship", { friend: h.B.sub });
    expect((await myLog(h.A)).reactions).toEqual([{ author: h.C.sub, emoji: "💩" }]);
  });

  it("a retried end finishes a cleanup that stopped half way", async () => {
    await triangle();
    await react(h.B, h.A, id(1), "👏");
    // The Friendship ends but the cleanup never ran (a Lambda timeout, say): delete just the Friendship items.
    for (const [me, other] of [[h.A, h.B], [h.B, h.A]]) {
      await h.db.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `PROFILE#${me.sub}`, SK: `FRIEND#${other.sub}` } }));
    }
    expect((await myLog(h.A)).reactions).toHaveLength(1);
    await h.call(h.A, "endFriendship", { friend: h.B.sub });
    expect((await myLog(h.A)).reactions).toEqual([]);
    expect(leftovers()).toEqual([]);
  });
});
