import { CfnOutput, Duration, Stack, type StackProps, aws_iam as iam } from "aws-cdk-lib";
import type { Construct } from "constructs";

const GITHUB_OWNER = "asherShores5";
/** asherShores5's immutable GitHub owner ID (public). */
const GITHUB_OWNER_ID = "71547146";
/**
 * GitHub's OIDC `sub` for this owner's repos is the ID form, `repo:asherShores5@71547146/<name>@<repo id>:...`
 * (seen for HoneyDo, Games Catalog, App Connector and NutriSage deploys). The name-only form is trusted
 * too, in case GitHub sends it.
 */
export const GITHUB_REPO_NAME = "throne";
export const DEPLOY_BRANCH = "prod";
/** GitHub Environment the deploy job runs in: prod branch only, Asher as required reviewer (set in GitHub). */
export const DEPLOY_ENVIRONMENT = "production";
export const DEPLOY_ROLE_NAME = "throne-github-deploy";

interface CiStackProps extends StackProps {
  /** Numeric repo ID (`gh api repos/asherShores5/throne --jq .id`); GitHub Actions sets GITHUB_REPOSITORY_ID. */
  githubRepoId: string;
}

/**
 * GitHub Actions -> AWS via OIDC (no stored keys). Only jobs in this repo's `production`
 * Environment can assume the role, and the role can only assume the CDK bootstrap roles.
 *
 * The account's GitHub OIDC provider already exists (HoneyDo's CI stack created it, and an
 * account can have only one per URL), so this imports it rather than creating a second.
 */
export class CiStack extends Stack {
  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);
    const { githubRepoId } = props;
    if (!/^\d+$/.test(githubRepoId)) throw new Error(`githubRepoId must be the numeric GitHub repo ID, got "${githubRepoId}"`);

    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GitHub",
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );
    const subjects = [
      `repo:${GITHUB_OWNER}@${GITHUB_OWNER_ID}/${GITHUB_REPO_NAME}@${githubRepoId}:environment:${DEPLOY_ENVIRONMENT}`,
      `repo:${GITHUB_OWNER}/${GITHUB_REPO_NAME}:environment:${DEPLOY_ENVIRONMENT}`,
    ];

    const role = new iam.Role(this, "DeployRole", {
      roleName: DEPLOY_ROLE_NAME,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": subjects,
        },
      }),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`],
      }),
    );
    new CfnOutput(this, "DeployRoleArn", { value: role.roleArn });
  }
}
