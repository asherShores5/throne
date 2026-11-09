// Invites (ticket 02). Schema: schema/invite.graphql. Spent by the pre-sign-up trigger (../preSignUp.ts).
//
// The cap of 3 open Invites holds even when creates race: a Profile has 3 Invite places
// (PROFILE#<sub> / INVITESLOT#1..3). Creating writes the Invite and claims a free place in one
// transaction, conditional on the place still being as it was read; a place is free when it is
// empty or its Invite is no longer open (used or expired). No place free: refused.
//
// An Invite item exists only while one of its maker's places holds it: re-using a place deletes the spent Invite
// in the same transaction, and revoking deletes it (an unknown token is refused like a revoked one). So a
// Profile's Invites are exactly its 3 places, and Delete Profile (forgetInvitesOf) finds every one.
import { randomBytes } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { INVITE_TTL_MS, MAX_OPEN_INVITES, isInviteToken } from "@throne/shared";
import { now } from "../clock";
import { UserError, invalid } from "../errors";
import { INVITE_SLOT_PREFIX, TABLE, ddb, inviteKey, isConditionFailed, profilePk } from "../table";
import type { ResolverModule } from "./types";

export interface Invite {
  token: string;
  createdAt: string;
  expiresAt: string;
}

interface InviteRecord {
  creator: string;
  createdAt: number;
  expiresAt: number;
  status: "open" | "used";
}

interface Slot {
  n: number;
  token?: string;
  invite?: InviteRecord;
}

const slotKey = (sub: string, n: number) => ({ PK: profilePk(sub), SK: `${INVITE_SLOT_PREFIX}${n}` });
const isOpen = (r: InviteRecord | undefined, at: number): r is InviteRecord => r?.status === "open" && r.expiresAt > at;
const out = (token: string, r: InviteRecord): Invite => ({
  token,
  createdAt: new Date(r.createdAt).toISOString(),
  expiresAt: new Date(r.expiresAt).toISOString(),
});
const isCancelled = (e: unknown) => (e as { name?: string })?.name === "TransactionCanceledException";

/** The caller's 3 Invite places, each with the Invite in it (if any). */
async function slots(sub: string): Promise<Slot[]> {
  const r = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :slot)",
      ExpressionAttributeNames: { "#pk": "PK", "#sk": "SK" },
      ExpressionAttributeValues: { ":pk": profilePk(sub), ":slot": INVITE_SLOT_PREFIX },
    }),
  );
  const tokens = new Map((r.Items ?? []).map((i) => [Number(String(i.SK).slice(INVITE_SLOT_PREFIX.length)), i.token as string]));
  return Promise.all(
    Array.from({ length: MAX_OPEN_INVITES }, async (_, i) => {
      const n = i + 1;
      const token = tokens.get(n);
      if (!token) return { n };
      const got = await ddb().send(new GetCommand({ TableName: TABLE, Key: inviteKey(token) }));
      return { n, token, invite: got.Item as InviteRecord | undefined };
    }),
  );
}

async function tryCreate(sub: string): Promise<Invite | "full" | "raced"> {
  const t = now();
  const free = (await slots(sub)).find((s) => !isOpen(s.invite, t));
  if (!free) return "full";
  const token = randomBytes(16).toString("base64url");
  const rec: InviteRecord = { creator: sub, createdAt: t, expiresAt: t + INVITE_TTL_MS, status: "open" };
  try {
    await ddb().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: { ...inviteKey(token), ...rec },
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "PK" },
            },
          },
          {
            // The place must still be as read: empty, or holding the same spent Invite.
            Put: {
              TableName: TABLE,
              Item: { ...slotKey(sub, free.n), token },
              ...(free.token
                ? { ConditionExpression: "#token = :old", ExpressionAttributeNames: { "#token": "token" }, ExpressionAttributeValues: { ":old": free.token } }
                : { ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "PK" } }),
            },
          },
          // The spent Invite that was in the place goes with it (nothing else points at it any more).
          ...(free.token && free.invite ? [{ Delete: { TableName: TABLE, Key: inviteKey(free.token) } }] : []),
        ],
      }),
    );
  } catch (e) {
    if (isCancelled(e)) return "raced";
    throw e;
  }
  return out(token, rec);
}

/**
 * Delete Profile: every Invite `sub` made (open or spent) and its place. Each place goes in the same transaction as
 * its Invite, so a retry finds whatever is left. An open Invite deleted here can no longer be spent.
 */
export async function forgetInvitesOf(sub: string): Promise<void> {
  for (const s of await slots(sub)) {
    if (!s.token) continue;
    const place = { Delete: { TableName: TABLE, Key: slotKey(sub, s.n) } };
    const mine = s.invite?.creator === sub;
    await ddb().send(new TransactWriteCommand({
      TransactItems: mine
        ? [{
            Delete: {
              TableName: TABLE, Key: inviteKey(s.token), ConditionExpression: "#creator = :me",
              ExpressionAttributeNames: { "#creator": "creator" }, ExpressionAttributeValues: { ":me": sub },
            },
          }, place]
        : [place],
    })).catch((e) => {
      if (!isCancelled(e) && !isConditionFailed(e)) throw e;
    });
  }
}

export const invite: ResolverModule = {
  Query: {
    async invites(ctx) {
      const t = now();
      return (await slots(ctx.sub))
        .filter((s): s is Slot & { token: string; invite: InviteRecord } => !!s.token && isOpen(s.invite, t))
        .sort((a, b) => a.invite.createdAt - b.invite.createdAt)
        .map((s) => out(s.token, s.invite));
    },
  },
  Mutation: {
    async createInvite(ctx) {
      // A lost race re-reads the places: another create took this one, but one may still be free.
      for (let attempt = 0; attempt < MAX_OPEN_INVITES + 2; attempt++) {
        const r = await tryCreate(ctx.sub);
        if (r === "full") break;
        if (r !== "raced") return r;
      }
      throw invalid(`You already have ${MAX_OPEN_INVITES} open Invites. Revoke one to make another.`);
    },

    async revokeInvite(ctx, { token }) {
      if (!isInviteToken(token)) throw invalid("That isn't an Invite.");
      const notFound = new UserError("NotFound", "No such open Invite.");
      const slot = (await slots(ctx.sub)).find((s) => s.token === token);
      if (!slot) throw notFound;
      try {
        await ddb().send(
          new TransactWriteCommand({
            TransactItems: [
              {
                // Deleted, not marked: a token that isn't there is refused like any other.
                Delete: {
                  TableName: TABLE,
                  Key: inviteKey(token),
                  ConditionExpression: "#status = :open AND #creator = :me",
                  ExpressionAttributeNames: { "#status": "status", "#creator": "creator" },
                  ExpressionAttributeValues: { ":open": "open", ":me": ctx.sub },
                },
              },
              {
                Delete: {
                  TableName: TABLE,
                  Key: slotKey(ctx.sub, slot.n),
                  ConditionExpression: "#token = :t",
                  ExpressionAttributeNames: { "#token": "token" },
                  ExpressionAttributeValues: { ":t": token },
                },
              },
            ],
          }),
        );
      } catch (e) {
        if (isCancelled(e)) throw notFound;
        throw e;
      }
      return true;
    },
  },
};
