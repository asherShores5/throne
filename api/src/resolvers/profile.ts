// The caller's Profile (tickets 01, 02), at PROFILE#<sub> / PROFILE. Schema: schema/profile.graphql.
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { cleanDisplayName, isAvatar, isHomeZone, newProfile, type ProfileFields } from "@throne/shared";
import { invalid } from "../errors";
import { PROFILE_SK, TABLE, ddb, isConditionFailed, profilePk } from "../table";
import type { Ctx, ResolverModule } from "./types";

export interface Profile extends ProfileFields {
  id: string;
  /** The Home zone follows the device (each call with a new device zone moves it) until overridden. */
  homeZoneAuto: boolean;
}

const key = (sub: string) => ({ PK: profilePk(sub), SK: PROFILE_SK });

function out(sub: string, rec: Record<string, unknown>): Profile {
  return {
    id: sub,
    displayName: rec.displayName as string,
    avatar: rec.avatar as Profile["avatar"],
    homeZone: rec.homeZone as string,
    // Records from before ticket 02 have no flag: they follow the device.
    homeZoneAuto: rec.homeZoneAuto !== false,
  };
}

async function read(sub: string): Promise<Profile | undefined> {
  const r = await ddb().send(new GetCommand({ TableName: TABLE, Key: key(sub) }));
  return r.Item && out(sub, r.Item);
}

interface Condition {
  expr: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
}

/** SET these fields on the caller's existing Profile record (plus an optional condition); the record after. */
async function update(sub: string, fields: Record<string, unknown>, condition?: Condition): Promise<Profile> {
  const names: Record<string, string> = { "#pk": "PK", ...condition?.names };
  const values: Record<string, unknown> = { ...condition?.values };
  const sets = Object.entries(fields).map(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:f${i}`] = v;
    return `#f${i} = :f${i}`;
  });
  const r = await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: key(sub),
      UpdateExpression: `SET ${sets.join(", ")}`,
      // AND binds tighter than OR; testing/fakeDynamo.ts takes flat expressions only (no parentheses).
      ConditionExpression: condition ? `attribute_exists(#pk) AND ${condition.expr}` : "attribute_exists(#pk)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }),
  );
  return out(sub, r.Attributes!);
}

/**
 * The Home zone follows the device until the Profile overrides it. The write is conditional on still
 * following, so one device's call can't undo an override just made on another.
 */
async function followDevice(p: Profile, deviceZone: unknown): Promise<Profile> {
  if (!p.homeZoneAuto || !isHomeZone(deviceZone) || deviceZone === p.homeZone) return p;
  try {
    return await update(p.id, { homeZone: deviceZone }, {
      // = (exists AND no flag) OR flag is true; a record with the flag true exists.
      expr: "attribute_not_exists(#auto) OR #auto = :true",
      names: { "#auto": "homeZoneAuto" },
      values: { ":true": true },
    });
  } catch (e) {
    if (!isConditionFailed(e)) throw e;
    return (await read(p.id)) ?? p;
  }
}

/**
 * The caller's Profile, created on first use; its Home zone moves to `deviceZone` if it follows the
 * device. The create is conditional, so two first calls at once (two tabs, a retry) still leave exactly
 * one record: the loser reads the winner's. Pass `undefined` as the zone to just read.
 */
export async function ensureProfile(ctx: Ctx, deviceZone: unknown): Promise<Profile> {
  const found = await read(ctx.sub);
  if (found) return followDevice(found, deviceZone);
  const fields = newProfile(deviceZone);
  try {
    await ddb().send(
      new PutCommand({
        TableName: TABLE,
        Item: { ...key(ctx.sub), ...fields, homeZoneAuto: true, createdAt: Date.now() },
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "PK" },
      }),
    );
    return { id: ctx.sub, ...fields, homeZoneAuto: true };
  } catch (e) {
    if (!isConditionFailed(e)) throw e;
    const winner = await read(ctx.sub);
    if (!winner) throw e;
    return winner;
  }
}

/** The checked fields of an updateProfile input; unknown keys (an `id`, say) are ignored. */
function profileEdits(input: unknown): Record<string, unknown> {
  const i = (input ?? {}) as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  if (i.displayName != null) {
    const name = cleanDisplayName(i.displayName);
    if (!name) throw invalid("A Display name is 1 to 24 characters.");
    fields.displayName = name;
  }
  if (i.avatar != null) {
    if (!isAvatar(i.avatar)) throw invalid("Pick an Avatar emoji and color from the choices.");
    fields.avatar = { emoji: i.avatar.emoji, color: i.avatar.color };
  }
  if (i.homeZoneAuto != null && typeof i.homeZoneAuto !== "boolean") throw invalid("homeZoneAuto is true or false.");
  if (i.homeZoneAuto === false && i.homeZone == null) throw invalid("Pick a Home zone.");
  if (i.homeZone != null) {
    if (!isHomeZone(i.homeZone)) throw invalid("That isn't a time zone name (e.g. America/Los_Angeles).");
    fields.homeZone = i.homeZone;
  }
  if (i.homeZoneAuto != null) fields.homeZoneAuto = i.homeZoneAuto;
  return fields;
}

export const profile: ResolverModule = {
  Query: {
    async me(ctx, { homeZone }) {
      return ensureProfile(ctx, homeZone);
    },
  },
  Mutation: {
    /**
     * Edit the caller's Display name, Avatar and Home zone; only the fields sent change.
     * `homeZoneAuto: false` pins `homeZone` (which must be sent); `true` follows the device again.
     */
    async updateProfile(ctx, { input }) {
      const fields = profileEdits(input);
      const current = await ensureProfile(ctx, undefined);
      return Object.keys(fields).length ? update(ctx.sub, fields) : current;
    },
  },
};
