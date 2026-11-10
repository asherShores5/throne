import { describe, expect, it } from "vitest";
import { applicationServerKey, notificationState, subscriptionArgs } from "./push";

describe("notificationState", () => {
  const base = { supported: true, permission: "granted" as NotificationPermission, endpoint: "https://p/1", savedEndpoint: "https://p/1" };

  it("is on when this device has a subscription the server has saved", () => {
    expect(notificationState(base)).toBe("on");
  });

  it("is off before the Profile has enabled, or after they turned it off", () => {
    expect(notificationState({ ...base, permission: "default", endpoint: undefined, savedEndpoint: undefined })).toBe("off");
    expect(notificationState({ ...base, endpoint: undefined, savedEndpoint: undefined })).toBe("off");
  });

  it("needs saving when the browser has a subscription the server hasn't got (offline enable, or a new endpoint)", () => {
    expect(notificationState({ ...base, savedEndpoint: undefined })).toBe("unsaved");
    expect(notificationState({ ...base, savedEndpoint: "https://p/old" })).toBe("unsaved");
  });

  it("is blocked when iOS permission was denied", () => {
    expect(notificationState({ ...base, permission: "denied", endpoint: undefined })).toBe("blocked");
  });

  it("is unsupported outside the home-screen app (no PushManager)", () => {
    expect(notificationState({ ...base, supported: false })).toBe("unsupported");
  });
});

describe("applicationServerKey", () => {
  it("decodes the base64url VAPID public key to the 65-byte uncompressed point", () => {
    // RFC 8292 §3.2 example public key
    const key = "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs";
    const bytes = applicationServerKey(key);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
    expect(bytes[64]).toBe(0xfb);
  });
});

describe("subscriptionArgs", () => {
  it("turns a browser PushSubscription's JSON into the mutation's arguments", () => {
    const json = { endpoint: "https://web.push.apple.com/x", expirationTime: null, keys: { p256dh: "BKey", auth: "Auth" } };
    expect(subscriptionArgs(json, "dev-1")).toEqual({ deviceId: "dev-1", endpoint: "https://web.push.apple.com/x", p256dh: "BKey", auth: "Auth" });
  });

  it("throws on a subscription without keys", () => {
    expect(() => subscriptionArgs({ endpoint: "https://x" }, "dev-1")).toThrow();
  });
});
