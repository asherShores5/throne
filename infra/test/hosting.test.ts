import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "../lib/app";

// Placeholder values only: real IDs never go in this repo.
const HOSTING = { account: "111111111111", hostedZoneId: "Z0000000PLACEHOLDER", zoneName: "ashershores.com" };
const REPO_ID = "123456789";

let webDist: string;
let built: BuiltApp;
let app: Template, web: Template, cert: Template, ci: Template;
beforeAll(() => {
  webDist = mkdtempSync(path.join(tmpdir(), "throne-web-"));
  writeFileSync(path.join(webDist, "index.html"), "<!doctype html>");
  built = buildApp(new App(), { region: "us-west-1", hosting: HOSTING, githubRepoId: REPO_ID, webDist });
  app = Template.fromStack(built.app);
  web = Template.fromStack(built.web!);
  cert = Template.fromStack(built.cert!);
  ci = Template.fromStack(built.ci!);
}, 180_000);

const headersConfig = () => {
  const [policy] = Object.values(web.findResources("AWS::CloudFront::ResponseHeadersPolicy"));
  return policy.Properties.ResponseHeadersPolicyConfig;
};

describe("live at throne.ashershores.com", () => {
  it("issues the certificate in us-east-1, DNS-validated in the configured zone", () => {
    expect(built.cert!.region).toBe("us-east-1");
    cert.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "throne.ashershores.com",
      ValidationMethod: "DNS",
      DomainValidationOptions: [{ DomainName: "throne.ashershores.com", HostedZoneId: HOSTING.hostedZoneId }],
    });
  });

  it("CloudFront answers on the domain with that certificate; the API, site and CI live in us-west-1", () => {
    for (const s of [built.app, built.web!, built.ci!]) expect(s.region).toBe("us-west-1");
    web.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: ["throne.ashershores.com"],
        ViewerCertificate: Match.objectLike({ AcmCertificateArn: Match.anyValue(), SslSupportMethod: "sni-only" }),
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
      }),
    });
  });

  it("points the domain at CloudFront in the configured zone (A and AAAA)", () => {
    for (const Type of ["A", "AAAA"]) {
      web.hasResourceProperties("AWS::Route53::RecordSet", {
        HostedZoneId: HOSTING.hostedZoneId,
        Name: "throne.ashershores.com.",
        Type,
        AliasTarget: Match.objectLike({ DNSName: Match.anyValue() }),
      });
    }
  });
});

describe("private bucket behind CloudFront", () => {
  it("blocks all public access, and only CloudFront (via OAC) may read it", () => {
    web.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    web.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    web.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Origins: [Match.objectLike({ OriginAccessControlId: Match.anyValue(), S3OriginConfig: { OriginAccessIdentity: "" } })],
      }),
    });
  });

  it("no bucket policy statement allows an anonymous or unconditioned CloudFront principal", () => {
    const policies = Object.values(web.findResources("AWS::S3::BucketPolicy"));
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) {
      for (const s of p.Properties.PolicyDocument.Statement) {
        if (s.Effect !== "Allow") continue;
        expect(s.Principal).not.toBe("*");
        expect(JSON.stringify(s.Principal)).not.toContain('"AWS":"*"');
        if (s.Principal?.Service === "cloudfront.amazonaws.com") expect(s.Condition?.StringEquals?.["AWS:SourceArn"]).toBeDefined();
      }
    }
  });

  it("writes config.json with the sign-in and API values from the app stack", () => {
    const [deploy] = Object.values(web.findResources("Custom::CDKBucketDeployment"));
    const markers = JSON.stringify(deploy.Properties.SourceMarkers);
    for (const output of ["RefUsers", "RefUsersWeb", "GraphQLUrl"]) expect(markers).toContain(output);
  });

  it("refuses to build without a web build, instead of deploying an empty site", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "throne-empty-"));
    expect(() => buildApp(new App(), { region: "us-west-1", hosting: HOSTING, githubRepoId: REPO_ID, webDist: empty })).toThrow(/build:web/);
  });
});

