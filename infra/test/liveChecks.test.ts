import { describe, expect, it } from "vitest";
import { type LiveOutputs, PROBE_USERNAME, type Probe, runLiveChecks } from "../scripts/liveChecks";
import { contentSecurityPolicy } from "../lib/csp";

const OUT: LiveOutputs = {
  region: "us-west-1",
  siteUrl: "https://throne.example.com",
  graphqlUrl: "https://abc.appsync-api.us-west-1.amazonaws.com/graphql",
  userPoolId: "us-west-1_TEST",
  clientId: "client123",
  bucketName: "throneweb-bucket",
};
const VAPID = "B".repeat(87);
const CSP = contentSecurityPolicy({ region: OUT.region, graphqlHost: "abc.appsync-api.us-west-1.amazonaws.com" });
const HEADERS = {
  "content-security-policy": CSP,
  "strict-transport-security": "max-age=31536000",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=()",
  "cross-origin-opener-policy": "same-origin",
  "x-robots-tag": "noindex, nofollow",
};
type Reply = { status: number; headers?: Record<string, string>; body?: string };

/** A correctly locked-down deploy, as AWS answers anonymous callers. */
function lockedDown(p: Probe): Reply {
  const url = new URL(p.url);
  if (url.host === "abc.appsync-api.us-west-1.amazonaws.com") {
    return { status: 401, body: '{"errors":[{"errorType":"UnauthorizedException","message":"Valid authorization header not provided."}]}' };
  }
  if (url.host === "cognito-idp.us-west-1.amazonaws.com") {
    return { status: 400, body: '{"__type":"UserLambdaValidationException","message":"PreSignUp failed with error Sign-up failed. Ask for a new Invite.."}' };
  }
  if (url.host.endsWith(".s3.us-west-1.amazonaws.com")) return { status: 403, body: "<Error><Code>AccessDenied</Code></Error>" };
  if (url.host === "throne.example.com") {
    if (url.pathname === "/config.json") {
      return { status: 200, headers: HEADERS, body: JSON.stringify({ region: OUT.region, userPoolId: OUT.userPoolId, clientId: OUT.clientId, graphqlUrl: OUT.graphqlUrl, vapidPublicKey: VAPID }) };
    }
    return { status: 200, headers: HEADERS, body: '<!doctype html><title>Throne</title><div id="root"></div>' };
  }
  throw new Error(`unexpected probe ${p.method} ${p.url}`);
}

const fetcher = (answer: (p: Probe) => Reply) => async (p: Probe) => {
  const r = answer(p);
  return { status: r.status, headers: new Headers(r.headers ?? {}), text: r.body ?? "" };
};
const failed = (results: Awaited<ReturnType<typeof runLiveChecks>>) => results.filter((r) => !r.ok).map((r) => r.name);

describe("post-deploy live checks", () => {
  it("all pass against a locked-down deploy (with the real CSP), and never send a credential", async () => {
    const sent: Probe[] = [];
    const results = await runLiveChecks(OUT, fetcher((p) => (sent.push(p), lockedDown(p))));
    expect(failed(results)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(8);
    for (const p of sent) expect(Object.keys(p.headers ?? {}).map((h) => h.toLowerCase())).not.toContain("cookie");
    expect(sent.filter((p) => p.headers?.Authorization).map((p) => p.headers!.Authorization)).toEqual(["not-a-real-token"]);
  });

  it("fails if the API answers an anonymous caller", async () => {
    const results = await runLiveChecks(OUT, fetcher((p) => (p.url === OUT.graphqlUrl ? { status: 200, body: '{"data":{"__typename":"Query"}}' } : lockedDown(p))));
    expect(failed(results)).toEqual(["API refuses anonymous calls", "API refuses a junk token"]);
  });

  it("fails loudly, naming the user to delete, if a sign-up without a real Invite goes through", async () => {
    const results = await runLiveChecks(OUT, fetcher((p) => (p.url.includes("cognito-idp") ? { status: 200, body: '{"UserConfirmed":true}' } : lockedDown(p))));
    const bad = results.filter((r) => !r.ok);
    expect(bad.map((r) => r.name)).toEqual(["Sign-up without an Invite is refused by the pre-sign-up trigger", "Sign-up with an unknown Invite is refused, generically"]);
    expect(bad[0].detail).toContain(PROBE_USERNAME);
  });

  it("fails if sign-up is refused for some other reason than the trigger (the trigger wasn't tested)", async () => {
    const results = await runLiveChecks(OUT, fetcher((p) => (p.url.includes("cognito-idp") ? { status: 400, body: '{"__type":"InvalidPasswordException"}' } : lockedDown(p))));
    expect(failed(results)).toHaveLength(2);
  });

  it("fails if the bucket can be read directly", async () => {
    const results = await runLiveChecks(OUT, fetcher((p) => (p.url.includes(".s3.") ? { status: 200, body: "<html>" } : lockedDown(p))));
    expect(failed(results)).toEqual(["Bucket refuses direct reads"]);
  });

  it("names each missing or weakened header", async () => {
    const weak = { ...HEADERS, "content-security-policy": CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"), "x-frame-options": "SAMEORIGIN" } as Record<string, string>;
    delete weak["cross-origin-opener-policy"];
    const results = await runLiveChecks(OUT, fetcher((p) => (p.url === `${OUT.siteUrl}/` ? { status: 200, headers: weak, body: "" } : lockedDown(p))));
    const site = results.find((r) => r.name.startsWith("Site is public"))!;
    expect(site.ok).toBe(false);
    expect(site.detail).toMatch(/unsafe-\*.*X-Frame-Options DENY.*COOP/);
  });

  it("fails if config.json points elsewhere or has no VAPID key", async () => {
    const results = await runLiveChecks(OUT, fetcher((p) =>
      p.url.endsWith("/config.json") ? { status: 200, body: JSON.stringify({ region: OUT.region, userPoolId: "other", clientId: OUT.clientId, graphqlUrl: OUT.graphqlUrl }) } : lockedDown(p)));
    expect(results.find((r) => r.name === "config.json points at this deploy")?.detail).toBe("wrong userPoolId, vapidPublicKey");
  });

  it("reports a network failure as a failed check, not a crash", async () => {
    const results = await runLiveChecks(OUT, async () => {
      throw new Error("ENOTFOUND");
    });
    expect(results.every((r) => !r.ok && r.detail.includes("ENOTFOUND"))).toBe(true);
  });
});
