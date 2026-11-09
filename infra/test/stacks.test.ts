import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { QUERY_DEPTH_LIMIT, composeSchemaDir, queryDepth, rootFields } from "../../schema/compose";
import { buildApp } from "../lib/app";

// One synth for the whole file: bundling the API Lambda with esbuild is the slow part.
let app: Template;
const preSignUpId = () => {
  const ids = Object.keys(app.findResources("AWS::Lambda::Function")).filter((id) => id.startsWith("PreSignUpFn"));
  expect(ids).toHaveLength(1);
  return ids[0];
};
beforeAll(() => {
  app = Template.fromStack(buildApp(new App(), { region: "us-west-1" }).app);
}, 120_000);

describe("data", () => {
  it("one PK/SK table, on demand, with point-in-time recovery, deletion protection and RETAIN", () => {
    app.resourceCountIs("AWS::DynamoDB::GlobalTable", 1);
    app.hasResource("AWS::DynamoDB::GlobalTable", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }, { AttributeName: "SK", KeyType: "RANGE" }],
        BillingMode: "PAY_PER_REQUEST",
        Replicas: [Match.objectLike({
          DeletionProtectionEnabled: true,
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        })],
      }),
    });
  });

  it("the API Lambda gets only single-item and query actions on the table (no Scan, no Batch*)", () => {
    const [roleId] = Object.keys(app.findResources("AWS::IAM::Role")).filter((id) => id.startsWith("ApiFn"));
    const statements = Object.values(app.findResources("AWS::IAM::Policy"))
      .filter((p: any) => JSON.stringify(p.Properties.Roles).includes(roleId))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .filter((st: any) => [st.Action].flat().some((a: string) => a.startsWith("dynamodb:")));
    expect(statements).toHaveLength(1);
    expect([statements[0].Action].flat().sort()).toEqual(["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"]);
    const [tableId] = Object.keys(app.findResources("AWS::DynamoDB::GlobalTable"));
    expect(statements[0].Resource).toEqual({ "Fn::GetAtt": [tableId, "Arn"] });
  });

  it("one Lambda handler for the API and one pre-sign-up trigger (plus CDK's own helpers, if any)", () => {
    const fns = Object.entries(app.findResources("AWS::Lambda::Function")).filter(([, f]) => f.Properties.Environment?.Variables?.TABLE_NAME);
    expect(fns.map(([id]) => id.replace(/[0-9A-F]{8}$/, "")).sort()).toEqual(["ApiFn", "PreSignUpFn"]);
    for (const [, f] of fns) {
      expect(f.Properties.Runtime).toBe("nodejs22.x");
      expect(f.Properties.Architectures).toEqual(["arm64"]);
    }
  });
});

