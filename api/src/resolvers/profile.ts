// The caller's Profile (ticket 01), at PROFILE#<sub> / PROFILE. Schema: schema/profile.graphql.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { newProfile, type ProfileFields } from "@throne/shared";
import { PROFILE_SK, TABLE, ddb, isConditionFailed, profilePk } from "../table";
import type { Ctx, ResolverModule } from "./types";

export interface Profile extends ProfileFields {
  id: string;
}

const key = (sub: string) => ({ PK: profilePk(sub), SK: PROFILE_SK });

function out(sub: string, rec: Record<string, unknown>): Profile {
  return { id: sub, displayName: rec.displayName as string, avatar: rec.avatar as Profile["avatar"], homeZone: rec.homeZone as string };
}

async function read(sub: string): Promise<Profile | undefined> {
  const r = await ddb().send(new GetCommand({ TableName: TABLE, Key: key(sub) }));
  return r.Item && out(sub, r.Item);
}

/**
 * The caller's Profile, created on first use. The create is conditional, so two first calls at once
 * (two tabs, a retry) still leave exactly one record: the loser reads the winner's.
 */
export async function ensureProfile(ctx: Ctx, deviceZone: unknown): Promise<Profile> {
  const found = await read(ctx.sub);
  if (found) return found;
  const fields = newProfile(deviceZone);
  try {
    await ddb().send(
      new PutCommand({
        TableName: TABLE,
        Item: { ...key(ctx.sub), ...fields, createdAt: Date.now() },
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "PK" },
      }),
    );
    return { id: ctx.sub, ...fields };
  } catch (e) {
    if (!isConditionFailed(e)) throw e;
    const winner = await read(ctx.sub);
    if (!winner) throw e;
    return winner;
  }
}

export const profile: ResolverModule = {
  Query: {
    async me(ctx, { homeZone }) {
      return ensureProfile(ctx, homeZone);
    },
  },
  Mutation: {},
};
