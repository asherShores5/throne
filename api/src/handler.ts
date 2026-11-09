// The Throne API: one Lambda behind AppSync (Cognito user-pool auth only). AppSync proves the token;
// the caller is the token's sub, never an ID in the arguments. Dispatch is by field name (resolvers/).
// Health data: never log arguments or results (Notes, Details); only unexpected errors are logged.
import type { AppSyncIdentityCognito, AppSyncResolverEvent } from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { UserError } from "./errors";
import { RESOLVERS } from "./resolvers";
import { TABLE, ddb, deletedKey } from "./table";

export { setDocClient } from "./table";
export { setEventSink } from "./events";
export { setUserDeleter } from "./cognito";

/**
 * A deleted (or half deleted) Profile's token still works for up to an hour, maybe on another phone. Every call
 * but deleteProfile itself (a retry finishes the job) is refused, so nothing of theirs can be recreated.
 */
async function refuseDeleted(sub: string, field: string) {
  if (field === "deleteProfile") return;
  const r = await ddb().send(new GetCommand({ TableName: TABLE, Key: deletedKey(sub) }));
  if (r.Item) throw new UserError("ProfileDeleted", "This Profile has been deleted.");
}

export async function handler(event: AppSyncResolverEvent<Record<string, unknown>>) {
  const id = event.identity as AppSyncIdentityCognito | null;
  if (!id?.sub) throw new Error("Unauthorized");
  const fn = RESOLVERS[event.info.fieldName];
  if (!fn) throw new Error(`no resolver for ${event.info.fieldName}`);
  try {
    await refuseDeleted(id.sub, event.info.fieldName);
    return await fn({ sub: id.sub, username: id.username }, event.arguments ?? {});
  } catch (e) {
    if (e instanceof UserError) throw new Error(`${e.type}: ${e.message}`);
    console.error((e as Error)?.name ?? "error", (e as Error)?.message);
    throw new Error("InternalError");
  }
}
