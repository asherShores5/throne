// Seam 1 test harness: call the real Lambda handler as any of several Profiles against an in-memory table.
//
//   const h = harness();
//   beforeEach(() => h.reset());
//   const me = await h.call(h.A, "me", { homeZone: "America/Los_Angeles" });
//   await expect(h.call(h.B, "someField", {})).rejects.toThrow("NotFound: ...");
//   await h.signUp(inviteToken, "newbie");      // the Cognito pre-sign-up trigger (preSignUp.ts)
//
// handler.ts and preSignUp.ts read TABLE_NAME at import time, so tests must import the handler through this module
// (never statically) for the env below to take effect.
import type { AppSyncIdentityCognito, AppSyncResolverEvent, PreSignUpTriggerEvent } from "aws-lambda";
import { FakeDocClient } from "./fakeDynamo";

/** A signed-in Cognito user, as AppSync sees them. The sub is what identifies a Profile. */
export interface Caller {
  sub: string;
  username: string;
}

const caller = (name: string): Caller => ({ sub: `sub-${name}`, username: name });
/** Four callers: a Profile plus up to three Friends is the biggest group Throne has. */
export const CALLERS = { A: caller("a"), B: caller("b"), C: caller("c"), D: caller("d") };

process.env.TABLE_NAME = process.env.TABLE_NAME ?? "test-table";

const { handler, setDocClient } = await import("../handler");
const { QUERY_FIELDS } = await import("../resolvers");
const { handler: preSignUp } = await import("../preSignUp");

export interface SignUpOptions {
  /** Where the web app put the token: ClientMetadata (what it sends) or ValidationData. */
  via?: "clientMetadata" | "validationData";
  /** Which Cognito path ran the trigger (SignUp from the app by default). */
  triggerSource?: PreSignUpTriggerEvent["triggerSource"];
}

/** The Cognito pre-sign-up trigger event for a SignUp call with this Invite token and username. */
export function preSignUpEvent(token: string | undefined, username: string, opts: SignUpOptions = {}): PreSignUpTriggerEvent {
  const meta = token === undefined ? undefined : { inviteToken: token };
  return {
    version: "1",
    region: "us-west-1",
    userPoolId: "us-west-1_test",
    userName: username,
    callerContext: { awsSdkVersion: "test", clientId: "test-client" },
    triggerSource: opts.triggerSource ?? "PreSignUp_SignUp",
    request: {
      userAttributes: {},
      ...(opts.via === "validationData" ? { validationData: meta } : { clientMetadata: meta }),
    },
    response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
  };
}

const db = new FakeDocClient();
setDocClient(db);

/** AppSync-shaped resolver event for one caller calling one field. */
export function appSyncEvent(who: Caller, fieldName: string, args: Record<string, unknown> = {}) {
  const identity = {
    sub: who.sub,
    username: who.username,
    claims: { sub: who.sub, "cognito:username": who.username },
    issuer: "test", sourceIp: [], defaultAuthStrategy: "ALLOW", groups: null,
  } satisfies AppSyncIdentityCognito;
  return {
    arguments: args,
    identity,
    source: null,
    request: { headers: {}, domainName: null },
    info: { fieldName, parentTypeName: QUERY_FIELDS.has(fieldName) ? "Query" : "Mutation", variables: args, selectionSetList: [], selectionSetGraphQL: "" },
    prev: null,
    stash: {},
  } as AppSyncResolverEvent<Record<string, unknown>>;
}

export function harness() {
  return {
    ...CALLERS,
    db,
    /** Empty the table. Call from beforeEach. */
    reset: () => db.reset(),
    event: appSyncEvent,
    /** Invoke the handler as `who`. Rejects with the same Error the client would see. */
    call: (who: Caller, fieldName: string, args: Record<string, unknown> = {}): Promise<any> => handler(appSyncEvent(who, fieldName, args)),
    /** Invoke the handler with a raw event (e.g. no identity at all). */
    raw: (event: AppSyncResolverEvent<Record<string, unknown>>): Promise<any> => handler(event),
    /** Run the Cognito pre-sign-up trigger for a SignUp with this Invite token. Rejects as Cognito would see it. */
    signUp: (token: string | undefined, username: string, opts?: SignUpOptions) => preSignUp(preSignUpEvent(token, username, opts)),
  };
}
