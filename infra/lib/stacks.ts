import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CfnOutput, Duration, RemovalPolicy, Stack, type StackProps,
  aws_appsync as appsync,
  aws_budgets as budgets,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { QUERY_DEPTH_LIMIT, composeSchemaDir, rootFields } from "../../schema/compose";

/** Served by the hosting stacks. Also the passkey relying party: changing it orphans every passkey. */
export const APP_DOMAIN = "throne.ashershores.com";
/** Budget alerts (the owner's personal address). */
const BUDGET_EMAIL = "asher.shores5@gmail.com";
const ROOT = path.join(__dirname, "..", "..");

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

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // ---- data: one table (api/src/table.ts has the key layout) ----
    const table = (this.table = new dynamodb.TableV2(this, "Table", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
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
    // Spending an Invite is one conditional UpdateItem; it reads and writes nothing else.
    table.grant(preSignUp, "dynamodb:UpdateItem");

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
    // Single-item reads/writes and queries (transactions use the same per-item actions); never Scan or Batch*.
    table.grant(fn, "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query");

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
      resolverCountLimit: 2,
    }));

    // Every Query and Mutation field goes to the Lambda, which dispatches by field name
    // (api/src/resolvers). A new field needs no change here.
    const ds = api.addLambdaDataSource("ApiDs", fn);
    const fields = rootFields(sdl);
    for (const typeName of ["Query", "Mutation"] as const) {
      for (const fieldName of fields[typeName]) ds.createResolver(`${typeName[0]}${fieldName}`, { typeName, fieldName });
    }

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
