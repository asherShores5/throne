// Notifier Lambda (ticket 09; push sending copied from HoneyDo). Two ways in:
//   - an event push: the API invokes it asynchronously after a write commits (api/src/events.ts) with a
//     shared PushEvent (ids only). It re-checks the facts (the Friendship or the request still there), picks
//     the recipients by their preferences, and sends "<name> did X" to each of their devices.
//   - ticket 10: the hourly Summary (EventBridge Scheduler) goes in runScheduled() below.
// Sending, for both: one push per device; a device the push service says is gone (404/410) is deleted.
//
// It is the only principal that reads the VAPID private key (SSM); the API Lambda has no SSM access.
// Bundled as CJS (infra/lib/stacks.ts): web-push is CommonJS and calls require("crypto").
// Health data: it never reads Details; push text comes from shared eventPushPayload (who + what only).
import { createHash } from "node:crypto";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import webpush from "web-push";
import { eventPushPayload, parsePushEvent, type PushEvent, type PushPayload, type PushToggles } from "@throne/shared";
import { TABLE, ddb, isConditionFailed, profilePk } from "./table";
import { followersOf, hasFriendRequest, isFriend, profileCard } from "./resolvers/friend";
import { PUSH_PREFIX, pushToggles } from "./resolvers/push";

export { setDocClient } from "./table";

const PUSH_TIMEOUT_MS = 5000;

// ---- seams -----------------------------------------------------------------

/** One device's Web Push subscription, in the shape web-push takes. */
export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface SendOptions {
  /** Seconds the push service keeps an undelivered push (RFC 8030 §5.2). */
  TTL: number;
  urgency: "very-low" | "low" | "normal" | "high";
  /** A newer push with the same topic replaces an undelivered one (RFC 8030 §5.4). */
  topic?: string;
}

/** Sends one push. Rejects on failure; a push-service answer carries `statusCode` (404/410 = gone). */
export type PushSender = (sub: PushTarget, payload: string, opts: SendOptions) => Promise<void>;

let vapid: Promise<void> | undefined;

/** VAPID keys from SSM, read once per cold start. The private key never leaves this process. */
function loadVapid() {
  vapid ??= (async () => {
    const ssm = new SSMClient({});
    const get = async (name: string) =>
      (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter!.Value!;
    const [publicKey, privateKey] = await Promise.all([get(process.env.VAPID_PUBLIC_PARAM!), get(process.env.VAPID_PRIVATE_PARAM!)]);
    webpush.setVapidDetails(process.env.VAPID_SUBJECT!, publicKey, privateKey);
  })().catch((e) => {
    vapid = undefined; // retry on the next run instead of caching the failure
    throw e;
  });
  return vapid;
}

const webPushSender: PushSender = async (sub, payload, opts) => {
  await loadVapid();
  await webpush.sendNotification(sub, payload, { ...opts, timeout: PUSH_TIMEOUT_MS });
};

let send: PushSender = webPushSender;

/** Test seam: swap the push sender for a fake (undefined = web-push). Production never calls this. */
export function setPushSender(sender: PushSender | undefined) {
  send = sender ?? webPushSender;
}

// ---- devices ---------------------------------------------------------------

interface Device extends PushTarget {
  SK: string;
}

async function devicesOf(sub: string): Promise<Device[]> {
  const out: Device[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await ddb().send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :p)",
      ExpressionAttributeNames: { "#pk": "PK", "#sk": "SK" },
      ExpressionAttributeValues: { ":pk": profilePk(sub), ":p": PUSH_PREFIX },
      ExclusiveStartKey: start,
    }));
    for (const i of r.Items ?? []) {
      out.push({ SK: i.SK as string, endpoint: i.endpoint as string, keys: { p256dh: i.p256dh as string, auth: i.auth as string } });
    }
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}

export interface RunSummary {
  /** Device deliveries that succeeded / failed, and subscriptions deleted as gone. */
  sent: number;
  failed: number;
  pruned: number;
}

