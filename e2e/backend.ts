// Fake backend for browser checks (HoneyDo/NutriSage pattern): the real API handler on the in-memory
// table, behind a GraphQL executor built from the composed schema/*.graphql, plus just enough Cognito
// for the web app to sign in. Nothing here talks to AWS.
import { buildSchema, defaultFieldResolver, execute, parse, type GraphQLFieldResolver } from "graphql";
import { QUERY_DEPTH_LIMIT, composeSchemaDir, queryDepth } from "../schema/compose";

/** A Cognito user the fake knows: sign-in username and the sub that identifies their Profile. */
export interface User {
  sub: string;
  username: string;
}

export const USERS: Record<string, User> = {
  sam: { sub: "sub-sam", username: "sam" },
  alex: { sub: "sub-alex", username: "alex" },
  jo: { sub: "sub-jo", username: "jo" },
  max: { sub: "sub-max", username: "max" },
};

// handler.ts reads these at import time, so import it only after setting them.
process.env.TABLE_NAME = "e2e-table";
const { handler, setDocClient } = await import("../api/src/handler");
const { FakeDocClient } = await import("../api/src/testing/fakeDynamo");
const { appSyncEvent } = await import("../api/src/testing/harness");
const { setClock } = await import("../api/src/clock");

/** Run the server on a check's faked clock: server now = `start` plus the real time passed since this call. */
export function setServerClock(start: string | Date) {
  const skew = new Date(start).getTime() - Date.now();
  setClock(() => Date.now() + skew);
}

export const db = new FakeDocClient();
setDocClient(db);

// AppSync supplies these scalars; graphql-js needs them declared.
const schema = buildSchema(`scalar AWSJSON\nscalar AWSDate\nscalar AWSDateTime\n${composeSchemaDir()}`);

/** Per-call log, so a check can assert what the app sent. */
export const calls: { user: string; field: string; args: unknown }[] = [];

export function userForToken(token: string | undefined): User | undefined {
  const name = token?.startsWith("fake-id.") ? token.slice("fake-id.".length) : undefined;
  return name ? USERS[name] : undefined;
}

export async function graphql(token: string | undefined, query: string, variables: Record<string, unknown> = {}) {
  const user = userForToken(token);
  if (!user) return { errors: [{ message: "Unauthorized", errorType: "UnauthorizedException" }] };
  // AppSync's cap (infra/lib/stacks.ts). Live it nulls the fields past the cap; failing loudly here is what
  // catches a selection that grew too deep.
  if (queryDepth(query) > QUERY_DEPTH_LIMIT) return { errors: [{ message: `Query depth limit reached. (${queryDepth(query)} > ${QUERY_DEPTH_LIMIT})` }] };
  const fieldResolver: GraphQLFieldResolver<unknown, unknown> = async (src, args, ctx, info) => {
    const parent = info.parentType.name;
    if (parent !== "Query" && parent !== "Mutation") return defaultFieldResolver(src, args, ctx, info);
    calls.push({ user: user.username, field: info.fieldName, args });
    return handler(appSyncEvent(user, info.fieldName, args as Record<string, unknown>));
  };
  const result = await execute({ schema, document: parse(query), variableValues: variables, fieldResolver });
  return JSON.parse(JSON.stringify(result));
}

// ---- Cognito (only the calls web/src/auth.ts makes) -----------------------

export const PASSWORD = "e2e-password";

const tokensFor = (username: string) => ({
  AuthenticationResult: {
    IdToken: `fake-id.${username}`, AccessToken: `fake-access.${username}`,
    RefreshToken: `fake-refresh.${username}`, ExpiresIn: 3600, TokenType: "Bearer",
  },
});

/** The fake relying party: the test origin's host (the real pool uses the app domain). */
export const RP_ID = "throne.test";

/** Passkey credential IDs per user, as Cognito would hold them. */
const passkeys = new Map<string, string[]>();
const sessions = new Map<string, string>();
const b64url = (s: string) => Buffer.from(s).toString("base64url");
const challenge = () => b64url(crypto.randomUUID());
const userForAccess = (token: unknown) => {
  const u = String(token ?? "").replace(/^fake-access\./, "");
  return USERS[u] ? u : undefined;
};

