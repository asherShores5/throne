// Event pushes (ticket 09): after a write commits, the API hands the Notifier Lambda what happened, as ids
// only (shared PushEvent, never Details), with an asynchronous invoke. The invoke returns as soon as Lambda
// has queued the event, so the mutation stays fast, and the API itself needs no SSM access (only the
// Notifier reads the VAPID private key). The Notifier decides who gets a push (preferences, devices).
//
// A failed hand-off never fails the write: the push is lost, the Log (or Reaction, ...) is saved.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { PushEvent } from "@throne/shared";

export type EventSink = (e: PushEvent) => Promise<void>;

let lambda: LambdaClient | undefined;

/** Production: an async ("Event") invoke of the Notifier. No function configured (e2e, local) = no pushes. */
const invokeNotifier: EventSink = async (e) => {
  const fn = process.env.NOTIFIER_FUNCTION;
  if (!fn) return;
  lambda ??= new LambdaClient({});
  await lambda.send(new InvokeCommand({ FunctionName: fn, InvocationType: "Event", Payload: new TextEncoder().encode(JSON.stringify(e)) }));
};

let sink: EventSink = invokeNotifier;

/** Test seam: where events go (undefined = the Notifier). Production never calls this. */
export function setEventSink(s: EventSink | undefined) {
  sink = s ?? invokeNotifier;
}

/** Hand one event to the Notifier. Call only after the write it describes has committed. Never throws. */
export async function emit(e: PushEvent): Promise<void> {
  try {
    await sink(e);
  } catch (err) {
    // Name only: the error could echo the request.
    console.error("push event not handed off", (err as Error)?.name ?? "error");
  }
}
