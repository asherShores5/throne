// Invites (ticket 02): a Profile makes single-use links (at most 3 open, 7 days each), can list and
// revoke them, and the Cognito pre-sign-up trigger lets a sign-up through only with an open Invite,
// spending it. Through the real handler and the real trigger on the in-memory table.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isInviteToken } from "@throne/shared";
import { harness } from "./testing/harness";

const h = harness();
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-11-09T12:00:00Z").getTime();

beforeEach(() => {
  h.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

const create = (who = h.A) => h.call(who, "createInvite");
const list = (who = h.A) => h.call(who, "invites");
const tokens = async (who = h.A) => (await list(who)).map((i: { token: string }) => i.token);

describe("creating an Invite", () => {
  it("returns a fresh 128-bit token that is open for 7 days", async () => {
    const inv = await create();
    expect(isInviteToken(inv.token)).toBe(true);
    expect(inv).toEqual({ token: inv.token, createdAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 7 * DAY).toISOString() });
    const other = await create();
    expect(other.token).not.toBe(inv.token);
  });

  it("allows 3 open Invites; the 4th is refused", async () => {
    for (let i = 0; i < 3; i++) await create();
    await expect(create()).rejects.toThrow(/^ValidationError: .*3 open Invites/);
    expect(await list()).toHaveLength(3);
  });

  it("holds the cap of 3 even when many creates race", async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => create()));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await list()).toHaveLength(3);
  });

  it("the cap is per Profile", async () => {
    for (let i = 0; i < 3; i++) await create(h.A);
    await expect(create(h.B)).resolves.toBeDefined();
  });

  it("a used, revoked or expired Invite frees its place", async () => {
    const [a, b] = [await create(), await create()];
    await create();
    await h.signUp(a.token, "newbie");
    await h.call(h.A, "revokeInvite", { token: b.token });
    await create();
    await create();
    await expect(create()).rejects.toThrow("ValidationError");
    vi.setSystemTime(T0 + 8 * DAY);
    expect(await list()).toEqual([]);
    for (let i = 0; i < 3; i++) await create();
  });
});

describe("listing Invites", () => {
  it("shows only the caller's open Invites, oldest first, with expiry", async () => {
    const a = await create();
    vi.setSystemTime(T0 + 1000);
    const b = await create();
    await create(h.B);
    expect(await list()).toEqual([a, b]);
  });

  it("drops an Invite once it expires", async () => {
    const a = await create();
    vi.setSystemTime(T0 + 7 * DAY - 1);
    expect(await tokens()).toEqual([a.token]);
    vi.setSystemTime(T0 + 7 * DAY);
    expect(await tokens()).toEqual([]);
  });
});

describe("revoking an Invite", () => {
  it("removes it from the list and it can no longer create a Profile", async () => {
    const a = await create();
    expect(await h.call(h.A, "revokeInvite", { token: a.token })).toBe(true);
    expect(await list()).toEqual([]);
    await expect(h.signUp(a.token, "newbie")).rejects.toThrow("Sign-up failed");
  });

  it("only the Invite's maker can revoke it", async () => {
    const a = await create(h.A);
    await expect(h.call(h.B, "revokeInvite", { token: a.token })).rejects.toThrow(/^NotFound/);
    await h.signUp(a.token, "newbie");
  });

  it("a used Invite can't be revoked (it's already spent)", async () => {
    const a = await create();
    await h.signUp(a.token, "newbie");
    await expect(h.call(h.A, "revokeInvite", { token: a.token })).rejects.toThrow(/^NotFound/);
  });

  it("a malformed token is a validation error", async () => {
    await expect(h.call(h.A, "revokeInvite", { token: "x" })).rejects.toThrow(/^ValidationError/);
  });
});

