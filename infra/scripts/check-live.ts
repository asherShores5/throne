// Runs the post-deploy release checks (scripts/liveChecks.ts) against the live deploy, as an
// anonymous client. Exits 1 if any check fails: then stop, fix, and don't share the app or send Invites.
// Usage (from infra/, after a deploy with `--outputs-file cdk-outputs.json`):
//   npx tsx scripts/check-live.ts [cdk-outputs.json]
import { readFileSync } from "node:fs";
import { type LiveOutputs, runLiveChecks } from "./liveChecks";

const file = process.argv[2] ?? "cdk-outputs.json";
const stacks = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string>>;
const app = stacks.Throne ?? {};
const web = stacks.ThroneWeb ?? {};
const outputs: LiveOutputs = {
  region: app.Region,
  siteUrl: web.Url,
  graphqlUrl: app.GraphqlUrl,
  userPoolId: app.UserPoolId,
  clientId: app.ClientId,
  bucketName: web.BucketName,
};
const missing = Object.entries(outputs).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`${file} is missing ${missing.join(", ")}; deploy with --outputs-file ${file}`);
  process.exit(1);
}

runLiveChecks(outputs, async (p) => {
  // redirect: "manual" so a redirect is judged as itself, never followed to something that answers 200.
  const r = await fetch(p.url, { method: p.method, headers: p.headers, body: p.body, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  return { status: r.status, headers: r.headers, text: await r.text() };
}).then((results) => {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `: ${r.detail}`}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} check(s) FAILED: stop and fix before sending any Invite.` : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
});
