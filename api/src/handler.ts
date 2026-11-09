// The Throne API: one Lambda behind AppSync (Cognito user-pool auth only). AppSync proves the token;
// the caller is the token's sub, never an ID in the arguments. Dispatch is by field name (resolvers/).
// Health data: never log arguments or results (Notes, Details); only unexpected errors are logged.
import type { AppSyncIdentityCognito, AppSyncResolverEvent } from "aws-lambda";
import { UserError } from "./errors";
import { RESOLVERS } from "./resolvers";

export { setDocClient } from "./table";
export { setEventSink } from "./events";

export async function handler(event: AppSyncResolverEvent<Record<string, unknown>>) {
  const id = event.identity as AppSyncIdentityCognito | null;
  if (!id?.sub) throw new Error("Unauthorized");
  const fn = RESOLVERS[event.info.fieldName];
  if (!fn) throw new Error(`no resolver for ${event.info.fieldName}`);
  try {
    return await fn({ sub: id.sub }, event.arguments ?? {});
  } catch (e) {
    if (e instanceof UserError) throw new Error(`${e.type}: ${e.message}`);
    console.error((e as Error)?.name ?? "error", (e as Error)?.message);
    throw new Error("InternalError");
  }
}
