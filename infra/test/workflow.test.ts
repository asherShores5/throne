import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DEPLOY_BRANCH, DEPLOY_ENVIRONMENT, DEPLOY_ROLE_NAME } from "../lib/ci";

const ROOT = path.join(__dirname, "..", "..");
const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
const deployJob = workflow.slice(workflow.indexOf("\n  deploy:"));

describe("CI workflow", () => {
  it("assumes the role CiStack creates, with the account from a secret (never a literal ID)", () => {
    expect(deployJob).toContain(`role-to-assume: arn:aws:iam::\${{ secrets.AWS_ACCOUNT_ID }}:role/${DEPLOY_ROLE_NAME}`);
    expect(deployJob).toContain("mask-aws-account-id: true");
    expect(workflow).not.toMatch(/\b\d{12}\b/);
  });

  it("deploys only on pushes to prod, inside the production environment (Asher's approval)", () => {
    expect(deployJob).toContain(`if: github.event_name == 'push' && github.ref == 'refs/heads/${DEPLOY_BRANCH}'`);
    expect(deployJob).toContain(`environment: ${DEPLOY_ENVIRONMENT}`);
    expect(deployJob).toContain("id-token: write");
    // Only the deploy job gets an OIDC token.
    expect(workflow.slice(0, workflow.indexOf("\n  deploy:"))).not.toContain("id-token");
  });

  it("runs tests, typecheck, the web build and synth on PRs and before any deploy", () => {
    expect(workflow).toMatch(/on:\n\s+push:\n\s+branches: \[main, prod\]\n\s+pull_request:/);
    for (const step of ["npm ci", "npm test", "npm run typecheck", "npm run build:web", "npm run synth"]) expect(workflow).toContain(`- run: ${step}`);
    expect(deployJob).toContain("needs: test");
    expect(deployJob).toContain("- run: npm run deploy");
  });

  it("pins every action to a full commit SHA and doesn't leave the git token on disk", () => {
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    const checkouts = workflow.match(/uses: actions\/checkout@/g)!.length;
    expect(workflow.match(/persist-credentials: false/g)?.length).toBe(checkouts);
  });

  it("the token can only read the repo by default", () => {
    expect(workflow).toMatch(/\npermissions:\n\s+contents: read\n/);
  });
});

describe("Dependabot", () => {
  it("watches GitHub Actions and npm", () => {
    const file = path.join(ROOT, ".github", "dependabot.yml");
    expect(existsSync(file)).toBe(true);
    const config = readFileSync(file, "utf8");
    expect(config).toContain("package-ecosystem: github-actions");
    expect(config).toContain("package-ecosystem: npm");
  });
});
