import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../lib/csp";

const csp = contentSecurityPolicy({ region: "us-west-1", graphqlHost: "abc123.appsync-api.us-west-1.amazonaws.com" });
const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `));

describe("content security policy", () => {
  it("the page may only talk to itself, its own API and Cognito sign-in", () => {
    expect(directive("connect-src")).toBe(
      "connect-src 'self' https://abc123.appsync-api.us-west-1.amazonaws.com https://cognito-idp.us-west-1.amazonaws.com",
    );
  });

  it("runs no inline or third-party script or style, and loads nothing else from other origins", () => {
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("script-src")).toBe("script-src 'self'");
    expect(directive("style-src")).toBe("style-src 'self'");
    expect(csp).not.toContain("unsafe");
    const others = csp.split("; ").filter((d) => !d.startsWith("connect-src ") && /https?:|wss:|\*/.test(d));
    expect(others).toEqual([]);
  });

  it("can't be framed and blocks plugins, base-tag and form hijacks", () => {
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) expect(csp).toContain(d);
  });
});
