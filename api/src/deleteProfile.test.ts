// Delete Profile (ticket 11) through the real handler and the real Notifier on the in-memory table. A Profile
// with one of everything deletes itself; afterwards no item anywhere names them or holds what they made, their
// Friends' Calendars, Friend lists and Summaries (stored and future) no longer show them, the Cognito user is
// gone, and a deletion stopped at any step finishes when it's run again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SCHEDULED_RUN } from "@throne/shared";
import { harness, type Caller } from "./testing/harness";

const h = harness();
const E: Caller = { sub: "sub-e", username: "e" };
const LA = "America/Los_Angeles";
const TOKYO = "Asia/Tokyo";
const MON_8_LA = "2026-11-09T16:00:00.000Z";
const MON_8_TOKYO = "2026-11-08T23:00:00.000Z";
const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
let n = 0;
const uuid = (prefix: string) => `00000000-0000-4000-${prefix}-${String(++n).padStart(12, "0")}`;
const setNow = (iso: string) => vi.setSystemTime(new Date(iso));

async function profile(who: Caller, name: string, zone: string) {
  await h.call(who, "me", { homeZone: zone });
  await h.call(who, "updateProfile", { input: { displayName: name, homeZone: zone, homeZoneAuto: false } });
}
async function befriend(a: Caller, b: Caller) {
  const code = await h.call(b, "myFriendCode");
  await h.call(a, "sendFriendRequest", { code });
  await h.call(b, "acceptFriendRequest", { from: a.sub });
}
async function logAt(who: Caller, iso: string, extra: Record<string, unknown> = {}) {
  setNow(iso);
  const id = uuid("8000");
  await h.call(who, "createLog", { log: { id, instant: iso, ...extra } });
  return id;
}
const react = (who: Caller, owner: Caller, log: string, emoji: string) => h.call(who, "setReaction", { owner: owner.sub, log, emoji });
const comment = (who: Caller, owner: Caller, log: string, text: string) => h.call(who, "addComment", { owner: owner.sub, log, id: uuid("9000"), text });

/**
 * Alex (A) has one of every record type: Friends Sam (B, LA) and Kim (C, Tokyo); a Friend request out to Lee (D) and
 * one in from E; a Friend code; Invites (one used, one revoked, one open, plus a re-used Invite place); Logs with
 * Details, Reactions and Comments both ways; push devices, prefs and "Friend logged" both ways; their own Summaries and
 * a row (with Awards) in Sam's and Kim's. Sam invited Alex (so Sam's used Invite once named Alex's username).
 */
async function seed() {
  setNow("2026-10-25T12:00:00.000Z");
  await profile(h.B, "Sam", LA);
  const fromSam = await h.call(h.B, "createInvite");
  await h.signUp(fromSam.token, h.A.username);
  await profile(h.A, "Alex", LA);
  await profile(h.C, "Kim", TOKYO);
  await profile(h.D, "Lee", LA);
  await profile(E, "Eve", LA);
  await befriend(h.A, h.B);
  await befriend(h.C, h.A);
  await h.call(h.A, "sendFriendRequest", { code: await h.call(h.D, "myFriendCode") });
  await h.call(E, "sendFriendRequest", { code: await h.call(h.A, "myFriendCode") });
  await h.call(h.A, "regenerateFriendCode");

  const used = await h.call(h.A, "createInvite");
  await h.signUp(used.token, "newbie");
  const revoked = await h.call(h.A, "createInvite");
  await h.call(h.A, "revokeInvite", { token: revoked.token });
  await h.call(h.A, "createInvite");
  await h.call(h.A, "createInvite"); // takes the used one's place

  await h.call(h.A, "putPushSubscription", { input: { deviceId: uuid("a000"), endpoint: "https://web.push.apple.com/a", ...KEYS } });
  await h.call(h.B, "putPushSubscription", { input: { deviceId: uuid("a000"), endpoint: "https://web.push.apple.com/b", ...KEYS } });
  await h.call(h.A, "updatePushPrefs", { input: { reactionsComments: true, friendLogged: [h.B.sub] } });
  await h.call(h.B, "updatePushPrefs", { input: { friendLogged: [h.A.sub] } });

  // Alex logs every day of Nov 2-8 (Most regular, Streak), Sam twice, Kim once.
  const alexLogs: string[] = [];
  for (let d = 2; d <= 8; d++) alexLogs.push(await logAt(h.A, `2026-11-0${d}T18:00:00Z`, { bristolType: 4, note: "alex's note", duration: 5 }));
  const samLog = await logAt(h.B, "2026-11-03T18:00:00Z");
  await logAt(h.B, "2026-11-05T18:00:00Z");
  const kimLog = await logAt(h.C, "2026-11-04T01:00:00Z");
  await react(h.B, h.A, alexLogs[6], "👏");
  await comment(h.B, h.A, alexLogs[6], "sam on alex");
  await react(h.C, h.A, alexLogs[5], "😂");
  await react(h.A, h.B, samLog, "💪");
  await comment(h.A, h.B, samLog, "alex on sam");
  await comment(h.A, h.C, kimLog, "alex on kim");

  setNow(MON_8_TOKYO);
  await h.notify(SCHEDULED_RUN);
  setNow(MON_8_LA);
  await h.notify(SCHEDULED_RUN);
  h.takePushes();
  await h.deliver();
  h.takePushes();
  return { alexLogs, samLog, kimLog };
}

