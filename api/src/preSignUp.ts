// Cognito pre-sign-up trigger: the only gate on self sign-up (infra/lib/stacks.ts turns self sign-up
// on only together with this trigger). A SignUp goes through only with an open Invite token, sent by
// the web app as ClientMetadata.inviteToken (ValidationData also accepted). The Invite is spent with
// one conditional write, so two sign-ups racing on one Invite can't both pass.
//
// Order (ticket 12): 1) read the Invite: unknown, spent, revoked or expired gets the generic refusal;
// 2) ask Cognito whether the username is taken (AWS doesn't document whether Cognito refuses a taken
// username before or after this trigger, so a clash must not be left to spend the Invite); 3) spend it.
// Step 2 comes after step 1 so only someone holding an open Invite can learn whether a username exists.
// What can still fail after the spend is Cognito itself (or two people racing for one new username);
// then the Invite stays spent and its maker makes another (spec). See docs/deploy-runbook.md.
//
// Every Invite refusal is the same generic message: nothing tells a guesser whether a token exists.
// Env: TABLE_NAME only (a user-pool ID here would be a circular dependency in CDK; the event carries it).
import type { PreSignUpTriggerEvent } from "aws-lambda";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { isInviteToken } from "@throne/shared";
import { now } from "./clock";
import { userExists } from "./cognito";
import { TABLE, ddb, inviteKey, isConditionFailed } from "./table";

export { setDocClient } from "./table";
export { setUserLookup } from "./cognito";

export const SIGN_UP_REFUSED = "Sign-up failed. Ask for a new Invite.";
export const USERNAME_TAKEN = "That username is taken. Pick another.";
export const TRY_AGAIN = "Sign-up couldn't finish. Try again in a minute.";

const logError = (e: unknown) => console.error((e as Error)?.name ?? "error", (e as Error)?.message);

export async function handler(event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> {
  // An admin creating a user in the AWS console (needs IAM, e.g. the first Profile) needs no Invite.
  if (event.triggerSource === "PreSignUp_AdminCreateUser") return event;
  if (event.triggerSource !== "PreSignUp_SignUp") throw new Error(SIGN_UP_REFUSED);

  const token = event.request.clientMetadata?.inviteToken ?? event.request.validationData?.inviteToken;
  if (!isInviteToken(token)) throw new Error(SIGN_UP_REFUSED);
  const t = now();

  let invite: Record<string, unknown> | undefined;
  try {
    invite = (await ddb().send(new GetCommand({ TableName: TABLE, Key: inviteKey(token), ConsistentRead: true }))).Item;
  } catch (e) {
    logError(e);
    throw new Error(TRY_AGAIN);
  }
  if (invite?.status !== "open" || !((invite.expiresAt as number) > t)) throw new Error(SIGN_UP_REFUSED);

  let taken: boolean;
  try {
    taken = await userExists(event.userPoolId, event.userName);
  } catch (e) {
    // Fail closed, but the Invite is untouched, so the same link works once Cognito answers.
    logError(e);
    throw new Error(TRY_AGAIN);
  }
  if (taken) throw new Error(USERNAME_TAKEN);

  try {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: inviteKey(token),
        // Not who spent it: the newcomer's username on the inviter's item would outlive a Delete Profile.
        UpdateExpression: "SET #status = :used, #usedAt = :now",
        ConditionExpression: "#status = :open AND #expiresAt > :now",
        ExpressionAttributeNames: { "#status": "status", "#usedAt": "usedAt", "#expiresAt": "expiresAt" },
        ExpressionAttributeValues: { ":used": "used", ":open": "open", ":now": t },
      }),
    );
  } catch (e) {
    if (isConditionFailed(e)) throw new Error(SIGN_UP_REFUSED);
    logError(e);
    throw new Error(SIGN_UP_REFUSED);
  }
  // Self sign-up has no email or phone to confirm: the Invite is the proof.
  event.response.autoConfirmUser = true;
  return event;
}