describe("auth", () => {
  it("self sign-up is on only together with the Invite pre-sign-up trigger; password and passkey sign-in", () => {
    // Self sign-up without the trigger would let anyone make a Profile: assert both in one place.
    const [pool] = Object.values(app.findResources("AWS::Cognito::UserPool"));
    expect(pool.Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly).toBe(false);
    const trigger = pool.Properties.LambdaConfig?.PreSignUp;
    expect(trigger).toEqual({ "Fn::GetAtt": [preSignUpId(), "Arn"] });
    expect(pool.Properties.UserPoolTier).toBe("ESSENTIALS");
    expect([...pool.Properties.Policies.SignInPolicy.AllowedFirstAuthFactors].sort()).toEqual(["PASSWORD", "WEB_AUTHN"]);
    expect(pool.Properties.WebAuthnRelyingPartyID).toBe("throne.ashershores.com");
    expect(pool.Properties.WebAuthnUserVerification).toBe("required");
    expect(pool.Properties.Policies.PasswordPolicy.MinimumLength).toBeGreaterThanOrEqual(16);
    // Nothing to confirm by email or phone: the Invite is the proof (the trigger auto-confirms).
    expect(pool.Properties.AutoVerifiedAttributes ?? []).toEqual([]);
  });

  it("the pre-sign-up trigger runs the Invite check with only the table name and only UpdateItem on the table", () => {
    const fn = app.findResources("AWS::Lambda::Function")[preSignUpId()];
    expect(Object.keys(fn.Properties.Environment.Variables)).toEqual(["TABLE_NAME"]);
    expect(fn.Properties.Handler).toMatch(/handler$/);
    const roleId = fn.Properties.Role["Fn::GetAtt"][0];
    const statements = Object.values(app.findResources("AWS::IAM::Policy"))
      .filter((p: any) => JSON.stringify(p.Properties.Roles).includes(roleId))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    expect(statements.map((st: any) => st.Action)).toEqual(["dynamodb:UpdateItem"]);
    const [tableId] = Object.keys(app.findResources("AWS::DynamoDB::GlobalTable"));
    expect(statements[0].Resource).toEqual({ "Fn::GetAtt": [tableId, "Arn"] });
    // Only this pool may invoke it.
    app.hasResourceProperties("AWS::Lambda::Permission", {
      FunctionName: { "Fn::GetAtt": [preSignUpId(), "Arn"] },
      Principal: "cognito-idp.amazonaws.com",
      SourceArn: { "Fn::GetAtt": [Object.keys(app.findResources("AWS::Cognito::UserPool"))[0], "Arn"] },
    });
  });

  it("the web client signs in through USER_AUTH (password or passkey) and refresh only", () => {
    const [client] = Object.values(app.findResources("AWS::Cognito::UserPoolClient"));
    expect([...client.Properties.ExplicitAuthFlows].sort()).toEqual(["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_AUTH"]);
    expect(client.Properties.PreventUserExistenceErrors).toBe("ENABLED");
  });

  it("tokens last an hour and the session (refresh token) 7 days", () => {
    app.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
      RefreshTokenValidity: 7 * 24 * 60,
    });
  });

  it("the API takes Cognito user-pool tokens only (no API key, no IAM, no other provider)", () => {
    app.hasResourceProperties("AWS::AppSync::GraphQLApi", {
      AuthenticationType: "AMAZON_COGNITO_USER_POOLS",
      AdditionalAuthenticationProviders: Match.absent(),
    });
    app.resourceCountIs("AWS::AppSync::ApiKey", 0);
  });
});

describe("API", () => {
  it("doesn't describe itself and caps query depth and resolvers per request", () => {
    app.hasResourceProperties("AWS::AppSync::GraphQLApi", { IntrospectionConfig: "DISABLED" });
    const [api] = Object.values(app.findResources("AWS::AppSync::GraphQLApi"));
    expect(api.Properties.QueryDepthLimit).toBe(QUERY_DEPTH_LIMIT);
    expect(api.Properties.ResolverCountLimit).toBeLessThanOrEqual(5);
  });

  it("counts query depth the way AppSync does (root field = 1)", () => {
    expect(queryDepth("query { me { id } }")).toBe(2);
    expect(queryDepth("query { a { ... on X { b { c } } } }")).toBe(3);
    expect(queryDepth("query Q { me { ...P } } fragment P on Profile { avatar { emoji } }")).toBe(3);
  });

  it("the depth cap is exactly the deepest selection the app sends (the Profile's Avatar)", () => {
    // web/src/api/profile.ts selects `me { ... avatar { emoji color } }`; e2e/backend.ts refuses anything
    // deeper than the cap, as AppSync does. Raise the cap when a real selection needs it, never "just in case".
    expect(queryDepth("query Me($z: String) { me(homeZone: $z) { id displayName homeZone avatar { emoji color } } }")).toBe(QUERY_DEPTH_LIMIT);
  });

  it("has a Lambda resolver for every Query and Mutation field in schema/", () => {
    const fields = rootFields(composeSchemaDir());
    const wired = Object.values(app.findResources("AWS::AppSync::Resolver")).map((r) => `${r.Properties.TypeName}.${r.Properties.FieldName}`);
    const expected = [...fields.Query.map((f) => `Query.${f}`), ...fields.Mutation.map((f) => `Mutation.${f}`)];
    expect(wired.sort()).toEqual(expected.sort());
  });

  it("logs errors only, without request or response content (health data)", () => {
    app.hasResourceProperties("AWS::AppSync::GraphQLApi", {
      LogConfig: Match.objectLike({ FieldLogLevel: "ERROR", ExcludeVerboseContent: true }),
    });
  });
});

describe("public repo hygiene", () => {
  it("synths with no AWS account ID in the template", () => {
    expect(JSON.stringify(app.toJSON())).not.toMatch(/\b\d{12}\b/);
  });
});
