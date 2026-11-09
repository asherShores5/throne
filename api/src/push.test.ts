// Push notifications (ticket 09) through the real handler and the real Notifier on the in-memory table:
// preferences, device subscriptions, and who gets which push after each write (the API hands the
// Notifier an event; h.deliver() runs the Notifier on every event so far, with a fake push service).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harness, type Caller } from "./testing/harness";

const h = harness();
const NOW = "2026-11-09T18:00:00.000Z";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dev = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
const endpoint = (who: Caller, n = 1) => `https://web.push.apple.com/${who.username}-${n}`;

beforeEach(async () => {
  h.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  for (const [who, name] of [[h.A, "Alex"], [h.B, "Sam"], [h.C, "Kim"], [h.D, "Lee"]] as const) {
    await h.call(who, "me", { homeZone: "America/Los_Angeles" });
    await h.call(who, "updateProfile", { input: { displayName: name } });
  }
});
afterEach(() => vi.useRealTimers());

async function befriend(a: Caller, b: Caller) {
  const code = await h.call(b, "myFriendCode");
  await h.call(a, "sendFriendRequest", { code });
  await h.call(b, "acceptFriendRequest", { from: a.sub });
}
const enable = (who: Caller, n = 1) => h.call(who, "putPushSubscription", { input: { deviceId: dev(n), endpoint: endpoint(who, n), ...KEYS } });
const prefs = (who: Caller, input: Record<string, unknown>) => h.call(who, "updatePushPrefs", { input });
/** Bodies each endpoint got since the last call. */
async function delivered() {
  await h.deliver();
  return h.takePushes().map((p) => ({ to: p.endpoint, body: JSON.parse(p.payload).body as string }));
}

describe("preferences", () => {
  it("a new Profile gets the Summary push only, and follows no Friend's Logs", async () => {
    expect(await h.call(h.A, "pushPrefs")).toEqual({ summary: true, friendRequests: false, reactionsComments: false, friendLogged: [] });
  });

  it("only the toggles sent change", async () => {
    await prefs(h.A, { friendRequests: true });
    expect(await prefs(h.A, { summary: false })).toEqual({ summary: false, friendRequests: true, reactionsComments: false, friendLogged: [] });
    expect(await h.call(h.A, "pushPrefs")).toMatchObject({ summary: false, friendRequests: true });
    await expect(prefs(h.A, { summary: "no" })).rejects.toThrow("ValidationError");
  });

  it("Friend logged is picked per Friend; anyone who isn't a Friend is left out", async () => {
    await befriend(h.A, h.B);
    await befriend(h.A, h.C);
    expect((await prefs(h.A, { friendLogged: [h.B.sub, h.D.sub, h.A.sub] })).friendLogged).toEqual([h.B.sub]);
    expect((await prefs(h.A, { friendLogged: [h.C.sub, h.B.sub] })).friendLogged.sort()).toEqual([h.B.sub, h.C.sub].sort());
    expect((await prefs(h.A, { friendLogged: [h.C.sub] })).friendLogged).toEqual([h.C.sub]);
    // The other side's choice is their own.
    expect((await h.call(h.B, "pushPrefs")).friendLogged).toEqual([]);
  });

  it("ending a Friendship takes that Friend off both lists, and a new Friendship starts unfollowed", async () => {
    await befriend(h.A, h.B);
    await prefs(h.A, { friendLogged: [h.B.sub] });
    await prefs(h.B, { friendLogged: [h.A.sub] });
    await h.call(h.B, "endFriendship", { friend: h.A.sub });
    expect((await h.call(h.A, "pushPrefs")).friendLogged).toEqual([]);
    expect((await h.call(h.B, "pushPrefs")).friendLogged).toEqual([]);
    await befriend(h.A, h.B);
    expect((await h.call(h.A, "pushPrefs")).friendLogged).toEqual([]);
  });
});

