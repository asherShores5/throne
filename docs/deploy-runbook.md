# Deploy runbook (first deploy, then CI)

Human steps only: every step here is a live change or a GitHub setting, so Asher runs it (or says
go). After the first deploy, a push to `prod` deploys through GitHub Actions once Asher approves
the run. Nothing below goes in a tracked file: the account ID and zone ID are env vars or GitHub
settings. Structure copied from NutriSage's runbook.

What gets created (all us-west-1 except the certificate):

```
Throne       table, Cognito user pool (no users yet; self sign-up only through the Invite
             pre-sign-up trigger), API (AppSync + Lambda), Notifier Lambda + hourly schedule,
             VAPID keys in SSM (created once, never overwritten), $1/month budget
ThroneCert   us-east-1 certificate for throne.ashershores.com (DNS-validated)
ThroneWeb    private S3 bucket, CloudFront (the only reader, via OAC), CSP/headers, A/AAAA records
ThroneCi     throne-github-deploy role: trusts only the `throne` repo's `production` environment
```

## Release rule (builder-security)

The static shell is public by design (the sign-in and Invite pages have no data). Profiles and
Logs are the restricted content, and they only exist once someone signs up. So the order is fixed:

1. Deploy with an empty table and a user pool with no users.
2. Run the anonymous checks (step 5). Every one must PASS: the API refuses anonymous and
   junk-token calls, a sign-up without a real Invite is refused by the trigger, the bucket
   refuses direct reads, the site has its headers.
3. Only then create the first Profile (step 7) and send Invites.

If any check fails, stop. Don't create users or send Invites until it's fixed and re-checked.

## 1. Shell setup and values

From the repo root, in the VS Code terminal on the dev desktop:

```sh
aws login --remote --region us-west-1 --profile personal    # if `aws sts get-caller-identity` fails
export AWS_PROFILE=personal AWS_REGION=us-west-1 AWS_DEFAULT_REGION=us-west-1   # the desktop defaults to us-west-2
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export HOSTED_ZONE_NAME=ashershores.com
export HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$HOSTED_ZONE_NAME" \
  --max-items 1 --query 'HostedZones[0].Id' --output text | sed 's#/hostedzone/##')
export REPO_ID=$(gh api repos/asherShores5/throne --jq .id)   # the repo must be named `throne` (infra/lib/ci.ts)
echo "zone=$HOSTED_ZONE_ID repo=$REPO_ID"
```

## 2. Bootstrap and OIDC provider check

```sh
for r in us-west-1 us-east-1; do
  aws cloudformation describe-stacks --region $r --stack-name CDKToolkit \
    --query 'Stacks[0].[StackStatus,Outputs[?OutputKey==`BootstrapVersion`].OutputValue|[0]]' --output text
done
aws iam list-open-id-connect-providers   # expect .../oidc-provider/token.actions.githubusercontent.com
```

ThroneCi imports the existing GitHub OIDC provider (Honey Do's CI stack owns it) and never creates one.

## 3. Pre-flight (no changes)

```sh
npm ci && npm test && npm run typecheck && npm run build:web
AWS_REGION=us-west-1 AWS_DEFAULT_REGION=us-west-1 npm run synth
(cd infra && npx cdk diff --all -c requireHosting=true -c githubRepoId="$REPO_ID")
aws route53 list-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
  --query "ResourceRecordSets[?contains(Name,'throne')].[Name,Type]" --output text   # expect nothing
```

Expect four new stacks and no `[-]` or `replace` lines. For later changes to existing stacks, make a
no-execute change set, check it for `Replacement`, then delete it:

```sh
(cd infra && npx cdk deploy Throne --no-execute -c requireHosting=true -c githubRepoId="$REPO_ID")
aws cloudformation describe-change-set --stack-name Throne --change-set-name <name from the output> \
  --query 'Changes[].ResourceChange.[Action,LogicalResourceId,Replacement]' --output text
aws cloudformation delete-change-set --stack-name Throne --change-set-name <name>
```

## 4. First deploy (from the dev desktop; it creates the role CI needs)

Asher's go needed. CDK shows the IAM changes and asks before each stack; read them.

```sh
(cd infra && npx cdk deploy --all -c requireHosting=true -c githubRepoId="$REPO_ID" --outputs-file cdk-outputs.json)
```

`cdk-outputs.json` is gitignored. It holds `UserPoolId`, `ClientId`, `GraphqlUrl` (Throne), `Url`,
`BucketName`, `DistributionId` (ThroneWeb) and `DeployRoleArn` (ThroneCi).

## 5. Anonymous checks (before any user exists)

```sh
(cd infra && npx tsx scripts/check-live.ts cdk-outputs.json)
```

It runs as an anonymous client (`infra/scripts/liveChecks.ts`, unit-tested in
`infra/test/liveChecks.test.ts`) and prints PASS/FAIL per check; exit 1 means stop:

```
API refuses anonymous calls                         401 UnauthorizedException
API refuses a junk token                            401 UnauthorizedException
Sign-up without an Invite is refused by the trigger 400 UserLambdaValidationException "Sign-up failed"
Sign-up with an unknown Invite is refused           same generic refusal (no hint whether a token exists)
Bucket refuses direct reads                         403 from S3 (only CloudFront can read it)
Site is public with strict security headers         200; CSP (own API + Cognito hosts, no unsafe-*/wildcards),
                                                    HSTS, DENY, nosniff, Referrer-Policy, Permissions-Policy,
                                                    COOP, X-Robots-Tag noindex
Deep links load the app                             /invite answers index.html with the same headers
config.json points at this deploy                   region, pool, client, API URL match; VAPID public key present
```

If a sign-up check FAILS because the sign-up went through, self sign-up is open: delete the user it
names (`live-check-probe`) at once and fix the trigger before anything else.
A CloudFront distribution can take a few minutes to answer on the domain; re-run if only the site
checks fail right after the deploy.

## 6. GitHub settings for CI (Asher, in github.com > repo Settings)

1. Environments > `production`: deployment branches `prod` only; required reviewer asherShores5;
   secret `AWS_ACCOUNT_ID`; variables `HOSTED_ZONE_ID`, `HOSTED_ZONE_NAME` (`ashershores.com`):

   ```sh
   gh secret set AWS_ACCOUNT_ID --env production --body "$CDK_DEFAULT_ACCOUNT"
   gh variable set HOSTED_ZONE_ID --env production --body "$HOSTED_ZONE_ID"
   gh variable set HOSTED_ZONE_NAME --env production --body "$HOSTED_ZONE_NAME"
   ```
2. Branches: create `prod` from `main`. Protect `main` and `prod` (no force pushes, no deletion;
   `main` requires a PR and the `test` check). An unprotected deploy branch is AWS admin through OIDC.
3. Actions > General: workflow permissions "Read repository contents".
4. Security: secret scanning + push protection, Dependabot alerts on.

If the first CI deploy fails with "Not authorized to perform sts:AssumeRoleWithWebIdentity", GitHub
sent a different subject: find it in CloudTrail (`AssumeRoleWithWebIdentity`, `userIdentity.userName`)
and stop.

## 7. The first Profile (only after step 5 passes)

The first Profile has no Invite to use, so it's made as an admin (the trigger lets `AdminCreateUser`
through; nobody can do that without IAM). Put a 16+ character password (upper, lower, digit) in a
600-permission file first, so it's never on screen or in shell history:

