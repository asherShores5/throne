// Weekly Summary (ticket 10) through the real handler and the real Notifier on the in-memory table: the
// hourly scheduled run (h.notify(SCHEDULED_RUN), as EventBridge Scheduler invokes it) builds each Profile's Summary at
// Monday 08:00 in their Home zone, once, for last Monday-Sunday, with their current Friends; the push
// goes out when the Profile has it on; `summaries` lists them newest first.
//
// Week used: Mon 2026-11-02 .. Sun 2026-11-08; the run is Mon 2026-11-09. Los Angeles is UTC-8, Tokyo UTC+9.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEDULED_RUN } from "@throne/shared";
import { harness, type Caller } from "./testing/harness";

const h = harness();
const LA = "America/Los_Angeles";
const TOKYO = "Asia/Tokyo";
const MON_8_LA = "2026-11-09T16:00:00.000Z"; // Monday 08:00 in Los Angeles
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

/** A one-tap Log made at that instant (the clock is moved there so the time rules pass). */
async function logAt(who: Caller, iso: string, extra: Record<string, unknown> = {}) {
  setNow(iso);
  await h.call(who, "createLog", { log: { id: uuid("8000"), instant: iso, ...extra } });
}

const enable = (who: Caller) =>
  h.call(who, "putPushSubscription", { input: { deviceId: uuid("a000"), endpoint: `https://web.push.apple.com/${who.username}`, ...KEYS } });

/** The hourly scheduled run at `iso`. */
async function runAt(iso: string) {
  setNow(iso);
  return h.notify(SCHEDULED_RUN);
}

const pushesTo = () => h.takePushes().map((p) => ({ to: p.endpoint.split("/").pop(), ...JSON.parse(p.payload) }));

beforeEach(async () => {
  h.reset();
  n = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  setNow("2026-10-25T12:00:00.000Z");
  await profile(h.A, "Alex", LA);
  await profile(h.B, "Sam", LA);
  await profile(h.C, "Kim", TOKYO);
  await profile(h.D, "Lee", LA);
});
afterEach(() => vi.useRealTimers());

describe("when it's built", () => {
  it("at Monday 08:00 in the Profile's Home zone, for last Monday-Sunday; not before", async () => {
    await logAt(h.A, "2026-11-03T18:00:00Z");
    expect((await runAt("2026-11-09T15:00:00.000Z")).summaries).toBe(0); // 07:00 in LA
    expect(await h.call(h.A, "summaries")).toEqual([]);
    expect((await runAt(MON_8_LA)).summaries).toBe(3); // A, B and D are in LA
    const [s] = await h.call(h.A, "summaries");
    expect(s).toMatchObject({ weekStart: "2026-11-02", weekEnd: "2026-11-08" });
    expect(s.people).toEqual([
      { id: h.A.sub, me: true, displayName: "Alex", emoji: "🚽", color: "#7c5cff", total: 1, dailyAverage: 0.14, change: 1, bristolType: null },
    ]);
  });

  it("goes by each Profile's own Home zone: Tokyo's Monday 08:00 comes 17 hours before Los Angeles'", async () => {
    const r = await runAt("2026-11-08T23:00:00.000Z"); // Mon 08:00 Tokyo, Sun 15:00 LA
    expect(r.summaries).toBe(1);
    expect(await h.call(h.C, "summaries")).toHaveLength(1);
    expect(await h.call(h.A, "summaries")).toEqual([]);
  });

  it("is built once a week, however often the run repeats (a later run that Monday catches up a missed one)", async () => {
    await enable(h.A);
    await runAt(MON_8_LA);
    await runAt(MON_8_LA);
    expect((await runAt("2026-11-09T20:00:00.000Z")).summaries).toBe(0); // noon
    expect(await h.call(h.A, "summaries")).toHaveLength(1);
    expect(pushesTo().filter((p) => p.to === "a")).toHaveLength(1);
  });

  it("isn't built on another day (Tuesday is too late; next Monday builds the next week)", async () => {
    await runAt("2026-11-10T16:00:00.000Z");
    expect(await h.call(h.A, "summaries")).toEqual([]);
    await runAt(MON_8_LA);
    await runAt("2026-11-16T16:00:00.000Z");
    expect((await h.call(h.A, "summaries")).map((s: any) => s.weekStart)).toEqual(["2026-11-09", "2026-11-02"]);
  });
});

