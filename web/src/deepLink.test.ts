import { describe, expect, it } from "vitest";
import { calendarLink, clickPlan, navigateMessage, notificationFor } from "./deepLink";

const ICON = "/android-chrome-192x192.png";

describe("the notification the worker shows for a push", () => {
  it("shows the push's text and keeps where a tap goes", () => {
    const raw = JSON.stringify({ title: "Throne", body: "Sam logged", data: { kind: "friendLogged", url: "/calendar?who=s&day=2026-11-09" } });
    expect(notificationFor(raw)).toEqual({
      title: "Throne", options: { body: "Sam logged", data: { url: "/calendar?who=s&day=2026-11-09" }, icon: ICON },
    });
  });

  // iOS revokes the subscription of a worker that gets a push and shows nothing.
  it.each([["no payload", undefined], ["not JSON", "{oops"], ["no title", JSON.stringify({ body: "x" })], ["JSON null", "null"]])(
    "still shows a generic notification for %s",
    (_, raw) => {
      expect(notificationFor(raw)).toEqual({ title: "Throne", options: { body: "Something new on Throne.", data: { url: "/" }, icon: ICON } });
    },
  );
});

describe("tapping a notification", () => {
  const origin = "https://throne.example";
  const app = (url: string, focused = false) => ({ url: origin + url, focused });

  it("opens the app on the link when it isn't open", () => {
    expect(clickPlan({ url: "/friends" }, [], origin)).toEqual({ open: "https://throne.example/friends" });
  });

  it("focuses the open app (the focused window first) and tells it where to go", () => {
    expect(clickPlan({ url: "/calendar?day=2026-11-09" }, [app("/")], origin)).toEqual({ focus: 0, message: { type: "navigate", to: "/calendar?day=2026-11-09" } });
    const windows = [{ url: "https://other.example/", focused: true }, app("/"), app("/friends", true)];
    expect(clickPlan({ url: "/friends" }, windows, origin)).toEqual({ focus: 2, message: { type: "navigate", to: "/friends" } });
  });

  it("never leaves the app's origin, whatever the payload says", () => {
    expect(clickPlan({ url: "https://evil.example/friends" }, [], origin)).toEqual({ open: "https://throne.example/" });
    expect(clickPlan({ url: "//evil.example/" }, [], origin)).toEqual({ open: "https://throne.example/" });
    expect(clickPlan(undefined, [], origin)).toEqual({ open: "https://throne.example/" });
    expect(clickPlan({ url: 42 }, [app("/")], origin)).toEqual({ focus: 0, message: { type: "navigate", to: "/" } });
  });
});

describe("the worker's message to an open app", () => {
  it("is a same-app path or nothing", () => {
    expect(navigateMessage({ type: "navigate", to: "/friends" })).toBe("/friends");
    expect(navigateMessage({ type: "navigate", to: "//evil.example/" })).toBeUndefined();
    expect(navigateMessage({ type: "navigate", to: "https://evil.example/" })).toBeUndefined();
    expect(navigateMessage({ type: "other", to: "/" })).toBeUndefined();
    expect(navigateMessage("x")).toBeUndefined();
  });
});

describe("a Day link on the Calendar", () => {
  it("reads whose Calendar and which Day", () => {
    expect(calendarLink("?who=sub-a&day=2026-11-09")).toEqual({ who: "sub-a", day: "2026-11-09" });
    expect(calendarLink("?day=2026-11-09")).toEqual({ who: undefined, day: "2026-11-09" });
  });

  it("ignores a Day that isn't one", () => {
    expect(calendarLink("?day=tomorrow")).toEqual({ who: undefined, day: undefined });
    expect(calendarLink("")).toEqual({ who: undefined, day: undefined });
  });
});