```sh
POOL=$(jq -r .Throne.UserPoolId infra/cdk-outputs.json)
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username asher --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username asher --permanent \
  --password "file://$HOME/.throne-first-password"   # then: rm ~/.throne-first-password
```

Then on the iPhone in Safari: sign in at https://throne.ashershores.com, Settings > add a passkey
(Face ID), sign out, sign in with the passkey, Add to Home Screen, sign in there too. Make an Invite
and send it to the first Friend.

## 8. Deploy from CI

Push `main` (tests only), then a PR `main` -> `prod`. The `prod` push runs the tests, then the deploy
job waits in `production` until Asher clicks Review deployments > Approve (never Claude). Then confirm
the live site serves the bundle you built:

```sh
npm run build:web
ls web/dist/assets/index-*.js
curl -s https://throne.ashershores.com/ | grep -o 'assets/index-[^"]*\.js'
```

Re-run step 5 after any infra change.

## 9. Post-deploy checks (live only; nothing offline can settle these)

Run after the first deploy and after any change to sign-up, Cognito or push. Each says what to do if
it fails.

1. **Taken username vs the Invite (ticket 12).** AWS doesn't document whether Cognito refuses a taken
   username before or after the pre-sign-up trigger. The trigger checks itself (AdminGetUser, after
   checking the Invite is open) so a clash can't spend the Invite either way. Check: with an open
   Invite, sign up on /invite as `asher` (taken). Expect "That username is taken. Pick another." and
   the Invite still listed under Settings > Invites; then the same link with a new username works.
   If the page says the Invite can't be used instead, read the PreSignUp log group: an
   `AccessDeniedException` on AdminGetUser means the `PreSignUpUserLookup` policy is missing.
2. **Trigger permissions on the first deploy.** The lookup policy is separate from the trigger (no
   CDK cycle), so a sign-up in the first seconds of the very first deploy could get "Sign-up couldn't
   finish. Try again"; the Invite stays open. Nothing to do unless it persists.
3. **Pull-to-refresh on a real iPhone.** The Calendar's pull-to-refresh and focus refresh
   (`web/src/views/calendar/refresh.ts`) are only tested in desktop Chromium. On the home-screen app:
   pull down on the Calendar, and switch away and back; both should reload Friends' Logs. If the pull
   does nothing, the focus refresh still works; note it as a bug.
4. **Push on iPhone.** Home-screen app only (iOS has no web push in a Safari tab): Settings >
   Notifications on, then have a Friend react; the push shows Display name only (no Details, Comment
   text or emoji) and tapping it opens that Day. Monday 08:00 Home zone: the Summary push arrives.
5. **Passkeys.** Face ID sign-in works on both phones (the relying party is throne.ashershores.com).
6. **Logs hold no health data.** In CloudWatch, the Api, Notifier and PreSignUp log groups have only
   error names/messages and the Notifier's counts; AppSync logs errors without content. Search for a
   word from a Note you wrote: no hits.
7. **Budget.** `throne-monthly` ($1, tag app=throne) exists and emails at 80% actual / 100% forecast.
8. **Cognito users.** Only people you invited. CloudTrail: no `SignUp`/`AdminCreateUser` you didn't
   expect, and no `live-check-probe` user.

## Context and env keys (reference)

Context key (`-c key=value`) or env var; context wins. Read by `infra/lib/config.ts` and `infra/bin/app.ts`.

```
account         CDK_DEFAULT_ACCOUNT    the CDK CLI sets the env var from your credentials
hostedZoneId    HOSTED_ZONE_ID         existing public zone
zoneName        HOSTED_ZONE_NAME       throne.ashershores.com must be inside it
githubRepoId    GITHUB_REPOSITORY_ID   numeric; required with hosting; set automatically in GitHub Actions
region          -                      defaults to us-west-1 (AWS_REGION is ignored on purpose)
requireHosting  -                      true makes a missing zone an error (npm run deploy sets it)
```

With no zone set, `npm run synth` builds only the `Throne` stack (what the CI test job does).