describe("devices", () => {
  it("a device turns push on and off; off twice is fine", async () => {
    expect(await enable(h.A)).toEqual({ deviceId: dev(1), enabled: true });
    expect(await h.call(h.A, "deletePushSubscription", { deviceId: dev(1) })).toEqual({ deviceId: dev(1), enabled: false });
    expect(await h.call(h.A, "deletePushSubscription", { deviceId: dev(1) })).toEqual({ deviceId: dev(1), enabled: false });
  });

  it("refuses an endpoint that isn't a known push service", async () => {
    for (const e of ["https://evil.example/x", "http://web.push.apple.com/x", "https://169.254.169.254/x"]) {
      await expect(h.call(h.A, "putPushSubscription", { input: { deviceId: dev(1), endpoint: e, ...KEYS } })).rejects.toThrow("ValidationError");
    }
  });

  it("at most 10 devices; re-saving one already there always works", async () => {
    for (let n = 1; n <= 10; n++) await enable(h.A, n);
    await expect(enable(h.A, 11)).rejects.toThrow("ValidationError: At most 10 devices");
    await expect(enable(h.A, 3)).resolves.toMatchObject({ enabled: true });
    // Another Profile's devices don't count.
    await expect(enable(h.B, 1)).resolves.toMatchObject({ enabled: true });
  });

  it("turning off a device id only ever touches the caller's own", async () => {
    await enable(h.A);
    await h.call(h.B, "deletePushSubscription", { deviceId: dev(1) });
    await prefs(h.A, { friendRequests: true });
    await h.call(h.B, "sendFriendRequest", { code: await h.call(h.A, "myFriendCode") });
    expect(await delivered()).toEqual([{ to: endpoint(h.A), body: "Sam sent you a Friend request" }]);
  });
});

describe("Friend request pushes", () => {
  it("go to the receiver, then to the sender on accept, only with the toggle on", async () => {
    await enable(h.A);
    await enable(h.B);
    await h.call(h.A, "sendFriendRequest", { code: await h.call(h.B, "myFriendCode") });
    expect(await delivered()).toEqual([]); // B hasn't turned Friend request pushes on
    await prefs(h.A, { friendRequests: true });
    await prefs(h.B, { friendRequests: true });
    await h.call(h.C, "sendFriendRequest", { code: await h.call(h.B, "myFriendCode") });
    expect(await delivered()).toEqual([{ to: endpoint(h.B), body: "Kim sent you a Friend request" }]);
    await h.call(h.B, "acceptFriendRequest", { from: h.A.sub });
    expect(await delivered()).toEqual([{ to: endpoint(h.A), body: "Sam accepted your Friend request" }]);
    // A retried accept makes no second push.
    await h.call(h.B, "acceptFriendRequest", { from: h.A.sub });
    expect(await delivered()).toEqual([]);
  });

  it("a request that meets one coming the other way tells the first sender it's accepted", async () => {
    await enable(h.A);
    await prefs(h.A, { friendRequests: true });
    await h.call(h.A, "sendFriendRequest", { code: await h.call(h.B, "myFriendCode") });
    await h.call(h.B, "sendFriendRequest", { code: await h.call(h.A, "myFriendCode") });
    expect(await delivered()).toEqual([{ to: endpoint(h.A), body: "Sam accepted your Friend request" }]);
  });

  it("a request already declined or cancelled by the time the Notifier runs pushes nothing", async () => {
    await enable(h.B);
    await prefs(h.B, { friendRequests: true });
    await h.call(h.A, "sendFriendRequest", { code: await h.call(h.B, "myFriendCode") });
    await h.call(h.A, "cancelFriendRequest", { to: h.B.sub });
    expect(await delivered()).toEqual([]);
  });
});

describe("Reaction and Comment pushes", () => {
  it("go to the Log's owner with the toggle on, without the emoji or the Comment text", async () => {
    await befriend(h.A, h.B);
    await enable(h.A);
    await h.call(h.A, "createLog", { log: { id: id(1), note: "very private" } });
    await h.call(h.B, "setReaction", { owner: h.A.sub, log: id(1), emoji: "👏" });
    expect(await delivered()).toEqual([]);
    await prefs(h.A, { reactionsComments: true });
    await h.call(h.B, "setReaction", { owner: h.A.sub, log: id(1), emoji: "😂" });
    await h.call(h.B, "addComment", { owner: h.A.sub, log: id(1), id: id(9), text: "ha, nice one" });
    await h.deliver();
    const pushes = h.takePushes();
    expect(pushes.map((p) => JSON.parse(p.payload))).toEqual([
      { title: "Throne", body: "Sam reacted to your Log", data: { kind: "reaction", url: "/calendar?day=2026-11-09" } },
      { title: "Throne", body: "Sam commented on your Log", data: { kind: "comment", url: "/calendar?day=2026-11-09" } },
    ]);
    for (const p of pushes) expect(p.payload).not.toMatch(/private|nice one|😂/);
  });

  it("taking a Reaction off, a retried Comment, or the same Reaction again pushes nothing", async () => {
    await befriend(h.A, h.B);
    await enable(h.A);
    await prefs(h.A, { reactionsComments: true });
    await h.call(h.A, "createLog", { log: { id: id(1) } });
    await h.call(h.B, "setReaction", { owner: h.A.sub, log: id(1), emoji: "👏" });
    await h.call(h.B, "addComment", { owner: h.A.sub, log: id(1), id: id(9), text: "hi" });
    await delivered();
    await h.call(h.B, "setReaction", { owner: h.A.sub, log: id(1), emoji: "👏" });
    await h.call(h.B, "setReaction", { owner: h.A.sub, log: id(1), emoji: null });
    await h.call(h.B, "addComment", { owner: h.A.sub, log: id(1), id: id(9), text: "hi" });
    expect(await delivered()).toEqual([]);
  });

  it("nothing if the Friendship ended before the Notifier ran", async () => {
    await befriend(h.A, h.B);
    await enable(h.A);
    await prefs(h.A, { reactionsComments: true });
    await h.call(h.A, "createLog", { log: { id: id(1) } });
    await h.call(h.B, "setReaction", { owner: h.A.sub, log: id(1), emoji: "👏" });
    await h.call(h.A, "endFriendship", { friend: h.B.sub });
    expect(await delivered()).toEqual([]);
  });
});

