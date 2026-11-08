/**
 * Deploy-time values that must not live in this public repo: the AWS account and the existing
 * Route 53 zone. Each comes from CDK context (`-c key=value`) or, failing that, an env var (what
 * CI sets from GitHub repo variables).
 *
 *   context        env                 what
 *   account        CDK_DEFAULT_ACCOUNT the AWS account (the CDK CLI sets the env var from your credentials)
 *   hostedZoneId   HOSTED_ZONE_ID      the existing public hosted zone, e.g. Z0123...
 *   zoneName       HOSTED_ZONE_NAME    that zone's name; the app domain must sit inside it
 *   requireHosting -                   "true" makes a missing zone an error (the CI deploy sets it)
 *
 * With no zone set, the hosting stacks are left out, so `npm run synth` works with no setup.
 */
export interface HostingConfig {
  account: string;
  hostedZoneId: string;
  zoneName: string;
}

type Context = (key: string) => unknown;
type Env = Record<string, string | undefined>;

export function readHostingConfig(context: Context, env: Env, appDomain: string): HostingConfig | undefined {
  const read = (key: string, envKey: string): string | undefined => {
    const v = context(key) ?? env[envKey];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const hostedZoneId = read("hostedZoneId", "HOSTED_ZONE_ID");
  const zoneName = read("zoneName", "HOSTED_ZONE_NAME")?.replace(/\.$/, "");
  const account = read("account", "CDK_DEFAULT_ACCOUNT");
  const required = context("requireHosting") === "true" || context("requireHosting") === true;

  if (!hostedZoneId && !zoneName && !required) return undefined;
  const missing = [
    !hostedZoneId && "hostedZoneId (env HOSTED_ZONE_ID)",
    !zoneName && "zoneName (env HOSTED_ZONE_NAME)",
    !account && "account (env CDK_DEFAULT_ACCOUNT)",
  ].filter(Boolean);
  if (missing.length) throw new Error(`Hosting config incomplete; set ${missing.join(", ")}`);

  if (!appDomain.endsWith(`.${zoneName}`) && appDomain !== zoneName) {
    throw new Error(`App domain ${appDomain} is not inside zone ${zoneName}`);
  }
  return { account: account!, hostedZoneId: hostedZoneId!, zoneName: zoneName! };
}