describe("pre-sign-up trigger", () => {
  it("lets a sign-up with an open Invite through, auto-confirmed, and spends the Invite", async () => {
    const a = await create();
    const out = await h.signUp(a.token, "newbie");
    expect(out.response).toMatchObject({ autoConfirmUser: true });
    expect(await list()).toEqual([]);
    await expect(h.signUp(a.token, "second")).rejects.toThrow("Sign-up failed");
  });

  it("reads the token from ValidationData as well as ClientMetadata", async () => {
    const a = await create();
    await expect(h.signUp(a.token, "newbie", { via: "validationData" })).resolves.toBeDefined();
  });

  it("refuses with the same generic message for no, malformed, unknown, expired, revoked or used tokens", async () => {
    const expired = await create();
    const revoked = await create();
    const used = await create();
    await h.call(h.A, "revokeInvite", { token: revoked.token });
    await h.signUp(used.token, "first");
    vi.setSystemTime(T0 + 7 * DAY);
    for (const t of [undefined, "x", "AAECAwQFBgcICQoLDA0ODw", expired.token, revoked.token, used.token]) {
      await expect(h.signUp(t, "newbie")).rejects.toThrow(/^Sign-up failed\. Ask for a new Invite\.$/);
    }
  });

  it("two sign-ups racing on one Invite: exactly one succeeds", async () => {
    const a = await create();
    const results = await Promise.allSettled([h.signUp(a.token, "one"), h.signUp(a.token, "two"), h.signUp(a.token, "three")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("an admin-created user (AWS console, needs IAM) needs no Invite; other sign-up kinds are refused", async () => {
    await expect(h.signUp(undefined, "asher", { triggerSource: "PreSignUp_AdminCreateUser" })).resolves.toBeDefined();
    const a = await create();
    await expect(h.signUp(a.token, "fed", { triggerSource: "PreSignUp_ExternalProvider" })).rejects.toThrow("Sign-up failed");
  });

  // Whether Cognito refuses a taken username before or after it runs the trigger isn't documented, so the
  // trigger checks itself: a clash must never spend the Invite (ticket 12).
  it("a taken username is refused before the Invite is spent; the same link then works with another username", async () => {
    await h.signUp((await create()).token, "sam");
    const a = await create();
    await expect(h.signUp(a.token, "sam")).rejects.toThrow(/^That username is taken\. Pick another\.$/);
    await expect(h.signUp(a.token, "SAM")).rejects.toThrow(/taken/); // usernames are case-insensitive
    expect((await list()).map((i: { token: string }) => i.token)).toEqual([a.token]);
    await expect(h.signUp(a.token, "newbie")).resolves.toBeDefined();
    await expect(h.signUp(a.token, "newbie2")).rejects.toThrow("Sign-up failed");
  });

  it("says nothing about usernames without an open Invite (no username probing)", async () => {
    const used = await create();
    await h.signUp(used.token, "first");
    for (const t of ["AAECAwQFBgcICQoLDA0ODw", used.token]) {
      await expect(h.signUp(t, "first")).rejects.toThrow(/^Sign-up failed\. Ask for a new Invite\.$/);
    }
  });

  it("if Cognito can't be asked about the username, it refuses with try again and leaves the Invite open", async () => {
    const a = await create();
    h.breakCognito();
    await expect(h.signUp(a.token, "newbie")).rejects.toThrow(/^Sign-up couldn't finish\. Try again in a minute\.$/);
    h.breakCognito(false);
    expect(await tokens()).toEqual([a.token]);
    await expect(h.signUp(a.token, "newbie")).resolves.toBeDefined();
  });

  it("stores no password, Display name or username of who spent it, only who made the Invite", async () => {
    const a = await create();
    await h.signUp(a.token, "newbie");
    const rec = h.db.dump().find((r) => r.PK === `INVITE#${a.token}`)!;
    expect(Object.keys(rec).sort()).toEqual(["PK", "SK", "createdAt", "creator", "expiresAt", "status", "usedAt"].sort());
    expect(rec).toMatchObject({ creator: h.A.sub, status: "used" });
  });
});