const TOMBSTONE_SK = "DELETED";

/** Every value anywhere in an item, nested. */
function values(v: unknown): unknown[] {
  if (Array.isArray(v)) return v.flatMap(values);
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [k, ...values(x)]);
  return [v];
}

/** What's left anywhere that is Alex's or names Alex: only the marker that stops a stale token recreating them. */
function alexLeftovers() {
  return h.db.dump().filter((r) => {
    if (r.PK === `PROFILE#${h.A.sub}` && r.SK === TOMBSTONE_SK) return false;
    const vs = values(r).map(String);
    return vs.some((s) => s.includes(h.A.sub) || s === h.A.username || s.includes("Alex") || s.includes("alex"));
  });
}

beforeEach(() => {
  h.reset();
  n = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("Delete Profile", () => {
  it("leaves nothing of the Profile anywhere: every record type, both sides of every Friendship, the Cognito user", async () => {
    await seed();
    // The seed really did put Alex everywhere (else the check below proves nothing).
    const before = alexLeftovers();
    const kinds = new Set(before.map((r) => `${String(r.PK).replace(/#.*/, "")} ${String(r.SK).replace(/#.*/, "")}`));
    for (const k of [
      "PROFILE PROFILE", "PROFILES PROFILE", "PROFILE LOG", "PROFILE LOGID", "PROFILE LOGDAY", "PROFILE FRIEND", "PROFILE FRIENDCOUNT",
      "PROFILE FRIENDCODE", "FRIENDCODE FRIENDCODE", "PROFILE FRIENDREQ", "PROFILE FRIENDSENDS", "INVITE INVITE", "PROFILE INVITESLOT",
      "PROFILE PUSH", "PROFILE SUMMARY", "PROFILE RESPFROM",
    ]) expect(kinds, k).toContain(k);
    expect(before.some((r) => r.PK === `PROFILE#${h.B.sub}` && String(r.SK).startsWith("SUMMARY#"))).toBe(true);

    expect(await h.call(h.A, "deleteProfile")).toBe(true);

    expect(alexLeftovers()).toEqual([]);
    const marker = h.db.dump().filter((r) => r.PK === `PROFILE#${h.A.sub}`);
    expect(marker).toHaveLength(1);
    expect(Object.keys(marker[0]).sort()).toEqual(["PK", "SK", "deletedAt", "ttl"]);
    expect(h.deletedUsers()).toEqual([h.A.username]);
    // Friends' counts went back down, so they can make new Friends.
    const count = (who: Caller) => h.db.dump().find((r) => r.PK === `PROFILE#${who.sub}` && r.SK === "FRIENDCOUNT")?.n;
    expect([count(h.B), count(h.C)]).toEqual([0, 0]);
  });

  it("Friends no longer see them: Friend lists, Calendars, requests, Reactions/Comments, stored and future Summaries", async () => {
    const { samLog } = await seed();
    await h.call(h.A, "deleteProfile");

    expect(await h.call(h.B, "friends")).toEqual([]);
    expect(await h.call(h.C, "friends")).toEqual([]);
    expect(await h.call(h.D, "sentFriendRequests").catch(() => [])).toEqual([]);
    expect(await h.call(h.D, "friendRequests")).toEqual([]);
    expect(await h.call(E, "sentFriendRequests")).toEqual([]);
    await expect(h.call(h.B, "friendLogs", { friend: h.A.sub, from: "2026-11-01", to: "2026-11-30" })).rejects.toThrow("NotFound");
    const sams = await h.call(h.B, "myLogs", { from: "2026-11-01", to: "2026-11-30" });
    const log = sams.find((l: { id: string }) => l.id === samLog);
    expect(log.reactions).toEqual([]);
    expect(log.comments).toEqual([]);

    // Sam's stored Summary keeps Sam's own row and drops Alex's row and Awards.
    const [stored] = await h.call(h.B, "summaries");
    expect(stored.people.map((p: { displayName: string }) => p.displayName)).toEqual(["Sam"]);
    expect(stored.awards.every((a: { winners: string[] }) => !a.winners.includes(h.A.sub) && a.winners.length > 0)).toBe(true);
    const [kims] = await h.call(h.C, "summaries");
    expect(kims.people.map((p: { displayName: string }) => p.displayName)).toEqual(["Kim"]);

    // The next week's Summary is built without them.
    setNow("2026-11-16T16:00:00.000Z");
    await h.notify(SCHEDULED_RUN);
    const [next] = await h.call(h.B, "summaries");
    expect(next.weekStart).toBe("2026-11-09");
    expect(next.people.map((p: { displayName: string }) => p.displayName)).toEqual(["Sam"]);
  });

  it("a deleted Profile's token can't bring anything back (another phone still signed in, or a queued Log)", async () => {
    await seed();
    await h.call(h.A, "deleteProfile");
    for (const [field, args] of [
      ["me", { homeZone: LA }],
      ["createLog", { log: { id: uuid("8000") } }],
      ["createInvite", {}],
      ["myFriendCode", {}],
      ["putPushSubscription", { input: { deviceId: uuid("a000"), endpoint: "https://web.push.apple.com/a2", ...KEYS } }],
    ] as const) {
      await expect(h.call(h.A, field, args), field).rejects.toThrow("ProfileDeleted");
    }
    expect(alexLeftovers()).toEqual([]);
    // Asking again is fine (the phone that lost the first answer) and changes nothing.
    expect(await h.call(h.A, "deleteProfile")).toBe(true);
    expect(alexLeftovers()).toEqual([]);
  });

  it("is safe to retry: stopped after any write (or with Cognito down), running it again finishes the job", async () => {
    // How many writes a full deletion makes, so every stopping point is tried.
    await seed();
    const total = countWrites(() => h.call(h.A, "deleteProfile"));
    const writes = await total;
    expect(writes).toBeGreaterThan(20);

    for (let stopAt = 0; stopAt < writes; stopAt++) {
      h.reset();
      n = 0;
      await seed();
      const stop = failWriteAt(stopAt);
      await expect(h.call(h.A, "deleteProfile"), `stopped at write ${stopAt}`).rejects.toThrow();
      stop();
      // Once the first write (the marker) landed, the Profile is gone for every other call.
      if (stopAt > 0) await expect(h.call(h.A, "me", { homeZone: LA })).rejects.toThrow("ProfileDeleted");
      expect(await h.call(h.A, "deleteProfile")).toBe(true);
      expect(alexLeftovers(), `stopped at write ${stopAt}`).toEqual([]);
      expect(h.deletedUsers()).toEqual([h.A.username]);
    }

    h.reset();
    n = 0;
    await seed();
    h.breakCognito();
    await expect(h.call(h.A, "deleteProfile")).rejects.toThrow("InternalError");
    expect(alexLeftovers()).toEqual([]);
    // Until Cognito says yes, the marker doesn't expire (the user could still sign in).
    expect(h.db.dump().find((r) => r.PK === `PROFILE#${h.A.sub}`)?.ttl).toBeUndefined();
    h.breakCognito(false);
    expect(await h.call(h.A, "deleteProfile")).toBe(true);
    expect(h.deletedUsers()).toEqual([h.A.username]);
    expect(h.db.dump().find((r) => r.PK === `PROFILE#${h.A.sub}`)?.ttl).toBeGreaterThan(Date.now() / 1000);
  });

  it("a Summary built while they're being deleted leaves them out instead of snapshotting them", async () => {
    await seed();
    // Stop right after the first write (the deletion has started), then Sam's next Summary is built.
    const stop = failWriteAt(1);
    await expect(h.call(h.A, "deleteProfile")).rejects.toThrow();
    stop();
    setNow("2026-11-16T16:00:00.000Z");
    await h.notify(SCHEDULED_RUN);
    const [next] = await h.call(h.B, "summaries");
    expect(next.weekStart).toBe("2026-11-09");
    expect(next.people.map((p: { displayName: string }) => p.displayName)).toEqual(["Sam"]);
    await h.call(h.A, "deleteProfile");
    expect(alexLeftovers()).toEqual([]);
  });

  it("leaves other Profiles' data alone", async () => {
    await seed();
    const others = () => h.db.dump().filter((r) => r.PK === `PROFILE#${h.D.sub}` || r.PK === `PROFILE#${E.sub}`).map((r) => r.SK).sort();
    const before = others();
    await h.call(h.A, "deleteProfile");
    // D and E only lose the request items that pointed at Alex.
    expect(others()).toEqual(before.filter((sk) => !String(sk).includes(h.A.sub)));
    expect((await h.call(h.B, "myLogs", { from: "2026-11-01", to: "2026-11-30" })).length).toBe(2);
    expect(await h.call(h.B, "me", { homeZone: LA })).toMatchObject({ displayName: "Sam" });
  });
});

const isWrite = (cmd: unknown) =>
  cmd instanceof PutCommand || cmd instanceof UpdateCommand || cmd instanceof DeleteCommand || cmd instanceof TransactWriteCommand;

/** From now on the table refuses the write numbered `at` (0 = the first) as a timed-out Lambda would; returns undo. */
function failWriteAt(at: number): () => void {
  const real = h.db.send;
  let seen = 0;
  h.db.send = async function (cmd: unknown) {
    if (isWrite(cmd) && seen++ === at) throw Object.assign(new Error("Task timed out"), { name: "TimeoutError" });
    return real.call(h.db, cmd);
  } as typeof real;
  return () => void (h.db.send = real);
}

async function countWrites(fn: () => Promise<unknown>): Promise<number> {
  const real = h.db.send;
  let seen = 0;
  h.db.send = async function (cmd: unknown) {
    if (isWrite(cmd)) seen++;
    return real.call(h.db, cmd);
  } as typeof real;
  try {
    await fn();
  } finally {
    h.db.send = real;
  }
  return seen;
}
