import { existsSync } from "node:fs";
import * as path from "node:path";
import { Tags, type App } from "aws-cdk-lib";
import { CiStack } from "./ci";
import type { HostingConfig } from "./config";
import { CertStack, WebStack } from "./hosting";
import { APP_DOMAIN, AppStack } from "./stacks";

export interface AppOptions {
  region: string;
  /** Without it, only the app stack is built (account from CDK_DEFAULT_ACCOUNT, or env-agnostic). */
  hosting?: HostingConfig;
  /** Numeric GitHub repo ID; required with hosting (the deploy role trusts it). */
  githubRepoId?: string;
  /** The built web app; defaults to web/dist. */
  webDist?: string;
}

export interface BuiltApp {
  app: AppStack;
  cert?: CertStack;
  web?: WebStack;
  ci?: CiStack;
}

/**
 * Every stack, wired together. No account or zone ID lives in this repo: they come from CDK
 * context or env (lib/config.ts). Every resource is tagged app=throne, the cost tag the budget
 * filters on.
 */
export function buildApp(scope: App, opts: AppOptions): BuiltApp {
  Tags.of(scope).add("app", "throne");
  const { region, hosting } = opts;
  if (!hosting) {
    return { app: new AppStack(scope, "Throne", { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region } }) };
  }

  if (!opts.githubRepoId) throw new Error("githubRepoId is required with hosting (-c githubRepoId=..., or GITHUB_REPOSITORY_ID in CI)");
  const webDist = opts.webDist ?? path.join(__dirname, "..", "..", "web", "dist");
  if (!existsSync(path.join(webDist, "index.html"))) {
    throw new Error(`No web build at ${webDist}; run \`npm run build:web\` first`);
  }
  const { account } = hosting;
  const zone = { hosting, domain: APP_DOMAIN };

  const app = new AppStack(scope, "Throne", { env: { account, region } });
  const cert = new CertStack(scope, "ThroneCert", { env: { account, region: "us-east-1" }, crossRegionReferences: true, ...zone });
  const web = new WebStack(scope, "ThroneWeb", {
    env: { account, region },
    crossRegionReferences: true,
    ...zone,
    certificate: cert.certificate,
    app,
    webDist,
  });
  const ci = new CiStack(scope, "ThroneCi", { env: { account, region }, githubRepoId: opts.githubRepoId });
  return { app, cert, web, ci };
}
