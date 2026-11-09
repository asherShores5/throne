// DynamoDB IAM, both directions, against api/src/dynamoAccess.ts:
//  - missing grant: the fake table (api/src/testing/fakeDynamo.ts) refuses, per running Lambda, any action
//    outside the list, so a code path that needs one fails its own test; here, the stack must grant exactly
//    the list (nothing the fake allowed may be missing live);
//  - extra grant: each listed action must really occur in that Lambda's bundle (the same esbuild bundle the
//    stack deploys, AWS SDK left out as the stack does), so an action no code uses can't stay granted.
import * as path from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { buildSync } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { ACTION_OF, DYNAMO_ACCESS, type LambdaName } from "../../api/src/dynamoAccess";
import { buildApp } from "../lib/app";

const ROOT = path.join(__dirname, "..", "..");
const LAMBDAS: Record<LambdaName, { id: string; entry: string }> = {
  api: { id: "ApiFn", entry: "handler.ts" },
  notifier: { id: "NotifierFn", entry: "notifier.ts" },
  preSignUp: { id: "PreSignUpFn", entry: "preSignUp.ts" },
};

let app: Template;
beforeAll(() => {
  app = Template.fromStack(buildApp(new App(), { region: "us-west-1" }).app);
}, 120_000);

const fnIdOf = (prefix: string) => {
  const ids = Object.keys(app.findResources("AWS::Lambda::Function")).filter((id) => id.startsWith(prefix));
  expect(ids).toHaveLength(1);
  return ids[0];
};
const dynamoActionsOfRole = (roleId: string) =>
  Object.values(app.findResources("AWS::IAM::Policy"))
    .filter((p: any) => JSON.stringify(p.Properties.Roles).includes(roleId))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
    .flatMap((st: any) => [st.Action].flat() as string[])
    .filter((a) => a.startsWith("dynamodb:"));

/** The DynamoDB actions a Lambda's bundled code can perform: each command it builds, each transaction item kind. */
function actionsInBundle(entry: string): string[] {
  const out = buildSync({
    entryPoints: [path.join(ROOT, "api", "src", entry)],
    bundle: true, write: false, platform: "node", format: "esm", target: "node22",
    external: ["@aws-sdk/*"], absWorkingDir: ROOT, logLevel: "silent",
  }).outputFiles[0].text;
  const found = new Set<string>();
  for (const m of out.matchAll(/new (Get|Put|Update|Delete|Query|Scan|BatchGet|BatchWrite|TransactWrite|TransactGet)Command\d*\(/g)) {
    if (m[1] === "TransactWrite" || m[1] === "TransactGet") continue;
    found.add(ACTION_OF[`${m[1]}Command`]);
  }
  if (/new TransactWriteCommand\d*\(/.test(out)) {
    // Transaction items: `{ Put: { TableName ... } }` and the like, as the resolvers write them.
    for (const m of out.matchAll(/\b(Put|Update|Delete|ConditionCheck):\s*\{/g)) found.add(ACTION_OF[m[1]]);
  }
  if (/new TransactGetCommand\d*\(/.test(out)) found.add("GetItem");
  return [...found].sort();
}

describe("DynamoDB IAM matches api/src/dynamoAccess.ts", () => {
  for (const [name, { id, entry }] of Object.entries(LAMBDAS) as [LambdaName, { id: string; entry: string }][]) {
    it(`${name}: the stack grants exactly the listed actions`, () => {
      const fn = app.findResources("AWS::Lambda::Function")[fnIdOf(id)];
      const granted = dynamoActionsOfRole(fn.Properties.Role["Fn::GetAtt"][0]).sort();
      expect(granted).toEqual(DYNAMO_ACCESS[name].map((a) => `dynamodb:${a}`).sort());
    });

    it(`${name}: every listed action is used by its bundled code, and its code uses nothing unlisted`, () => {
      expect(actionsInBundle(entry)).toEqual([...DYNAMO_ACCESS[name]].sort());
    });
  }

  it("no other Lambda (CDK helpers, the VAPID key provider) has any DynamoDB action", () => {
    const listed = new Set(Object.values(LAMBDAS).map(({ id }) => fnIdOf(id)));
    const others = Object.entries(app.findResources("AWS::Lambda::Function")).filter(([fid]) => !listed.has(fid));
    expect(others.length).toBeGreaterThan(0);
    for (const [, f] of others) {
      const role = f.Properties.Role?.["Fn::GetAtt"]?.[0];
      if (role) expect(dynamoActionsOfRole(role)).toEqual([]);
    }
  });
});
