import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// auth.ts against a fake Cognito JSON API: password sign-in survives an app relaunch (fresh module,
// same localStorage), expired tokens refresh, and only a rejected refresh token signs out.
// Passkeys: the browser's WebAuthn prompt (Face ID, Keychain, phone QR) is stubbed at the
// @simplewebauthn/browser boundary; what's checked is what goes to and from Cognito.

const webauthn = vi.hoisted(() => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));
vi.mock("@simplewebauthn/browser", () => webauthn);

const CONFIG = { region: "us-west-1", userPoolId: "us-west-1_TEST", clientId: "client-1", graphqlUrl: "https://api.example/graphql" };

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

type Reply = { status: number; body: unknown } | "network-error";
let cognito: Record<string, Reply[]>;
let calls: { target: string; body: any }[];

const ok = (AuthenticationResult: object) => ({ status: 200, body: { AuthenticationResult } });
const tokens = (n: number, refresh?: string) => ({ IdToken: `id-${n}`, AccessToken: `access-${n}`, ExpiresIn: 3600, ...(refresh ? { RefreshToken: refresh } : {}) });

async function launch() {
  vi.resetModules();
  const config = await import("./config");
  await config.loadConfig();
  return import("./auth");
}

beforeEach(() => {
  webauthn.startAuthentication.mockReset();
  webauthn.startRegistration.mockReset();
  cognito = {};
  calls = [];
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "/config.json") return new Response(JSON.stringify(CONFIG));
    const target = String((init?.headers as Record<string, string>)["X-Amz-Target"]).split(".")[1];
    calls.push({ target, body: JSON.parse(String(init?.body)) });
    const reply = cognito[target]?.shift();
    if (!reply) throw new Error(`unexpected Cognito call ${target}`);
    if (reply === "network-error") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function signedIn() {
  cognito.InitiateAuth = [ok(tokens(1, "refresh-1"))];
  const auth = await launch();
  await auth.signInWithPassword("Asher ", "a-long-password-here");
  return auth;
}

describe("password sign-in", () => {
  it("signs in with USER_AUTH and the password challenge, as the lowercased username", async () => {
    const auth = await signedIn();
    expect(auth.isSignedIn()).toBe(true);
    expect(auth.currentUsername()).toBe("asher");
    expect(calls[0]).toEqual({
      target: "InitiateAuth",
      body: { AuthFlow: "USER_AUTH", ClientId: "client-1", AuthParameters: { USERNAME: "asher", PREFERRED_CHALLENGE: "PASSWORD", PASSWORD: "a-long-password-here" } },
    });
  });

  it("a wrong password shows Cognito's message and stays signed out", async () => {
    cognito.InitiateAuth = [{ status: 400, body: { __type: "NotAuthorizedException", message: "Incorrect username or password." } }];
    const auth = await launch();
    await expect(auth.signInWithPassword("asher", "nope")).rejects.toThrow("Incorrect username or password.");
    expect(auth.isSignedIn()).toBe(false);
  });
});

describe("staying signed in", () => {
  it("a relaunched app is still signed in, with no Cognito call", async () => {
    await signedIn();
    const relaunched = await launch();
    expect(relaunched.isSignedIn()).toBe(true);
    expect((await relaunched.freshTokens()).idToken).toBe("id-1");
    expect(calls.map((c) => c.target)).toEqual(["InitiateAuth"]);
  });

  it("expired tokens refresh with the stored refresh token, which is kept", async () => {
    await signedIn();
    vi.useFakeTimers({ now: Date.now() + 2 * 3600_000, toFake: ["Date"] });
    cognito.InitiateAuth = [ok(tokens(2))];
    const auth = await launch();
    expect((await auth.freshTokens()).idToken).toBe("id-2");
    expect(calls.at(-1)).toEqual({
      target: "InitiateAuth",
      body: { AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: "client-1", AuthParameters: { REFRESH_TOKEN: "refresh-1" } },
    });
  });

  it("a network failure during refresh keeps the session (offline use)", async () => {
    await signedIn();
    vi.useFakeTimers({ now: Date.now() + 2 * 3600_000, toFake: ["Date"] });
    cognito.InitiateAuth = ["network-error"];
    const auth = await launch();
    await expect(auth.freshTokens()).rejects.toThrow();
    expect(auth.isSignedIn()).toBe(true);
  });

  it("a rejected refresh token (the week is up) signs out", async () => {
    await signedIn();
    vi.useFakeTimers({ now: Date.now() + 2 * 3600_000, toFake: ["Date"] });
    cognito.InitiateAuth = [{ status: 400, body: { __type: "NotAuthorizedException", message: "Refresh Token has expired" } }];
    const auth = await launch();
    await expect(auth.freshTokens()).rejects.toThrow(/expired/);
    expect(auth.isSignedIn()).toBe(false);
    expect((await launch()).isSignedIn()).toBe(false);
  });
});

const REQUEST_OPTIONS = { challenge: "abc", rpId: "throne.ashershores.com", userVerification: "required" };
const ASSERTION = { id: "cred-1", rawId: "cred-1", type: "public-key", response: { signature: "sig" } };
const challenge = (ChallengeName: string, extra: object = {}) => ({ status: 200, body: { ChallengeName, Session: "session-1", ...extra } });

describe("passkey sign-in", () => {
  it("asks Cognito for the WEB_AUTHN challenge, has the browser sign it, and signs in", async () => {
    cognito.InitiateAuth = [challenge("WEB_AUTHN", { ChallengeParameters: { CREDENTIAL_REQUEST_OPTIONS: JSON.stringify(REQUEST_OPTIONS) } })];
    cognito.RespondToAuthChallenge = [ok(tokens(1, "refresh-1"))];
    webauthn.startAuthentication.mockResolvedValue(ASSERTION);
    const auth = await launch();
    await auth.signInWithPasskey(" Aubyn");
    expect(auth.isSignedIn()).toBe(true);
    expect(auth.currentUsername()).toBe("aubyn");
    expect(calls[0].body).toEqual({ AuthFlow: "USER_AUTH", ClientId: "client-1", AuthParameters: { USERNAME: "aubyn", PREFERRED_CHALLENGE: "WEB_AUTHN" } });
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: REQUEST_OPTIONS });
    expect(calls[1]).toEqual({
      target: "RespondToAuthChallenge",
      body: { ClientId: "client-1", ChallengeName: "WEB_AUTHN", Session: "session-1", ChallengeResponses: { USERNAME: "aubyn", CREDENTIAL: JSON.stringify(ASSERTION) } },
    });
  });

  it("with no passkey on the account yet, says to use the password once and stays signed out", async () => {
    cognito.InitiateAuth = [challenge("SELECT_CHALLENGE", { AvailableChallenges: ["PASSWORD"] })];
    const auth = await launch();
    await expect(auth.signInWithPasskey("asher")).rejects.toThrow("No passkey saved for you yet. Sign in with your password once, then add one in Settings.");
    expect(webauthn.startAuthentication).not.toHaveBeenCalled();
    expect(auth.isSignedIn()).toBe(false);
  });

  it("a cancelled Face ID prompt reads plainly and sends nothing to Cognito", async () => {
    cognito.InitiateAuth = [challenge("WEB_AUTHN", { ChallengeParameters: { CREDENTIAL_REQUEST_OPTIONS: JSON.stringify(REQUEST_OPTIONS) } })];
    webauthn.startAuthentication.mockRejectedValue(Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" }));
    const auth = await launch();
    await expect(auth.signInWithPasskey("asher")).rejects.toThrow("Passkey cancelled.");
    expect(calls.map((c) => c.target)).toEqual(["InitiateAuth"]);
    expect(auth.isSignedIn()).toBe(false);
  });

  it("the sign-in screen remembers the last username signed in on this device", async () => {
    let auth = await launch();
    expect(auth.lastUsername()).toBeUndefined();
    auth = await signedIn();
    await auth.signOut().catch(() => {});
    expect((await launch()).lastUsername()).toBe("asher");
  });
});

