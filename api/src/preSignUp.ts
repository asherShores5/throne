// Cognito pre-sign-up trigger: the only gate on self sign-up (infra/lib/stacks.ts turns self sign-up
// on only together with this trigger). A SignUp goes through only with an open Invite token, sent by
// the web app as ClientMetadata.inviteToken (ValidationData also accepted). The Invite is spent with
// one conditional write, so two sign-ups racing on one Invite can't both pass. If a later Cognito step
// fails, the Invite stays spent and its maker makes another (spec).
//
// Every refusal is the same generic message: nothing tells a guesser whether a token exists.
// Env: TABLE_NAME only (a user-pool ID here would be a circular dependency in CDK).
import type { PreSignUpTriggerEvent } from "aws-lambda";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { isInviteToken } from "@throne/shared";
import { now } from "./clock";
import { TABLE, ddb, inviteKey, isConditionFailed } from "./table";

export { setDocClient } from "./table";

export const SIGN_UP_REFUSED = "Sign-up failed. Ask for a new Invite.";

export async function handler(event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> {
  // An admin creating a user in the AWS console (needs IAM, e.g. the first Profile) needs no Invite.
  if (event.triggerSource === "PreSignUp_AdminCreateUser") return event;
  if (event.triggerSource !== "PreSignUp_SignUp") throw new Error(SIGN_UP_REFUSED);

  const token = event.request.clientMetadata?.inviteToken ?? event.request.validationData?.inviteToken;
  if (!isInviteToken(token)) throw new Error(SIGN_UP_REFUSED);
  const t = now();
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: inviteKey(token),
        UpdateExpression: "SET #status = :used, #usedAt = :now, #usedBy = :who",
        ConditionExpression: "#status = :open AND #expiresAt > :now",
        ExpressionAttributeNames: { "#status": "status", "#usedAt": "usedAt", "#usedBy": "usedBy", "#expiresAt": "expiresAt" },
        ExpressionAttributeValues: { ":used": "used", ":open": "open", ":now": t, ":who": event.userName },
      }),
    );
  } catch (e) {
    if (isConditionFailed(e)) throw new Error(SIGN_UP_REFUSED);
    console.error((e as Error)?.name ?? "error", (e as Error)?.message);
    throw new Error(SIGN_UP_REFUSED);
  }
  // Self sign-up has no email or phone to confirm: the Invite is the proof.
  event.response.autoConfirmUser = true;
  return event;
}
