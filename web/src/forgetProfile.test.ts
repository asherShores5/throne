import { describe, expect, it } from "vitest";
import { forgetOnSignOut, forgetProfileHere } from "./forgetProfile";
import type { KeyValue } from "./pushDevice";

function memory(init: Record<string, string>): KeyValue & { all(): Record<string, string> } {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    all: () => Object.fromEntries(m),
  };
}

describe("after Delete Profile, this device forgets the Profile", () => {
  it("drops their Logs copy, outbox, cached Profile, queued push deletes, push identity and the sign-in hints; keeps another Profile's", () => {
    const store = memory({
      "throne.logs.v1:alex": "[1]", "throne.outbox.v1:alex": "[2]", "throne.me.v1:alex": "{}",
      "throne.logs.v1:sam": "[3]", "throne.outbox.v1:sam": "[4]", "throne.me.v1:sam": "{}",
      "throne.pendingPushDeletes": JSON.stringify({ alex: ["d1"], sam: ["d2"] }),
      "throne.deviceId": "d3", "throne.pushEndpoint": "https://web.push.apple.com/x",
      "throne.lastUser": "alex", "throne.hasPasskey": "1", "throne.config": "{}",
    });
    forgetProfileHere(store, "alex");
    expect(store.all()).toEqual({
      "throne.logs.v1:sam": "[3]", "throne.outbox.v1:sam": "[4]", "throne.me.v1:sam": "{}",
      "throne.pendingPushDeletes": JSON.stringify({ sam: ["d2"] }),
      "throne.config": "{}",
    });
  });

  it("leaves the last-user hint when it names someone else", () => {
    const store = memory({ "throne.lastUser": "sam" });
    forgetProfileHere(store, "alex");
    expect(store.all()).toEqual({ "throne.lastUser": "sam" });
  });
});

describe("after Sign out (hand the phone to someone), this device keeps no readable copy", () => {
  it("drops their Logs copy and cached Profile; keeps only Log writes not yet sent, and the one-tap username", () => {
    const store = memory({
      "throne.logs.v1:alex": "[1]", "throne.outbox.v1:alex": "[2]", "throne.me.v1:alex": "{}",
      "throne.logs.v1:sam": "[3]", "throne.lastUser": "alex",
    });
    forgetOnSignOut(store, "alex");
    expect(store.all()).toEqual({ "throne.outbox.v1:alex": "[2]", "throne.logs.v1:sam": "[3]", "throne.lastUser": "alex" });
  });
});
