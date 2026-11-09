import { describe, expect, it } from "vitest";
import {
  DEFAULT_PUSH_PREFS, PUSH_DEVICES_MAX, SCHEDULED_RUN, eventPushPayload, isScheduledRun, parsePushEvent, summaryPushPayload, parsePushPrefsInput, parsePushSubscription, pushLinks, readPushPrefs,
} from "./push";

const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
const DEVICE = "6f1c0d2e-8a4b-4c3d-9e2f-1a2b3c4d5e6f";
const sub = (endpoint: string) => ({ deviceId: DEVICE, endpoint, ...KEYS });

describe("push preferences", () => {
  it("a new Profile gets the Summary push only; everything else is off and no Friend is followed", () => {
    expect(DEFAULT_PUSH_PREFS).toEqual({ summary: true, friendRequests: false, reactionsComments: false });
    expect(readPushPrefs(undefined)).toEqual(DEFAULT_PUSH_PREFS);
  });

  it("reads stored prefs, keeping defaults for anything missing or junk", () => {
    expect(readPushPrefs({ summary: false })).toEqual({ summary: false, friendRequests: false, reactionsComments: false });
    expect(readPushPrefs({ friendRequests: "yes", reactionsComments: true })).toEqual({ summary: true, friendRequests: false, reactionsComments: true });
  });

  it("an edit takes only true/false toggles and a list of Profile ids", () => {
    expect(parsePushPrefsInput({ summary: false, friendLogged: ["sub-b"] })).toEqual({ ok: true, toggles: { summary: false }, friendLogged: ["sub-b"] });
    expect(parsePushPrefsInput({ reactionsComments: true })).toEqual({ ok: true, toggles: { reactionsComments: true }, friendLogged: undefined });
    expect(parsePushPrefsInput({ summary: "no" }).ok).toBe(false);
    expect(parsePushPrefsInput({ friendLogged: "sub-b" }).ok).toBe(false);
    expect(parsePushPrefsInput({ friendLogged: [""] }).ok).toBe(false);
    expect(parsePushPrefsInput({ friendLogged: Array(4).fill("x") }).ok).toBe(false);
  });
});

describe("push subscriptions", () => {
  it("takes the browsers' push services over https", () => {
    for (const e of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QGx",
      "https://api.push.apple.com/3/device/x",
      "https://wns2-par02p.notify.windows.com/w/?token=x",
    ]) expect(parsePushSubscription(sub(e))).toEqual(sub(e));
  });

  it("refuses any other host, http, ports, credentials, IPs and look-alikes (the Notifier POSTs there)", () => {
    for (const e of [
      "http://fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "https://u:p@fcm.googleapis.com/x",
      "https://evil.example/x", "https://169.254.169.254/latest", "https://push.apple.com.evil.example/x",
      "https://.push.apple.com/x", "https://fcm.googleapis.com./x", "not a url", `https://fcm.googleapis.com/${"a".repeat(2050)}`,
    ]) expect(() => parsePushSubscription(sub(e)), e).toThrow();
  });

  it("refuses bad keys and device ids", () => {
    const ok = "https://fcm.googleapis.com/x";
    expect(() => parsePushSubscription({ ...sub(ok), p256dh: "has space" })).toThrow();
    expect(() => parsePushSubscription({ ...sub(ok), auth: "a".repeat(101) })).toThrow();
    expect(() => parsePushSubscription({ ...sub(ok), deviceId: "../x" })).toThrow();
  });

  it("a Profile has at most 10 devices", () => {
    expect(PUSH_DEVICES_MAX).toBe(10);
  });
});

describe("push events", () => {
  it("parses only the known shapes, with ids and no more", () => {
    expect(parsePushEvent({ kind: "friendRequest", to: "b", from: "a" })).toEqual({ kind: "friendRequest", to: "b", from: "a" });
    expect(parsePushEvent({ kind: "friendLogged", from: "a", logId: DEVICE, day: "2026-11-09" })).toEqual({ kind: "friendLogged", from: "a", logId: DEVICE, day: "2026-11-09" });
    expect(parsePushEvent({ kind: "reaction", to: "b", from: "a", logId: DEVICE, day: "2026-11-09", note: "secret" }))
      .toEqual({ kind: "reaction", to: "b", from: "a", logId: DEVICE, day: "2026-11-09" });
    expect(parsePushEvent({ kind: "reaction", to: "b", from: "a", day: "2026-11-09" })).toBeUndefined();
    expect(parsePushEvent({ kind: "nope" })).toBeUndefined();
    expect(parsePushEvent({})).toBeUndefined();
    expect(parsePushEvent(null)).toBeUndefined();
  });
});

describe("push text", () => {
  it("names who did what and nothing else; a tap opens the Day, Friend requests or Friends", () => {
    expect(eventPushPayload({ kind: "friendLogged", from: "sub-sam", logId: DEVICE, day: "2026-11-09" }, "Sam")).toEqual({
      title: "Throne", body: "Sam logged", data: { kind: "friendLogged", url: "/calendar?who=sub-sam&day=2026-11-09" },
    });
    expect(eventPushPayload({ kind: "reaction", to: "me", from: "a", logId: DEVICE, day: "2026-11-08" }, "Alex")).toEqual({
      title: "Throne", body: "Alex reacted to your Log", data: { kind: "reaction", url: "/calendar?day=2026-11-08" },
    });
    expect(eventPushPayload({ kind: "comment", to: "me", from: "a", logId: DEVICE, day: "2026-11-08" }, "Alex").body).toBe("Alex commented on your Log");
    expect(eventPushPayload({ kind: "friendRequest", to: "me", from: "a" }, "Alex")).toEqual({
      title: "Throne", body: "Alex sent you a Friend request", data: { kind: "friendRequest", url: "/friends" },
    });
    expect(eventPushPayload({ kind: "friendAccepted", to: "me", from: "a" }, "Alex").body).toBe("Alex accepted your Friend request");
  });

  it("links are app paths", () => {
    expect(pushLinks.day("2026-11-09")).toBe("/calendar?day=2026-11-09");
    expect(pushLinks.day("2026-11-09", "a b")).toBe("/calendar?who=a%20b&day=2026-11-09");
    expect(pushLinks.friends).toBe("/friends");
    expect(pushLinks.summary).toBe("/summary");
  });

  it("the hourly schedule's event is told apart from junk", () => {
    expect(isScheduledRun(SCHEDULED_RUN)).toBe(true);
    expect(isScheduledRun(JSON.parse(JSON.stringify(SCHEDULED_RUN)))).toBe(true);
    for (const e of [{}, null, "summary", { run: "other" }, { kind: "friendLogged" }]) expect(isScheduledRun(e)).toBe(false);
  });

  it("the Summary push says only that it's ready (no counts, no names) and opens the Summary", () => {
    expect(summaryPushPayload()).toEqual({
      title: "Throne", body: "Last week's Summary is ready", data: { kind: "summary", url: "/summary" },
    });
  });
});