describe("browser security headers", () => {
  it("sends the csp module's policy, with this app's own API (not a wildcard)", () => {
    const csp = JSON.stringify(headersConfig().SecurityHeadersConfig.ContentSecurityPolicy);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("https://cognito-idp.us-west-1.amazonaws.com");
    expect(csp).toMatch(/GraphQLUrl/);
    expect(csp).not.toContain("*.");
  });

  it("HSTS, nosniff, no framing, same-origin referrer and opener, and no camera/mic/location", () => {
    const h = headersConfig();
    expect(h.SecurityHeadersConfig).toMatchObject({
      StrictTransportSecurity: { AccessControlMaxAgeSec: 31536000, Override: true },
      ContentTypeOptions: { Override: true },
      FrameOptions: { FrameOption: "DENY", Override: true },
      ReferrerPolicy: { ReferrerPolicy: "same-origin", Override: true },
    });
    const custom = Object.fromEntries(h.CustomHeadersConfig.Items.map((i: any) => [i.Header, i.Value]));
    expect(custom["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(custom["Permissions-Policy"]).toContain("camera=()");
    // Passkeys (Face ID) need WebAuthn on this origin, so it's never switched off.
    expect(custom["Permissions-Policy"]).not.toContain("publickey-credentials");
  });

  it("asks search engines not to index the site", () => {
    const custom = Object.fromEntries(headersConfig().CustomHeadersConfig.Items.map((i: any) => [i.Header, i.Value]));
    expect(custom["X-Robots-Tag"]).toBe("noindex, nofollow");
  });
});

describe("deploy role (GitHub OIDC)", () => {
  it("imports the account's existing GitHub OIDC provider instead of creating one", () => {
    ci.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
    ci.resourceCountIs("AWS::IAM::OIDCProvider", 0);
  });

  it("only jobs in this repo's production environment can assume it", () => {
    const [role] = Object.values(ci.findResources("AWS::IAM::Role"));
    const [statement] = role.Properties.AssumeRolePolicyDocument.Statement;
    expect(statement.Action).toBe("sts:AssumeRoleWithWebIdentity");
    expect(JSON.stringify(statement.Principal)).toContain("oidc-provider/token.actions.githubusercontent.com");
    expect(statement.Condition.StringEquals["token.actions.githubusercontent.com:aud"]).toBe("sts.amazonaws.com");
    expect([...statement.Condition.StringEquals["token.actions.githubusercontent.com:sub"]].sort()).toEqual([
      "repo:asherShores5/throne:environment:production",
      `repo:asherShores5@71547146/throne@${REPO_ID}:environment:production`,
    ]);
    expect(statement.Condition.StringLike).toBeUndefined();
    ci.hasResourceProperties("AWS::IAM::Role", { RoleName: "throne-github-deploy", MaxSessionDuration: 3600 });
  });

  it("can only assume the CDK bootstrap roles", () => {
    const [policy] = Object.values(ci.findResources("AWS::IAM::Policy"));
    expect(policy.Properties.PolicyDocument.Statement).toEqual([
      { Action: "sts:AssumeRole", Effect: "Allow", Resource: `arn:aws:iam::${HOSTING.account}:role/cdk-hnb659fds-*` },
    ]);
  });

  it("won't build the role without the numeric repo ID, so the first deploy can't trust the wrong subject", () => {
    expect(() => buildApp(new App(), { region: "us-west-1", hosting: HOSTING, webDist })).toThrow(/githubRepoId/);
    expect(() => buildApp(new App(), { region: "us-west-1", hosting: HOSTING, githubRepoId: "throne", webDist })).toThrow(/numeric/);
  });
});

describe("budget", () => {
  it("$1 a month on the app=throne cost tag, emailing at 80% actual and 100% forecast", () => {
    app.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: {
        BudgetName: "throne-monthly",
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
        BudgetLimit: { Amount: 1, Unit: "USD" },
        CostFilters: { TagKeyValue: ["user:app$throne"] },
      },
      NotificationsWithSubscribers: [
        Match.objectLike({ Notification: { NotificationType: "ACTUAL", ComparisonOperator: "GREATER_THAN", Threshold: 80 } }),
        Match.objectLike({ Notification: { NotificationType: "FORECASTED", ComparisonOperator: "GREATER_THAN", Threshold: 100 } }),
      ],
    });
  });

  it("every stack carries the app=throne tag the budget filters on", () => {
    const tag = { Tags: Match.arrayWith([{ Key: "app", Value: "throne" }]) };
    web.hasResourceProperties("AWS::S3::Bucket", tag);
    cert.hasResourceProperties("AWS::CertificateManager::Certificate", tag);
    ci.hasResourceProperties("AWS::IAM::Role", tag);
    app.hasResourceProperties("AWS::Cognito::UserPool", { UserPoolTags: { app: "throne" } });
    app.hasResourceProperties("AWS::DynamoDB::GlobalTable", { Replicas: [Match.objectLike({ Tags: Match.arrayWith([{ Key: "app", Value: "throne" }]) })] });
  });
});

describe("public repo hygiene", () => {
  it("no account ID other than the test placeholder ends up in any template", () => {
    for (const t of [app, web, cert, ci]) {
      const ids = JSON.stringify(t.toJSON()).match(/\b\d{12}\b/g) ?? [];
      expect(ids.filter((id) => id !== HOSTING.account)).toEqual([]);
    }
  });
});
