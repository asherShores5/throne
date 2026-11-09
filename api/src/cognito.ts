// Cognito calls. The API makes one: deleting the caller's own user at the end of Delete Profile (ticket 11).
// AdminDeleteUser on this pool only (infra/lib/stacks.ts grants exactly that). The pool ID reaches the API Lambda
// through its env; that is no circular dependency, because the pool's trigger is the separate pre-sign-up Lambda.
// The username comes from the token AppSync verified, never from arguments.
import { AdminDeleteUserCommand, AdminGetUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

export type UserDeleter = (username: string) => Promise<void>;

const POOL = process.env.USER_POOL_ID;
let client: CognitoIdentityProviderClient | undefined;

const adminDelete: UserDeleter = async (username) => {
  // Fail closed: without a pool the user can't be deleted, so Delete Profile must not say it's done.
  if (!POOL) throw new Error("USER_POOL_ID is not set");
  client ??= new CognitoIdentityProviderClient({});
  try {
    await client.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: username }));
  } catch (e) {
    // Already gone: a retry after a lost answer.
    if ((e as { name?: string })?.name !== "UserNotFoundException") throw e;
  }
};

/** Is this username taken in that pool? (Cognito usernames here are case-insensitive, and so is AdminGetUser.) */
export type UserLookup = (userPoolId: string, username: string) => Promise<boolean>;

/**
 * The pre-sign-up trigger's one Cognito call (api/src/preSignUp.ts). The pool ID comes from the trigger event, not
 * env, so there's no circular dependency; infra grants AdminGetUser on this pool only, in a separate policy.
 */
const adminGet: UserLookup = async (userPoolId, username) => {
  client ??= new CognitoIdentityProviderClient({});
  try {
    await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
    return true;
  } catch (e) {
    if ((e as { name?: string })?.name === "UserNotFoundException") return false;
    throw e;
  }
};

let lookup: UserLookup = adminGet;

export const userExists = (userPoolId: string, username: string) => lookup(userPoolId, username);

/** Test seam: swap the lookup for a fake (undefined = the real one). Production never calls this. */
export function setUserLookup(fn: UserLookup | undefined) {
  lookup = fn ?? adminGet;
}

let deleter: UserDeleter = adminDelete;

/** Delete the Cognito user (an already deleted one counts as done). */
export const deleteUser = (username: string) => deleter(username);

/** Test seam: swap the Cognito call for a fake (undefined = the real one). Production never calls this. */
export function setUserDeleter(fn: UserDeleter | undefined) {
  deleter = fn ?? adminDelete;
}
