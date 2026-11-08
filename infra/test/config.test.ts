import { describe, expect, it } from "vitest";
import { readHostingConfig } from "../lib/config";

const ctx = (values: Record<string, string>) => (key: string) => values[key];
const ZONE = { hostedZoneId: "Z0000000PLACEHOLDER", zoneName: "example.com" };
const DOMAIN = "throne.example.com";

describe("readHostingConfig", () => {
  it("reads the zone and account from CDK context", () => {
    expect(readHostingConfig(ctx({ ...ZONE, account: "111111111111" }), {}, DOMAIN)).toEqual({ ...ZONE, account: "111111111111" });
  });

  it("falls back to env vars (what CI sets), with context winning", () => {
    const env = { HOSTED_ZONE_ID: "ZENV", HOSTED_ZONE_NAME: "example.com", CDK_DEFAULT_ACCOUNT: "222222222222" };
    expect(readHostingConfig(ctx({}), env, DOMAIN)).toEqual({ hostedZoneId: "ZENV", zoneName: "example.com", account: "222222222222" });
    expect(readHostingConfig(ctx({ hostedZoneId: "ZCTX" }), env, DOMAIN)?.hostedZoneId).toBe("ZCTX");
  });

  it("returns undefined when no zone is set, so a plain local synth builds only the app stack", () => {
    expect(readHostingConfig(ctx({}), {}, DOMAIN)).toBeUndefined();
    expect(readHostingConfig(ctx({}), { CDK_DEFAULT_ACCOUNT: "111111111111" }, DOMAIN)).toBeUndefined();
  });

  it("refuses half a config instead of guessing", () => {
    expect(() => readHostingConfig(ctx({ hostedZoneId: "ZABC" }), {}, DOMAIN)).toThrow(/zoneName/);
    expect(() => readHostingConfig(ctx(ZONE), {}, DOMAIN)).toThrow(/account/);
  });

  it("rejects a zone the app domain doesn't sit in", () => {
    expect(() => readHostingConfig(ctx({ ...ZONE, zoneName: "other.com", account: "111111111111" }), {}, DOMAIN)).toThrow(/other\.com/);
    // label boundary only: throne.example.com is not in ample.com
    expect(() => readHostingConfig(ctx({ ...ZONE, zoneName: "ample.com", account: "111111111111" }), {}, DOMAIN)).toThrow(/ample\.com/);
  });

  it("requires hosting when asked to (the CI deploy), so a missing variable fails the deploy", () => {
    expect(() => readHostingConfig(ctx({ requireHosting: "true" }), {}, DOMAIN)).toThrow(/hostedZoneId/);
  });
});