describe("what's in it", () => {
  it("the recipient first, then each current Friend: totals, daily average, change vs the week before, Bristol type", async () => {
    await befriend(h.A, h.B);
    await befriend(h.A, h.C);
    // A: 2 this week (types 4, 4), 1 the week before. B: 0 this week, 2 before. C (Tokyo): 3 this week.
    await logAt(h.A, "2026-10-28T18:00:00Z");
    await logAt(h.B, "2026-10-27T18:00:00Z");
    await logAt(h.B, "2026-10-29T18:00:00Z");
    await logAt(h.A, "2026-11-02T18:00:00Z", { bristolType: 4 });
    await logAt(h.A, "2026-11-04T18:00:00Z", { bristolType: 4 });
    for (const d of ["2026-11-03", "2026-11-04", "2026-11-05"]) await logAt(h.C, `${d}T01:00:00Z`, { bristolType: 6 });
    await runAt(MON_8_LA);
    const [s] = await h.call(h.A, "summaries");
    expect(s.people.map((p: any) => [p.displayName, p.me, p.total, p.dailyAverage, p.change, p.bristolType])).toEqual([
      ["Alex", true, 2, 0.29, 1, 4],
      ["Sam", false, 0, 0, -2, null],
      ["Kim", false, 3, 0.43, 3, 6],
    ]);
  });

  it("counts each person's Logs by their own Day: Kim's Monday-morning Tokyo Log is last Sunday's in LA time, but it's Monday's", async () => {
    await befriend(h.A, h.C);
    // 2026-11-08T23:30Z is Sunday 15:30 in LA but Monday 08:30 in Tokyo: Kim's Day is 2026-11-09, next week.
    await logAt(h.C, "2026-11-08T23:30:00Z");
    // 2026-11-01T20:00Z is Monday 05:00 2026-11-02 in Tokyo: this week (Sunday in LA).
    await logAt(h.C, "2026-11-01T20:00:00Z");
    await runAt(MON_8_LA);
    const [s] = await h.call(h.A, "summaries");
    expect(s.people.find((p: any) => p.displayName === "Kim")).toMatchObject({ total: 1, change: 1 });
  });

  it("includes only current Friends: an ended Friendship leaves them out; no Friends is a Summary of just me", async () => {
    await befriend(h.A, h.B);
    await befriend(h.D, h.B);
    await h.call(h.A, "endFriendship", { friend: h.B.sub });
    await runAt(MON_8_LA);
    const [a] = await h.call(h.A, "summaries");
    expect(a.people.map((p: any) => p.displayName)).toEqual(["Alex"]);
    expect(a.awards).toEqual([]);
    const [d] = await h.call(h.D, "summaries");
    expect(d.people.map((p: any) => p.displayName)).toEqual(["Lee", "Sam"]);
    // A Friend of a Friend isn't in it: Sam's Summary has Lee, not Alex.
    const [b] = await h.call(h.B, "summaries");
    expect(b.people.map((p: any) => p.displayName)).toEqual(["Sam", "Lee"]);
  });

  it("has the group's Awards, with Profile ids of the winners", async () => {
    await befriend(h.A, h.B);
    // A logs at 06:00 LA every Day; B at 21:00 LA on three Days.
    for (let i = 2; i <= 8; i++) await logAt(h.A, `2026-11-${String(i).padStart(2, "0")}T14:00:00Z`);
    for (const d of ["03", "04", "05"]) await logAt(h.B, `2026-11-${d}T05:00:00Z`); // 21:00 the Day before in LA
    await runAt(MON_8_LA);
    const [s] = await h.call(h.A, "summaries");
    expect(s.awards).toEqual([
      { award: "earlyBird", winners: [h.A.sub] },
      { award: "nightOwl", winners: [h.B.sub] },
      // A's run is 7, B's 3: both qualify, the longer wins. Most regular: only A has 5+ Days, so nobody.
      { award: "streak", winners: [h.A.sub] },
    ]);
  });
});

describe("push", () => {
  it("goes to every device of a Profile with the Summary push on, opening /summary, with no numbers in it", async () => {
    await enable(h.A);
    await enable(h.B);
    await h.call(h.B, "updatePushPrefs", { input: { summary: false } });
    await runAt(MON_8_LA);
    expect(pushesTo()).toEqual([
      { to: "a", title: "Throne", body: "Last week's Summary is ready", data: { kind: "summary", url: "/summary" } },
    ]);
    // Push off still stores the Summary.
    expect(await h.call(h.B, "summaries")).toHaveLength(1);
  });
});

describe("reading them", () => {
  it("summaries are the caller's own, newest first; nobody can read someone else's", async () => {
    await befriend(h.A, h.B);
    await runAt(MON_8_LA);
    await runAt("2026-11-16T16:00:00.000Z");
    const mine = await h.call(h.A, "summaries");
    expect(mine.map((s: any) => s.weekStart)).toEqual(["2026-11-09", "2026-11-02"]);
    // B's list is B's (B first, me: true), even with an id in the arguments.
    const theirs = await h.call(h.B, "summaries", { profile: h.A.sub, id: h.A.sub });
    expect(theirs[0].people[0]).toMatchObject({ displayName: "Sam", me: true });
  });

  it("a brand-new Profile has none", async () => {
    expect(await h.call(h.A, "summaries")).toEqual([]);
  });
});