/** Start a check with these passkeys on the account (or none). */
export function setPasskeys(username: string, ids: string[]) {
  passkeys.set(username, [...ids]);
}
export const passkeysOf = (username: string) => passkeys.get(username) ?? [];

export function cognito(target: string, body: any): { status: number; json: unknown } {
  const fail = (type: string, message: string) => ({ status: 400, json: { __type: type, message } });
  const wrong = () => fail("NotAuthorizedException", "Incorrect username or password.");
  switch (target) {
    case "InitiateAuth": {
      if (body.AuthFlow === "REFRESH_TOKEN_AUTH") {
        const u = String(body.AuthParameters?.REFRESH_TOKEN ?? "").replace(/^fake-refresh\./, "");
        return USERS[u] ? { status: 200, json: { AuthenticationResult: { ...tokensFor(u).AuthenticationResult, RefreshToken: undefined } } } : fail("NotAuthorizedException", "Invalid Refresh Token");
      }
      const u = body.AuthParameters?.USERNAME;
      if (body.AuthParameters?.PREFERRED_CHALLENGE === "WEB_AUTHN") {
        const ids = USERS[u] ? passkeysOf(u) : [];
        // Like Cognito: no passkey means the other available challenges instead.
        if (!ids.length) return { status: 200, json: { ChallengeName: "SELECT_CHALLENGE", Session: "s-none", AvailableChallenges: ["PASSWORD"] } };
        const session = `s-${crypto.randomUUID()}`;
        sessions.set(session, u);
        const options = { challenge: challenge(), rpId: RP_ID, timeout: 60_000, userVerification: "required", allowCredentials: ids.map((id) => ({ id, type: "public-key" })) };
        return { status: 200, json: { ChallengeName: "WEB_AUTHN", Session: session, ChallengeParameters: { CREDENTIAL_REQUEST_OPTIONS: JSON.stringify(options) } } };
      }
      // preventUserExistenceErrors: an unknown user looks like a wrong password.
      if (!USERS[u] || body.AuthParameters?.PASSWORD !== PASSWORD) return wrong();
      return { status: 200, json: tokensFor(u) };
    }
    case "RespondToAuthChallenge": {
      if (body.ChallengeName !== "WEB_AUTHN") return fail("NotImplemented", `fake Cognito has no ${body.ChallengeName} challenge`);
      const u = sessions.get(body.Session);
      sessions.delete(body.Session);
      const id = JSON.parse(body.ChallengeResponses?.CREDENTIAL ?? "{}").id;
      if (!u || u !== body.ChallengeResponses?.USERNAME || !passkeysOf(u).includes(id)) return fail("NotAuthorizedException", "Passkey not recognized.");
      return { status: 200, json: tokensFor(u) };
    }
    case "StartWebAuthnRegistration": {
      const u = userForAccess(body.AccessToken);
      if (!u) return fail("NotAuthorizedException", "Invalid Access Token");
      return {
        status: 200,
        json: {
          CredentialCreationOptions: {
            challenge: challenge(), rp: { id: RP_ID, name: "Throne" },
            user: { id: b64url(u), name: u, displayName: u },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            authenticatorSelection: { residentKey: "required", userVerification: "required" },
            excludeCredentials: passkeysOf(u).map((id) => ({ id, type: "public-key" })),
          },
        },
      };
    }
    case "CompleteWebAuthnRegistration": {
      const u = userForAccess(body.AccessToken);
      if (!u) return fail("NotAuthorizedException", "Invalid Access Token");
      setPasskeys(u, [...passkeysOf(u), body.Credential.id]);
      return { status: 200, json: {} };
    }
    case "ListWebAuthnCredentials": {
      const u = userForAccess(body.AccessToken);
      if (!u) return fail("NotAuthorizedException", "Invalid Access Token");
      return { status: 200, json: { Credentials: passkeysOf(u).map((id, i) => ({ CredentialId: id, RelyingPartyId: RP_ID, CreatedAt: 1_800_000_000 + i })) } };
    }
    case "RevokeToken":
      return { status: 200, json: {} };
    default:
      return fail("NotImplemented", `fake Cognito has no ${target}`);
  }
}
