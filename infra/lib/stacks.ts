import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, type StackProps,
  aws_appsync as appsync,
  aws_budgets as budgets,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_scheduler as scheduler,
  aws_scheduler_targets as schedulerTargets,
  custom_resources as cr,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { QUERY_DEPTH_LIMIT, RESOLVER_COUNT_LIMIT, composeSchemaDir, rootFields } from "../../schema/compose";
import { SCHEDULED_RUN } from "../../shared/src/push";
import { DYNAMO_ACCESS, type LambdaName } from "../../api/src/dynamoAccess";

/** Grant a Lambda exactly its DynamoDB actions from api/src/dynamoAccess.ts (the fake table enforces the same list). */
const grantTable = (table: dynamodb.ITableV2, fn: lambda.IFunction, name: LambdaName) =>
  table.grant(fn, ...DYNAMO_ACCESS[name].map((a) => `dynamodb:${a}`));

/** Served by the hosting stacks. Also the passkey relying party: changing it orphans every passkey. */
export const APP_DOMAIN = "throne.ashershores.com";
/** Budget alerts (the owner's personal address). */
const BUDGET_EMAIL = "asher.shores5@gmail.com";
const ROOT = path.join(__dirname, "..", "..");

/**
 * Web Push VAPID key pair (ticket 09), created on the first deploy by the VapidKeys custom resource
 * (CloudFormation can't create a SecureString) and never overwritten: a new pair would orphan every
 * device's subscription. The public key goes to the app in config.json; only the Notifier and the
 * VapidKeys function may read the private key. The API Lambda has no SSM access at all.
 */
export const VAPID_PARAMS = { private: "/throne/vapid/private", public: "/throne/vapid/public" };

const vapidParamArns = (stack: Stack) =>
  [VAPID_PARAMS.private, VAPID_PARAMS.public].map((name) => `arn:aws:ssm:${stack.region}:${stack.account}:parameter${name}`);

/** Settings the Lambdas added from ticket 09 share: bundled from the monorepo, Node 22 on ARM, two-week logs. */
function lambdaFn(
  scope: Construct,
  id: string,
  props: { entry: string; format: nodejs.OutputFormat } & Omit<nodejs.NodejsFunctionProps, "entry" | "bundling" | "logGroup">,
) {
  const { entry, format, ...rest } = props;
  return new nodejs.NodejsFunction(scope, id, {
    entry: path.join(ROOT, "api", "src", entry),
    projectRoot: ROOT,
    depsLockFilePath: path.join(ROOT, "package-lock.json"),
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    bundling: { minify: true, sourceMap: true, format, target: "node22" },
    logGroup: new logs.LogGroup(scope, `${id.replace(/Fn$/, "")}Logs`, { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
    ...rest,
  });
}

/** The composed schema/*.graphql, as a file for AppSync's Definition (see schema/compose.ts). */
function composedSchemaFile(sdl: string) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "throne-schema-")), "schema.graphql");
  writeFileSync(file, sdl);
  return file;
}

