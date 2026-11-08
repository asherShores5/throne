import { App } from "aws-cdk-lib";
import { buildApp } from "../lib/app";
import { readHostingConfig } from "../lib/config";
import { APP_DOMAIN } from "../lib/stacks";

// No account or zone IDs in this repo: they come from CDK context or env (lib/config.ts).
// With no zone set, only the app stack synths.
// Region: `-c region=...`, else us-west-1. The dev desktop sets AWS_REGION=us-west-2 globally, so
// this deliberately does not read it.
const app = new App();
buildApp(app, {
  region: app.node.tryGetContext("region") ?? "us-west-1",
  hosting: readHostingConfig((k) => app.node.tryGetContext(k), process.env, APP_DOMAIN),
  // GitHub Actions sets GITHUB_REPOSITORY_ID; locally pass `-c githubRepoId=...`.
  githubRepoId: (app.node.tryGetContext("githubRepoId") ?? process.env.GITHUB_REPOSITORY_ID) || undefined,
});
