// Cognito user-pool auth via the public JSON API (no SDK), as in HoneyDo and NutriSage.
// A password once, then a passkey (Face ID on iPhone; iCloud Keychain or phone QR on desktop),
// both on Cognito's USER_AUTH flow. The password stays as the backup. Tokens live in
// localStorage, so the installed PWA stays signed in across launches until the 7-day refresh token
// runs out.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { getConfig } from "./config";
import { HAS_PASSKEY, LAST_USER } from "./storageKeys";

interface Tokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  username: string;
}

const KEY = "throne.tokens";
let tokens: Tokens | null = JSON.parse(localStorage.getItem(KEY) ?? "null");
const listeners = new Set<() => void>();

export function onAuthChange(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function save(t: Tokens | null) {
  tokens = t;
  if (t) {
    localStorage.setItem(KEY, JSON.stringify(t));
    localStorage.setItem(LAST_USER, t.username);
  } else {
    localStorage.removeItem(KEY);
  }
  listeners.forEach((fn) => fn());
}

export function isSignedIn() {
  return tokens !== null;
}

/** The signed-in Profile's username, or undefined when signed out. */
export function currentUsername(): string | undefined {
  return tokens?.username;
}

export function lastUsername(): string | undefined {
  return localStorage.getItem(LAST_USER) ?? undefined;
}

/** Whether this device has added a passkey for the signed-in Profile (Settings hides the prompt). */
export function hasPasskeyHere() {
  return localStorage.getItem(HAS_PASSKEY) === "1";
}

export class CognitoError extends Error {
  constructor(readonly type: string | undefined, message: string) {
    super(message);
  }
}

async function cognito<T = any>(target: string, body: object): Promise<T> {
  const { region } = getConfig();
  const r = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new CognitoError(json.__type, json.message ?? json.__type ?? `Cognito ${target} failed`);
  return json as T;
}

function accept(result: any, username: string, refreshToken?: string) {
  const a = result.AuthenticationResult;
  if (!a) throw new Error(`Unexpected sign-in step: ${result.ChallengeName ?? "unknown"}`);
  save({
    idToken: a.IdToken,
    accessToken: a.AccessToken,
    refreshToken: a.RefreshToken ?? refreshToken,
    expiresAt: Date.now() + a.ExpiresIn * 1000,
    username,
  });
}

export async function signInWithPassword(username: string, password: string) {
  const { clientId } = getConfig();
  const u = username.trim().toLowerCase();
  let r = await cognito("InitiateAuth", {
    AuthFlow: "USER_AUTH",
    ClientId: clientId,
    AuthParameters: { USERNAME: u, PREFERRED_CHALLENGE: "PASSWORD", PASSWORD: password },
  });
  if (r.ChallengeName === "PASSWORD" || r.ChallengeName === "SELECT_CHALLENGE") {
    r = await cognito("RespondToAuthChallenge", {
      ClientId: clientId,
      ChallengeName: r.ChallengeName,
      Session: r.Session,
      ChallengeResponses: { USERNAME: u, PASSWORD: password, ...(r.ChallengeName === "SELECT_CHALLENGE" ? { ANSWER: "PASSWORD" } : {}) },
    });
  }
  accept(r, u);
}

/** The Invite was unknown, expired, revoked or already used (the pre-sign-up trigger said no). */
export class InviteRefusedError extends Error {
  constructor() {
    super("This Invite can't be used. Ask for a new Invite.");
  }
}

/**
 * Create a Profile's sign-in from an Invite link, then sign in with it. The token goes as
 * ClientMetadata to the pre-sign-up trigger (api/src/preSignUp.ts), which spends the Invite and
 * auto-confirms. Check the form first (shared/src/signUp.ts): a refused request may still spend it.
 * The trigger checks a taken username itself before spending (ticket 12), and says so; that and its
 * "try again" answer leave the Invite open, so the page keeps the form instead of showing "spent".
 */
export async function signUpWithInvite(inviteToken: string, username: string, password: string) {
  const { clientId } = getConfig();
  const u = username.trim().toLowerCase();
  try {
    await cognito("SignUp", { ClientId: clientId, Username: u, Password: password, ClientMetadata: { inviteToken } });
  } catch (e) {
    if (e instanceof CognitoError && e.type === "UserLambdaValidationException") {
      // Cognito wraps the trigger's message: "PreSignUp failed with error <message>."
      if (/That username is taken\./.test(e.message)) throw new Error("That username is taken. Pick another.");
      if (/Try again in a minute\./.test(e.message)) throw new Error("Sign-up couldn't finish. Try again in a minute.");
      throw new InviteRefusedError();
    }
    if (e instanceof CognitoError && e.type === "UsernameExistsException") throw new Error("That username is taken. Pick another.");
    throw e;
  }
  await signInWithPassword(u, password);
}

/** The browser's passkey prompt; a cancel or timeout (NotAllowedError) reads plainly. */
async function webauthn<T>(prompt: () => Promise<T>): Promise<T> {
  try {
    return await prompt();
  } catch (e) {
    const err = e as Error;
    if (err.name === "NotAllowedError" || err.name === "AbortError") throw new Error("Passkey cancelled.");
    throw err;
  }
}

export async function signInWithPasskey(username: string) {
  const { clientId } = getConfig();
  const u = username.trim().toLowerCase();
  const r = await cognito("InitiateAuth", {
    AuthFlow: "USER_AUTH",
    ClientId: clientId,
    AuthParameters: { USERNAME: u, PREFERRED_CHALLENGE: "WEB_AUTHN" },
  });
  if (r.ChallengeName !== "WEB_AUTHN") throw new Error("No passkey saved for you yet. Sign in with your password once, then add one in Settings.");
  const credential = await webauthn(() => startAuthentication({ optionsJSON: JSON.parse(r.ChallengeParameters.CREDENTIAL_REQUEST_OPTIONS) }));
  const done = await cognito("RespondToAuthChallenge", {
    ClientId: clientId,
    ChallengeName: "WEB_AUTHN",
    Session: r.Session,
    ChallengeResponses: { USERNAME: u, CREDENTIAL: JSON.stringify(credential) },
  });
  accept(done, u);
}

/** Add a passkey for the signed-in Profile. Its relying party is the app domain (set on the pool). */
export async function registerPasskey() {
  const accessToken = (await freshTokens()).accessToken;
  const { CredentialCreationOptions } = await cognito("StartWebAuthnRegistration", { AccessToken: accessToken });
  const credential = await webauthn(() => startRegistration({ optionsJSON: CredentialCreationOptions }));
  await cognito("CompleteWebAuthnRegistration", { AccessToken: accessToken, Credential: credential });
  localStorage.setItem(HAS_PASSKEY, "1");
}

/** Cognito's ListWebAuthnCredentials entry (CreatedAt in epoch seconds). */
export interface Passkey {
  CredentialId: string;
  FriendlyCredentialName?: string;
  RelyingPartyId?: string;
  CreatedAt: number;
}

export async function listPasskeys(): Promise<Passkey[]> {
  const r = await cognito("ListWebAuthnCredentials", { AccessToken: (await freshTokens()).accessToken });
  return r.Credentials ?? [];
}

let refreshing: Promise<Tokens> | null = null;

/** Valid tokens, refreshing if within 5 minutes of expiry. */
export async function freshTokens(): Promise<Tokens> {
  if (!tokens) throw new Error("signed out");
  if (tokens.expiresAt - Date.now() > 5 * 60_000) return tokens;
  refreshing ??= (async () => {
    const t = tokens!;
    try {
      const r = await cognito("InitiateAuth", {
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: getConfig().clientId,
        AuthParameters: { REFRESH_TOKEN: t.refreshToken },
      });
      accept(r, t.username, t.refreshToken);
      return tokens!;
    } catch (e) {
      // Only a refresh token Cognito won't take signs you out. Network and server errors keep the
      // session, so the app still opens offline.
      if (e instanceof CognitoError && e.type === "NotAuthorizedException") save(null);
      throw e;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function signOut() {
  const t = tokens;
  // A device-wide flag that would mislead the next person on a shared device.
  localStorage.removeItem(HAS_PASSKEY);
  save(null);
  if (t) await cognito("RevokeToken", { Token: t.refreshToken, ClientId: getConfig().clientId }).catch(() => {});
}