/** Data, auth, the API and the budget. Hosting: lib/hosting.ts. Deploy CI: lib/ci.ts. */
export class AppStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;
  readonly api: appsync.GraphqlApi;
  readonly table: dynamodb.TableV2;
  /** The Web Push public key (base64url) for config.json. */
  readonly vapidPublicKey: string;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // ---- data: one table (api/src/table.ts has the key layout) ----
    const table = (this.table = new dynamodb.TableV2(this, "Table", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Epoch seconds. Only Delete Profile's content-free marker sets it (api/src/table.ts).
      timeToLiveAttribute: "ttl",
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    }));

    // ---- auth ----
    // ESSENTIALS allows the USER_AUTH (choice-based) flow: a password once, then a passkey (Face ID
    // on iPhone; iCloud Keychain or phone QR on desktop). The password stays as the backup.
    // Self sign-up is on ONLY because the pre-sign-up trigger below refuses any sign-up without an open
    // Invite (api/src/preSignUp.ts; asserted together in infra/test/stacks.test.ts). Never one without the other.
    // The trigger gets only TABLE_NAME: a user-pool ID in its env would be a circular dependency.
    const preSignUp = new nodejs.NodejsFunction(this, "PreSignUpFn", {
      entry: path.join(ROOT, "api", "src", "preSignUp.ts"),
      projectRoot: ROOT,
      depsLockFilePath: path.join(ROOT, "package-lock.json"),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // Cognito waits at most 5 seconds for a trigger.
      timeout: Duration.seconds(5),
      environment: { TABLE_NAME: table.tableName },
      bundling: { minify: true, sourceMap: true, format: nodejs.OutputFormat.ESM, target: "node22" },
      logGroup: new logs.LogGroup(this, "PreSignUpLogs", { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
    });
    // Read the Invite (GetItem), then spend it with one conditional UpdateItem; nothing else on the table.
    grantTable(table, preSignUp, "preSignUp");

    const userPool = (this.userPool = new cognito.UserPool(this, "Users", {
      userPoolName: "throne",
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      signInPolicy: { allowedFirstAuthFactors: { password: true, passkey: true } },
      passkeyRelyingPartyId: APP_DOMAIN,
      passkeyUserVerification: cognito.PasskeyUserVerification.REQUIRED,
      selfSignUpEnabled: true,
      lambdaTriggers: { preSignUp },
      // No email or phone to confirm: the trigger auto-confirms a sign-up that spent an Invite.
      autoVerify: { email: false, phone: false },
      signInAliases: { username: true },
      signInCaseSensitive: false,
      passwordPolicy: { minLength: 16, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.NONE,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    }));
    // The trigger asks whether a username is taken before it spends an Invite (ticket 12): AdminGetUser on
    // this pool only. A separate policy, not the role's default one: the function doesn't wait for it, so the
    // pool -> trigger -> role chain has no cycle (the pool ID comes from the trigger event, not env). Until it
    // exists (first deploy only) the trigger fails closed with "try again" and the Invite stays open.
    new iam.Policy(this, "PreSignUpUserLookup", {
      roles: [preSignUp.role!],
      statements: [new iam.PolicyStatement({ actions: ["cognito-idp:AdminGetUser"], resources: [userPool.userPoolArn] })],
    });
    this.client = userPool.addClient("Web", {
      authFlows: { user: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
      // No hosted UI or OAuth redirects: the app talks to Cognito's JSON API directly.
      disableOAuth: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      // Signed in on the phone for days (spec), then sign in again.
      refreshTokenValidity: Duration.days(7),
    });

    // ---- API: AppSync + one Lambda ----
    const fn = new nodejs.NodejsFunction(this, "ApiFn", {
      entry: path.join(ROOT, "api", "src", "handler.ts"),
      projectRoot: ROOT,
      depsLockFilePath: path.join(ROOT, "package-lock.json"),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: { TABLE_NAME: table.tableName },
      bundling: { minify: true, sourceMap: true, format: nodejs.OutputFormat.ESM, target: "node22" },
      logGroup: new logs.LogGroup(this, "ApiLogs", { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
    });
    // Single-item reads/writes and queries (transactions use the same per-item actions, plus ConditionCheckItem
    // for a transaction's ConditionCheck); never Scan or Batch*.
    grantTable(table, fn, "api");
    // Delete Profile ends by deleting the caller's own Cognito user (api/src/cognito.ts). The pool ID in this env is
    // no cycle: the pool's only trigger is the separate pre-sign-up Lambda, and nothing in the pool refers to this one.
    fn.addEnvironment("USER_POOL_ID", userPool.userPoolId);
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["cognito-idp:AdminDeleteUser"], resources: [userPool.userPoolArn] }));

    const sdl = composeSchemaDir();
    const api = (this.api = new appsync.GraphqlApi(this, "Api", {
      name: "throne",
      definition: appsync.Definition.fromFile(composedSchemaFile(sdl)),
      authorizationConfig: {
        defaultAuthorization: { authorizationType: appsync.AuthorizationType.USER_POOL, userPoolConfig: { userPool } },
      },
      // Errors only, without request/response content: Logs are health data.
      logConfig: { fieldLogLevel: appsync.FieldLogLevel.ERROR, excludeVerboseContent: true, retention: logs.RetentionDays.TWO_WEEKS },
      // The app knows its schema. The depth cap is the deepest selection the app sends (QUERY_DEPTH_LIMIT;
      // e2e/backend.ts refuses anything deeper, as AppSync does).
      introspectionConfig: appsync.IntrospectionConfig.DISABLED,
      queryDepthLimit: QUERY_DEPTH_LIMIT,
      resolverCountLimit: RESOLVER_COUNT_LIMIT, // root fields per request (schema/compose.ts)
    }));

    // Every Query and Mutation field goes to the Lambda, which dispatches by field name
    // (api/src/resolvers). A new field needs no change here.
    const ds = api.addLambdaDataSource("ApiDs", fn);
    const fields = rootFields(sdl);
    for (const typeName of ["Query", "Mutation"] as const) {
      for (const fieldName of fields[typeName]) ds.createResolver(`${typeName[0]}${fieldName}`, { typeName, fieldName });
    }

    // ---- push (ticket 09): VAPID keys, the Notifier, and the API's hand-off to it ----
    // Logic and tests in api/src/vapid.ts. The resource returns only the public key; config.json reads it
    // with a GetAtt, so the keys exist before config.json does.
    const vapidFn = lambdaFn(this, "VapidKeysFn", {
      entry: "vapidKeysProvider.ts",
      format: nodejs.OutputFormat.ESM,
      memorySize: 256,
      timeout: Duration.seconds(30),
      environment: { VAPID_PRIVATE_PARAM: VAPID_PARAMS.private, VAPID_PUBLIC_PARAM: VAPID_PARAMS.public },
    });
    // GetParameter covers the private key on purpose: vapid.ts reads it only to rebuild a missing public key
    // after a crash between its two writes. No KMS statement: the AWS-managed aws/ssm key lets SSM decrypt for
    // any principal allowed the SSM call.
    vapidFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameter", "ssm:PutParameter"], resources: vapidParamArns(this) }));
    const vapidKeys = new CustomResource(this, "VapidKeys", {
      resourceType: "Custom::VapidKeys",
      serviceToken: new cr.Provider(this, "VapidKeysProvider", {
        onEventHandler: vapidFn,
        logGroup: new logs.LogGroup(this, "VapidKeysProviderLogs", { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
      }).serviceToken,
    });
    this.vapidPublicKey = vapidKeys.getAttString("publicKey");

    // Bundled as CJS: web-push is CommonJS and calls require("crypto"), which ESM output can't do.
    const notifier = lambdaFn(this, "NotifierFn", {
      entry: "notifier.ts",
      format: nodejs.OutputFormat.CJS,
      memorySize: 256,
      timeout: Duration.seconds(30),
      environment: {
        TABLE_NAME: table.tableName,
        VAPID_PRIVATE_PARAM: VAPID_PARAMS.private,
        VAPID_PUBLIC_PARAM: VAPID_PARAMS.public,
        VAPID_SUBJECT: `mailto:${BUDGET_EMAIL}`,
      },
    });
    notifier.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: vapidParamArns(this) }));
    // Only what notifier.ts calls: GetItem/Query to read Profiles, prefs, Friendships, Logs, devices;
    // DeleteItem to prune; PutItem (conditional, attribute_not_exists) to store a weekly Summary (ticket 10).
    // ConditionCheckItem: the Summary claim checks nobody in it is being deleted (api/src/resolvers/summary.ts).
    grantTable(table, notifier, "notifier");
    // An event push that fails is dropped, never retried: a retry after a partial send would push twice.
    notifier.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: Duration.minutes(15) });
    // The Notifier only comes up once the keys exist.
    notifier.node.addDependency(vapidKeys);

    // The weekly Summary (ticket 10): every hour at minute 0 UTC, so 08:00 Monday lands on a run in every
    // whole-hour zone (half-hour zones get it at 08:30). Never retried: the Summary item is the claim, so a
    // retry would do nothing anyway, and a later run that Monday catches up a missed one.
    new scheduler.Schedule(this, "NotifierHourly", {
      description: "Throne Notifier: weekly Summary at Monday 08:00 in each Home zone",
      schedule: scheduler.ScheduleExpression.cron({ minute: "0" }),
      target: new schedulerTargets.LambdaInvoke(notifier, { retryAttempts: 0, input: scheduler.ScheduleTargetInput.fromObject(SCHEDULED_RUN) }),
    });

    // The API hands events to the Notifier with an async invoke (api/src/events.ts): that one function only.
    fn.addEnvironment("NOTIFIER_FUNCTION", notifier.functionName);
    notifier.grantInvoke(fn);

    // ---- cost tripwire: $1/month on the app=throne tag (lib/app.ts) ----
    const alert = (notificationType: string, threshold: number) => ({
      notification: { notificationType, comparisonOperator: "GREATER_THAN", threshold },
      subscribers: [{ subscriptionType: "EMAIL", address: BUDGET_EMAIL }],
    });
    new budgets.CfnBudget(this, "Budget", {
      budget: {
        budgetName: "throne-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: 1, unit: "USD" },
        costFilters: { TagKeyValue: ["user:app$throne"] },
      },
      notificationsWithSubscribers: [alert("ACTUAL", 80), alert("FORECASTED", 100)],
    });

    new CfnOutput(this, "Region", { value: this.region });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "ClientId", { value: this.client.userPoolClientId });
    new CfnOutput(this, "GraphqlUrl", { value: api.graphqlUrl });
    new CfnOutput(this, "TableName", { value: table.tableName });
  }
}