describe("Friend logged pushes", () => {
  it("go only to Friends who follow the Log's owner, every device, text without Details", async () => {
    await befriend(h.A, h.B);
    await befriend(h.A, h.C);
    await befriend(h.A, h.D);
    for (const who of [h.B, h.C, h.D]) await enable(who);
    await enable(h.B, 2);
    await prefs(h.B, { friendLogged: [h.A.sub] });
    await prefs(h.C, { friendLogged: [h.A.sub] });
    await prefs(h.C, { friendLogged: [] }); // C changed their mind
    await h.call(h.A, "createLog", { log: { id: id(1), duration: 5, bristolType: 4, note: "ouch", flags: ["blood"] } });
    await h.deliver();
    const pushes = h.takePushes();
    expect(pushes.map((p) => p.endpoint).sort()).toEqual([endpoint(h.B, 1), endpoint(h.B, 2)].sort());
    for (const p of pushes) {
      expect(JSON.parse(p.payload)).toEqual({ title: "Throne", body: "Alex logged", data: { kind: "friendLogged", url: `/calendar?who=${h.A.sub}&day=2026-11-09` } });
      expect(p.payload).not.toMatch(/ouch|blood|bristol|duration/i);
    }
  });

  it("a retried create (same Log id) pushes once", async () => {
    await befriend(h.A, h.B);
    await enable(h.B);
    await prefs(h.B, { friendLogged: [h.A.sub] });
    await h.call(h.A, "createLog", { log: { id: id(1) } });
    await h.call(h.A, "createLog", { log: { id: id(1) } });
    expect(await delivered()).toHaveLength(1);
  });

  it("the API hands the Notifier ids only", async () => {
    await h.call(h.A, "createLog", { log: { id: id(1), note: "ouch", bristolType: 2 } });
    expect(h.events()).toEqual([{ kind: "friendLogged", from: h.A.sub, logId: id(1), day: "2026-11-09" }]);
  });
});

describe("the Notifier", () => {
  it("deletes a device the push service says is gone (404/410) and keeps it on other failures", async () => {
    await befriend(h.A, h.B);
    for (const n of [1, 2, 3]) await enable(h.B, n);
    await prefs(h.B, { friendLogged: [h.A.sub] });
    h.failPush(endpoint(h.B, 1), 410);
    h.failPush(endpoint(h.B, 2), 500);
    await h.deliver(); // the Friend request pushes from befriend (toggles off: none sent)
    await h.call(h.A, "createLog", { log: { id: id(1) } });
    expect(await h.deliver()).toEqual([expect.objectContaining({ sent: 1, failed: 2, pruned: 1 })]);
    h.takePushes();
    // The gone one isn't tried again; the one that failed with 500 is.
    await h.call(h.A, "createLog", { log: { id: id(2) } });
    expect(await h.deliver()).toEqual([{ sent: 1, failed: 1, pruned: 0 }]);
    expect(h.takePushes().map((p) => p.endpoint)).toEqual([endpoint(h.B, 3)]);
  });

  it("ignores anything that isn't a known event", async () => {
    expect(await h.notify({ kind: "friendLogged", from: h.A.sub })).toEqual({ sent: 0, failed: 0, pruned: 0 });
    expect(await h.notify("junk")).toEqual({ sent: 0, failed: 0, pruned: 0 });
  });

  it("a failed hand-off to the Notifier doesn't fail the write", async () => {
    h.breakEvents();
    const log = await h.call(h.A, "createLog", { log: { id: id(1) } });
    expect(log.id).toBe(id(1));
  });
});