const empty = (): RunSummary => ({ sent: 0, failed: 0, pruned: 0 });

/** Send one payload to every device of `to`, pruning the ones that are gone. */
async function deliver(to: string, payload: PushPayload, opts: SendOptions, summary: RunSummary) {
  const body = JSON.stringify(payload);
  await Promise.all(
    (await devicesOf(to)).map(async (d) => {
      try {
        await send({ endpoint: d.endpoint, keys: d.keys }, body, opts);
        summary.sent++;
      } catch (e) {
        summary.failed++;
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          try {
            // Only if it's still that endpoint: the phone may have re-enabled (new endpoint) meanwhile.
            await ddb().send(new DeleteCommand({
              TableName: TABLE, Key: { PK: profilePk(to), SK: d.SK },
              ConditionExpression: "#endpoint = :e", ExpressionAttributeNames: { "#endpoint": "endpoint" }, ExpressionAttributeValues: { ":e": d.endpoint },
            }));
            summary.pruned++;
          } catch (err) {
            if (!isConditionFailed(err)) throw err;
          }
        } else {
          // 403 is a VAPID setup bug, 413 ours, 429/5xx transient: keep the subscription. No ids or text logged.
          console.error(`push failed (${status ?? "no status"})`, (e as Error)?.name);
        }
      }
    }),
  );
}

// ---- event pushes ----------------------------------------------------------

/** Which toggle lets each event kind through (friendLogged is per Friend instead). */
const TOGGLE: Record<Exclude<PushEvent["kind"], "friendLogged">, keyof PushToggles> = {
  friendRequest: "friendRequests",
  friendAccepted: "friendRequests",
  reaction: "reactionsComments",
  comment: "reactionsComments",
};

/** Who should get this event's push, given what's true now. */
async function recipients(e: PushEvent): Promise<string[]> {
  if (e.kind === "friendLogged") return followersOf(e.from);
  if (e.to === e.from) return [];
  // Still true? A request may be cancelled, a Friendship ended, before this runs.
  const still = e.kind === "friendRequest" ? await hasFriendRequest(e.to, e.from) : await isFriend(e.to, e.from);
  if (!still) return [];
  return (await pushToggles(e.to))[TOGGLE[e.kind]] ? [e.to] : [];
}

/** A newer "Sam logged" replaces an undelivered one; other pushes each stand alone. */
const topicFor = (e: PushEvent) => (e.kind === "friendLogged" ? "l" + createHash("sha256").update(e.from).digest("base64url").slice(0, 31) : undefined);

export async function sendEventPush(e: PushEvent): Promise<RunSummary> {
  const summary = empty();
  const to = await recipients(e);
  if (!to.length) return summary;
  const card = await profileCard(e.from);
  if (!card) return summary;
  const payload = eventPushPayload(e, card.displayName);
  // A "Friend logged" is stale after a few hours; a Friend request or Reaction still matters tomorrow.
  const opts: SendOptions = { TTL: e.kind === "friendLogged" ? 6 * 3600 : 24 * 3600, urgency: "normal", topic: topicFor(e) };
  for (const sub of to) await deliver(sub, payload, opts, summary);
  return summary;
}

// ---- scheduled runs (ticket 10) --------------------------------------------

/**
 * Ticket 10 builds the weekly Summary here: an hourly schedule invokes the Notifier with no event; for each
 * Profile whose Home zone just passed Monday 08:00 it stores the Summary and, with `summary` on, pushes it
 * (shared pushLinks.summary) through deliver(). Nothing yet.
 */
async function runScheduled(): Promise<RunSummary> {
  return empty();
}

// ---- entry -----------------------------------------------------------------

export async function handler(event: unknown): Promise<RunSummary> {
  const e = parsePushEvent(event);
  const summary = e ? await sendEventPush(e) : await runScheduled();
  // Counts only: never who, never what.
  console.log(JSON.stringify({ msg: "notifier run", kind: e?.kind ?? "scheduled", ...summary }));
  return summary;
}
