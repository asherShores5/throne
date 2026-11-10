import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateVapidKeys, onVapidKeysEvent, type ParamStore } from "./vapid";

const NAMES = { private: "/test/vapid/private", public: "/test/vapid/public" };

/** In-memory Parameter Store. Records every write so tests can prove nothing was overwritten. */
function fakeStore(initial: Record<string, { value: string; secure: boolean }> = {}) {
  const params = new Map(Object.entries(initial));
  const writes: string[] = [];
  const store: ParamStore = {
    async get(name) {
      return params.get(name)?.value;
    },
    async create(name, value, secure) {
      if (params.has(name)) throw Object.assign(new Error("exists"), { name: "ParameterAlreadyExists" });
      params.set(name, { value, secure });
      writes.push(name);
    },
  };
  return { store, params, writes };
}

const event = (RequestType: "Create" | "Update" | "Delete") => ({ RequestType, PhysicalResourceId: "vapid-keys" });

/** A key built from the Web Push encodings: 65-byte uncompressed point, 32-byte scalar. */
function jwk(publicKey: string, privateKey?: string) {
  const point = Buffer.from(publicKey, "base64url");
  return {
    kty: "EC", crv: "P-256",
    x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33, 65).toString("base64url"),
    ...(privateKey ? { d: privateKey } : {}),
  };
}

describe("generateVapidKeys", () => {
  it("returns a P-256 pair in Web Push encoding whose halves match", () => {
    const { publicKey, privateKey } = generateVapidKeys();
    const point = Buffer.from(publicKey, "base64url");
    expect(point.length).toBe(65);
    expect(point[0]).toBe(4);
    expect(Buffer.from(privateKey, "base64url").length).toBe(32);

    const data = Buffer.from("push");
    const sig = sign("sha256", data, createPrivateKey({ key: jwk(publicKey, privateKey), format: "jwk" }));
    expect(verify("sha256", data, createPublicKey({ key: jwk(publicKey), format: "jwk" }), sig)).toBe(true);
  });
});

describe("onVapidKeysEvent", () => {
  it("Create with no keys writes the private key as a SecureString and the public key as a String", async () => {
    const { store, params } = fakeStore();
    const out = await onVapidKeysEvent(event("Create"), store, NAMES);

    expect(params.get(NAMES.private)?.secure).toBe(true);
    expect(params.get(NAMES.public)).toEqual({ value: out.Data.publicKey, secure: false });
    expect(out.PhysicalResourceId).toBe("vapid-keys");
  });

  it("returns the public key only, never the private one", async () => {
    const { store, params } = fakeStore();
    const out = await onVapidKeysEvent(event("Create"), store, NAMES);
    expect(Object.keys(out.Data)).toEqual(["publicKey"]);
    expect(JSON.stringify(out)).not.toContain(params.get(NAMES.private)!.value);
  });

  it.each(["Create", "Update"] as const)("%s with existing keys returns the existing public key and writes nothing", async (type) => {
    const { store, writes } = fakeStore({
      [NAMES.private]: { value: "old-private", secure: true },
      [NAMES.public]: { value: "old-public", secure: false },
    });
    const out = await onVapidKeysEvent(event(type), store, NAMES);
    expect(out.Data.publicKey).toBe("old-public");
    expect(writes).toEqual([]);
  });

  it("Update after a lost key pair (both missing) creates a new one", async () => {
    const { store, writes } = fakeStore();
    await onVapidKeysEvent(event("Update"), store, NAMES);
    expect(writes).toEqual([NAMES.private, NAMES.public]);
  });

  it("a private key without its public half (crash between writes) restores the matching public key", async () => {
    const pair = generateVapidKeys();
    const { store, params, writes } = fakeStore({ [NAMES.private]: { value: pair.privateKey, secure: true } });
    const out = await onVapidKeysEvent(event("Create"), store, NAMES);
    expect(out.Data.publicKey).toBe(pair.publicKey);
    expect(params.get(NAMES.private)?.value).toBe(pair.privateKey);
    expect(writes).toEqual([NAMES.public]);
  });

  it("a public key without its private half fails loudly instead of overwriting it", async () => {
    const { store, writes } = fakeStore({ [NAMES.public]: { value: "orphan-public", secure: false } });
    await expect(onVapidKeysEvent(event("Create"), store, NAMES)).rejects.toThrow(/\/test\/vapid\/public.*without.*\/test\/vapid\/private/);
    expect(writes).toEqual([]);
  });

  it("Delete is a no-op: the keys are retained", async () => {
    const { store, params, writes } = fakeStore({
      [NAMES.private]: { value: "old-private", secure: true },
      [NAMES.public]: { value: "old-public", secure: false },
    });
    const out = await onVapidKeysEvent(event("Delete"), store, NAMES);
    expect(writes).toEqual([]);
    expect(params.size).toBe(2);
    expect(out.PhysicalResourceId).toBe("vapid-keys");
  });
});