describe("adding a passkey", () => {
  const CREATION = { challenge: "xyz", rp: { id: "throne.ashershores.com", name: "throne" }, user: { id: "u", name: "asher" } };
  const ATTESTATION = { id: "new-cred", type: "public-key", response: { attestationObject: "att" } };

  it("registers with the signed-in Profile's access token and remembers it on this device", async () => {
    const auth = await signedIn();
    expect(auth.hasPasskeyHere()).toBe(false);
    cognito.StartWebAuthnRegistration = [{ status: 200, body: { CredentialCreationOptions: CREATION } }];
    cognito.CompleteWebAuthnRegistration = [{ status: 200, body: {} }];
    webauthn.startRegistration.mockResolvedValue(ATTESTATION);
    await auth.registerPasskey();
    expect(calls.slice(1)).toEqual([
      { target: "StartWebAuthnRegistration", body: { AccessToken: "access-1" } },
      { target: "CompleteWebAuthnRegistration", body: { AccessToken: "access-1", Credential: ATTESTATION } },
    ]);
    expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: CREATION });
    expect((await launch()).hasPasskeyHere()).toBe(true);
  });

  it("a cancelled prompt adds nothing", async () => {
    const auth = await signedIn();
    cognito.StartWebAuthnRegistration = [{ status: 200, body: { CredentialCreationOptions: CREATION } }];
    webauthn.startRegistration.mockRejectedValue(Object.assign(new Error("not allowed"), { name: "NotAllowedError" }));
    await expect(auth.registerPasskey()).rejects.toThrow("Passkey cancelled.");
    expect(calls.map((c) => c.target)).toEqual(["InitiateAuth", "StartWebAuthnRegistration"]);
    expect(auth.hasPasskeyHere()).toBe(false);
  });

  it("lists how many passkeys the Profile has", async () => {
    const auth = await signedIn();
    cognito.ListWebAuthnCredentials = [{ status: 200, body: { Credentials: [{ CredentialId: "a", CreatedAt: 1 }, { CredentialId: "b", CreatedAt: 2 }] } }];
    expect((await auth.listPasskeys()).map((p) => p.CredentialId)).toEqual(["a", "b"]);
    expect(calls.at(-1)).toEqual({ target: "ListWebAuthnCredentials", body: { AccessToken: "access-1" } });
  });
});

