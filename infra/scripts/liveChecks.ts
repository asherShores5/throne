// Post-deploy release checks (docs/deploy-runbook.md), all made as an anonymous client: verify
// denial, not success. Pure apart from the injected fetcher, so the rules are unit-tested
// (test/liveChecks.test.ts) and check-live.ts runs them for real. From NutriSage, adapted: Throne has
// self sign-up ON, gated by the Invite pre-sign-up trigger, so the sign-up checks expect the trigger's
// refusal; there is no guest endpoint.

/** The stack outputs the checks need (from cdk-outputs.json). */
export interface LiveOutputs {
  region: string;
  siteUrl: string;
  graphqlUrl: string;
  userPoolId: string;
  clientId: string;
  bucketName: string;
}

export interface Probe {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ProbeReply {
  status: number;
  headers: Headers;
  text: string;
}

export type Fetcher = (probe: Probe) => Promise<ProbeReply>;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

interface Check {
  name: string;
  probes: Probe[];
  /** Returns "" when the replies are what a locked-down deploy gives, else what was wrong. */
  verdict: (replies: ProbeReply[]) => string;
}

/** The username the sign-up probes try. If a check FAILS because the sign-up went through, delete this user. */
export const PROBE_USERNAME = "live-check-probe";
/** Well-formed (22 base64url characters, 128 bits) but never issued: the trigger must refuse it. */
const UNKNOWN_INVITE = "AAAAAAAAAAAAAAAAAAAAAA";

function checks(o: LiveOutputs): Check[] {
  const site = o.siteUrl.replace(/\/$/, "");
  const gql = (headers: Record<string, string>): Probe => ({
    method: "POST",
    url: o.graphqlUrl,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ query: "{ __typename }" }),
  });
  const unauthorized = ([r]: ProbeReply[]) =>
    r.status === 401 && r.text.includes("UnauthorizedException") ? "" : `expected 401 UnauthorizedException, got ${r.status} ${r.text.slice(0, 120)}`;
  const signUp = (clientMetadata?: Record<string, string>): Probe => ({
    method: "POST",
    url: `https://cognito-idp.${o.region}.amazonaws.com/`,
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.SignUp" },
    // A password the pool's policy accepts, so it's the trigger that has to say no.
    body: JSON.stringify({ ClientId: o.clientId, Username: PROBE_USERNAME, Password: "Live-Check-Probe-2026", ...(clientMetadata ? { ClientMetadata: clientMetadata } : {}) }),
  });
  const refusedByTrigger = ([r]: ProbeReply[]) => {
    if (r.status === 200) return `SIGN-UP WENT THROUGH without an Invite: self sign-up is open. Delete user ${PROBE_USERNAME} and fix the trigger now`;
    return r.status === 400 && r.text.includes("UserLambdaValidationException") && r.text.includes("Sign-up failed")
      ? ""
      : `expected 400 UserLambdaValidationException "Sign-up failed", got ${r.status} ${r.text.slice(0, 120)}`;
  };

  return [
    { name: "API refuses anonymous calls", probes: [gql({})], verdict: unauthorized },
    { name: "API refuses a junk token", probes: [gql({ Authorization: "not-a-real-token" })], verdict: unauthorized },
    { name: "Sign-up without an Invite is refused by the pre-sign-up trigger", probes: [signUp()], verdict: refusedByTrigger },
    { name: "Sign-up with an unknown Invite is refused, generically", probes: [signUp({ inviteToken: UNKNOWN_INVITE })], verdict: refusedByTrigger },
    {
      name: "Bucket refuses direct reads",
      probes: [{ method: "GET", url: `https://${o.bucketName}.s3.${o.region}.amazonaws.com/index.html` }],
      verdict: ([r]) => (r.status === 403 ? "" : `expected 403 from S3, got ${r.status}`),
    },
    {
      name: "Site is public with strict security headers",
      probes: [{ method: "GET", url: `${site}/` }],
      verdict: ([r]) => {
        if (r.status !== 200) return `expected 200, got ${r.status}`;
        const h = (n: string) => r.headers.get(n) ?? "";
        const csp = h("content-security-policy");
        const missing = [
          !csp.includes("frame-ancestors 'none'") && "CSP frame-ancestors",
          !csp.includes("script-src 'self'") && "CSP script-src 'self'",
          !csp.includes(new URL(o.graphqlUrl).host) && "CSP API host",
          !csp.includes(`cognito-idp.${o.region}.amazonaws.com`) && "CSP Cognito host",
          (csp.includes("unsafe") || csp.includes("*")) && "CSP without unsafe-* or wildcards",
          !/max-age=\d{7,}/.test(h("strict-transport-security")) && "HSTS",
          h("x-frame-options") !== "DENY" && "X-Frame-Options DENY",
          h("x-content-type-options") !== "nosniff" && "nosniff",
          h("referrer-policy") !== "same-origin" && "Referrer-Policy same-origin",
          !h("permissions-policy").includes("camera=()") && "Permissions-Policy",
          h("cross-origin-opener-policy") !== "same-origin" && "COOP same-origin",
          !h("x-robots-tag").includes("noindex") && "X-Robots-Tag noindex",
        ].filter(Boolean);
        return missing.length ? `missing ${missing.join(", ")}` : "";
      },
    },
    {
      name: "Deep links load the app (SPA fallback), with the same headers",
      probes: [{ method: "GET", url: `${site}/invite` }],
      verdict: ([r]) =>
        r.status === 200 && r.text.includes("<div id=\"root\"") && (r.headers.get("content-security-policy") ?? "").includes("frame-ancestors")
          ? ""
          : `expected the app's index.html with headers, got ${r.status}`,
    },
    {
      name: "config.json points at this deploy",
      probes: [{ method: "GET", url: `${site}/config.json` }],
      verdict: ([r]) => {
        if (r.status !== 200) return `expected 200, got ${r.status}`;
        let c: Record<string, unknown>;
        try {
          c = JSON.parse(r.text);
        } catch {
          return "not JSON";
        }
        const want = { region: o.region, userPoolId: o.userPoolId, clientId: o.clientId, graphqlUrl: o.graphqlUrl };
        const off = Object.entries(want).filter(([k, v]) => c[k] !== v).map(([k]) => k);
        if (typeof c.vapidPublicKey !== "string" || !/^[A-Za-z0-9_-]{80,}$/.test(c.vapidPublicKey)) off.push("vapidPublicKey");
        return off.length ? `wrong ${off.join(", ")}` : "";
      },
    },
  ];
}

export async function runLiveChecks(outputs: LiveOutputs, fetcher: Fetcher): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of checks(outputs)) {
    try {
      const replies: ProbeReply[] = [];
      for (const p of c.probes) replies.push(await fetcher(p));
      const problem = c.verdict(replies);
      results.push({ name: c.name, ok: !problem, detail: problem || "ok" });
    } catch (e) {
      results.push({ name: c.name, ok: false, detail: `request failed: ${(e as Error).message}` });
    }
  }
  return results;
}
