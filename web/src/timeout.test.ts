import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleWithin, withTimeout } from "./timeout";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("withTimeout", () => {
  it("gives the result when the call answers in time", async () => {
    await expect(withTimeout(async () => "ok", 8000, () => new Error("slow"))).resolves.toBe("ok");
  });

  it("rejects with the timeout error and aborts the call when it hangs (one weak bar)", async () => {
    let signal: AbortSignal | undefined;
    const p = withTimeout((s) => ((signal = s), new Promise<never>(() => {})), 8000, () => new Error("timed out"));
    const check = expect(p).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(8000);
    await check;
    expect(signal?.aborted).toBe(true);
  });

  it("passes the call's own error through", async () => {
    await expect(withTimeout(async () => { throw new Error("rejected"); }, 8000, () => new Error("slow"))).rejects.toThrow("rejected");
  });
});

describe("settleWithin", () => {
  it("gives the value when it arrives in time", async () => {
    const p = settleWithin(new Promise((r) => setTimeout(() => r("reg"), 100)), 3000);
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe("reg");
  });

  it("gives undefined when it never arrives (no service worker, e.g. in dev)", async () => {
    const p = settleWithin(new Promise(() => {}), 3000);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toBeUndefined();
  });
});