describe("signing out", () => {
  it("revokes the refresh token and forgets this device's passkey flag, so the next person isn't misled", async () => {
    const auth = await signedIn();
    cognito.StartWebAuthnRegistration = [{ status: 200, body: { CredentialCreationOptions: {} } }];
    cognito.CompleteWebAuthnRegistration = [{ status: 200, body: {} }];
    webauthn.startRegistration.mockResolvedValue({});
    await auth.registerPasskey();
    cognito.RevokeToken = [{ status: 200, body: {} }];
    await auth.signOut();
    expect(calls.at(-1)).toEqual({ target: "RevokeToken", body: { Token: "refresh-1", ClientId: "client-1" } });
    const relaunched = await launch();
    expect(relaunched.isSignedIn()).toBe(false);
    expect(relaunched.hasPasskeyHere()).toBe(false);
  });
});

describe("sign-up with an Invite", () => {
  const TOKEN = "AAECAwQFBgcICQoLDA0ODw";

  it("calls SignUp with the Invite token as ClientMetadata, then signs in with the new password", async () => {
    cognito.SignUp = [{ status: 200, body: { UserConfirmed: true, UserSub: "sub-new" } }];
    cognito.InitiateAuth = [ok(tokens(1, "refresh-1"))];
    const auth = await launch();
    await auth.signUpWithInvite(TOKEN, "NewBie", "Correct horse 42");
    expect(calls[0]).toEqual({
      target: "SignUp",
      body: { ClientId: "client-1", Username: "newbie", Password: "Correct horse 42", ClientMetadata: { inviteToken: TOKEN } },
    });
    expect(calls[1].body.AuthParameters).toMatchObject({ USERNAME: "newbie", PASSWORD: "Correct horse 42" });
    expect(auth.isSignedIn()).toBe(true);
  });

  it("an Invite the trigger refuses is an InviteRefusedError and signs nobody in", async () => {
    cognito.SignUp = [{ status: 400, body: { __type: "UserLambdaValidationException", message: "PreSignUp failed with error Sign-up failed. Ask for a new Invite.." } }];
    const auth = await launch();
    const err = await auth.signUpWithInvite(TOKEN, "newbie", "Correct horse 42").catch((e) => e);
    expect(err).toBeInstanceOf(auth.InviteRefusedError);
    expect(auth.isSignedIn()).toBe(false);
  });

  it("a taken username says so plainly", async () => {
    cognito.SignUp = [{ status: 400, body: { __type: "UsernameExistsException", message: "User already exists" } }];
    const auth = await launch();
    await expect(auth.signUpWithInvite(TOKEN, "asher", "Correct horse 42")).rejects.toThrow("That username is taken. Pick another.");
  });

  it("the trigger's taken-username and try-again answers keep the Invite usable (not InviteRefusedError)", async () => {
    cognito.SignUp = [
      { status: 400, body: { __type: "UserLambdaValidationException", message: "PreSignUp failed with error That username is taken. Pick another.." } },
      { status: 400, body: { __type: "UserLambdaValidationException", message: "PreSignUp failed with error Sign-up couldn't finish. Try again in a minute.." } },
    ];
    const auth = await launch();
    const taken = await auth.signUpWithInvite(TOKEN, "asher", "Correct horse 42").catch((e) => e);
    expect(taken).not.toBeInstanceOf(auth.InviteRefusedError);
    expect(taken.message).toBe("That username is taken. Pick another.");
    const later = await auth.signUpWithInvite(TOKEN, "asher2", "Correct horse 42").catch((e) => e);
    expect(later).not.toBeInstanceOf(auth.InviteRefusedError);
    expect(later.message).toBe("Sign-up couldn't finish. Try again in a minute.");
  });
});
