// The one Cognito call the API makes: deleting the caller's own user at the end of Delete Profile (ticket 11).
// AdminDeleteUser on this pool only (infra/lib/stacks.ts grants exactly that). The pool ID reaches the API Lambda
// through its env; that is no circular dependency, because the pool's trigger is the separate pre-sign-up Lambda.
// The username comes from the token AppSync verified, never from arguments.
import { AdminDeleteUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

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

let deleter: UserDeleter = adminDelete;

/** Delete the Cognito user (an already deleted one counts as done). */
export const deleteUser = (username: string) => deleter(username);

/** Test seam: swap the Cognito call for a fake (undefined = the real one). Production never calls this. */
export function setUserDeleter(fn: UserDeleter | undefined) {
  deleter = fn ?? adminDelete;
}
