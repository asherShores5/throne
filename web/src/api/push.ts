// Push preferences and this device's subscription (schema/push.graphql, ticket 09). Online only, not in the outbox.
import type { PushPrefs } from "@throne/shared";
import { gql } from "./gql";

const PREFS = "summary friendRequests reactionsComments friendLogged";

export async function loadPushPrefs(): Promise<PushPrefs> {
  return (await gql<{ pushPrefs: PushPrefs }>(`query PushPrefs { pushPrefs { ${PREFS} } }`)).pushPrefs;
}

/** Only the toggles given change; `friendLogged`, if given, is the whole list. */
export async function updatePushPrefs(input: Partial<PushPrefs>): Promise<PushPrefs> {
  const r = await gql<{ updatePushPrefs: PushPrefs }>(
    `mutation UpdatePushPrefs($input: PushPrefsInput!) { updatePushPrefs(input: $input) { ${PREFS} } }`,
    { input },
  );
  return r.updatePushPrefs;
}

export async function putPushSubscription(input: { deviceId: string; endpoint: string; p256dh: string; auth: string }) {
  await gql(`mutation PutPush($input: PushSubscriptionInput!) { putPushSubscription(input: $input) { deviceId enabled } }`, { input });
}

export async function deletePushSubscription(deviceId: string) {
  await gql(`mutation DeletePush($deviceId: ID!) { deletePushSubscription(deviceId: $deviceId) { deviceId enabled } }`, { deviceId });
}
