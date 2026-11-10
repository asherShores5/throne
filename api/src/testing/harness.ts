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
import { FakeDocClient, asLambda } from "./fakeDynamo";

/** A signed-in Cognito user, as AppSync sees them. The sub is what identifies a Profile. */
export interface Caller {
  sub: string;
  username: string;
}

const caller = (name: string): Caller => ({ sub: `sub-${name}`, username: name });
/** Four callers: a Profile plus up to three Friends is the biggest group Throne has. */
export const CALLERS = { A: caller("a"), B: caller("b"), C: caller("c"), D: caller("d") };

process.env.TABLE_NAME = process.env.TABLE_NAME ?? "test-table";

const { handler, setDocClient, setEventSink, setUserDeleter } = await import("../handler");
const { QUERY_FIELDS } = await import("../resolvers");
const { handler: preSignUp, setUserLookup } = await import("../preSignUp");
const notifier = await import("../notifier");

/** One push the fake push service accepted. */
export interface SentPush {
  endpoint: string;
  payload: string;
  opts: import("../notifier").SendOptions;
}

// Events the API handed off (instead of invoking the Notifier Lambda), and the fake push service.
let events: unknown[] = [];
let eventsBroken = false;
setEventSink(async (e) => {
  if (eventsBroken) throw new Error("Lambda is down");
  events.push(structuredClone(e));
});
let pushes: SentPush[] = [];
const failing = new Map<string, number>();
notifier.setPushSender(async (sub, payload, opts) => {
  const status = failing.get(sub.endpoint);
  if (status) throw Object.assign(new Error(`push service said ${status}`), { statusCode: status });
  pushes.push({ endpoint: sub.endpoint, payload, opts });
});

// The Cognito users the API deleted (AdminDeleteUser), and a switch to make Cognito unreachable.
let deletedUsers: string[] = [];
let cognitoBroken = false;
setUserDeleter(async (username) => {
  if (cognitoBroken) throw Object.assign(new Error("Cognito is down"), { name: "InternalErrorException" });
  if (!deletedUsers.includes(username)) deletedUsers.push(username); // like Cognito: deleting twice is one deletion
  users.delete(username.toLowerCase());
});

// The pool's usernames (case-insensitive, like this pool): everyone signUp() let in and the API hasn't deleted.
// (The callers A-D are just tokens; a test that needs one of them in the pool signs them up.)
const startingUsers = () => new Set<string>();
let users = startingUsers();
setUserLookup(async (_pool, username) => {
  if (cognitoBroken) throw Object.assign(new Error("Cognito is down"), { name: "InternalErrorException" });
  return users.has(username.toLowerCase());
});

/** The trigger, then (if it let the sign-up through) Cognito creating the user, as SignUp does. */
async function runSignUp(event: PreSignUpTriggerEvent) {
  const out = await asLambda("preSignUp", () => preSignUp(event));
  users.add(event.userName.toLowerCase());
  return out;
}

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
    /** Empty the table (and the push bookkeeping below). Call from beforeEach. */
    reset: () => {
      db.reset();
      events = [];
      pushes = [];
      failing.clear();
      eventsBroken = false;
      deletedUsers = [];
      cognitoBroken = false;
      users = startingUsers();
    },
    /** Cognito usernames the API deleted so far (Delete Profile). */
    deletedUsers: () => deletedUsers,
    /** Make Cognito unreachable (true) or reachable again (false). */
    breakCognito: (broken = true) => void (cognitoBroken = broken),
    /** The push events the API handed to the Notifier so far (not yet delivered). */
    events: () => events,
    /** Run the real Notifier on every event so far (in order), as Lambda would; the summary of each run. */
    deliver: async () => {
      const todo = events;
      events = [];
      const out = [];
      for (const e of todo) out.push(await asLambda("notifier", () => notifier.handler(e)));
      return out;
    },
    /** Invoke the Notifier with any event. */
    notify: (e: unknown) => asLambda("notifier", () => notifier.handler(e)),
    /** Pushes the fake push service accepted since the last call. */
    takePushes: () => {
      const out = pushes;
      pushes = [];
      return out;
    },
    /** Make the push service answer `status` for this endpoint from now on. */
    failPush: (endpoint: string, status: number) => void failing.set(endpoint, status),
    /** Make every hand-off to the Notifier fail (Lambda unreachable). */
    breakEvents: () => void (eventsBroken = true),
    event: appSyncEvent,
    /** Invoke the handler as `who`. Rejects with the same Error the client would see. */
    call: (who: Caller, fieldName: string, args: Record<string, unknown> = {}): Promise<any> => asLambda("api", () => handler(appSyncEvent(who, fieldName, args))),
    /** Invoke the handler with a raw event (e.g. no identity at all). */
    raw: (event: AppSyncResolverEvent<Record<string, unknown>>): Promise<any> => asLambda("api", () => handler(event)),
    /** Run the Cognito pre-sign-up trigger for a SignUp with this Invite token. Rejects as Cognito would see it. */
    signUp: (token: string | undefined, username: string, opts?: SignUpOptions) => runSignUp(preSignUpEvent(token, username, opts)),
  };
}
