import { describe, expect, it } from "vitest";
import { deviceId, forgetDevice, queueDelete, takeDeletes, type KeyValue } from "./pushDevice";

function memory(): KeyValue & { keys(): string[] } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

describe("sign-out on a shared phone", () => {
  it("forgets this device's push identity, so the next Profile gets a fresh device ID", () => {
    const store = memory();
    const first = deviceId(store, () => "dev-1");
    store.setItem("throne.pushEndpoint", "https://web.push.apple.com/x");

    expect(forgetDevice(store)).toBe(first);
    expect(store.getItem("throne.pushEndpoint")).toBeNull();
    expect(deviceId(store, () => "dev-2")).toBe("dev-2");
  });

  it("forgetting a device that never enabled notifications is a no-op", () => {
    expect(forgetDevice(memory())).toBeUndefined();
  });

  it("a delete queued offline goes out when the same Profile signs back in, and only once", () => {
    const store = memory();
    queueDelete(store, "asher", "dev-1");
    queueDelete(store, "aubyn", "dev-9");

    expect(takeDeletes(store, "asher")).toEqual(["dev-1"]);
    expect(takeDeletes(store, "asher")).toEqual([]);
    expect(takeDeletes(store, "aubyn")).toEqual(["dev-9"]);
  });

  it("queueing the same device twice sends one delete", () => {
    const store = memory();
    queueDelete(store, "asher", "dev-1");
    queueDelete(store, "asher", "dev-1");
    expect(takeDeletes(store, "asher")).toEqual(["dev-1"]);
  });
});
