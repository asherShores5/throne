// The signed-in Profile (schema/profile.graphql). The first call after a new sign-in creates it, with
// this device's time zone as its Home zone.
import type { ProfileFields } from "@throne/shared";
import { gql } from "./gql";

export interface Profile extends ProfileFields {
  id: string;
}

/** The deepest selection here sets QUERY_DEPTH_LIMIT (schema/compose.ts): me > avatar > emoji. */
export const PROFILE = `id displayName homeZone avatar { emoji color }`;

/** This device's IANA time zone, e.g. America/Los_Angeles (the server falls back to UTC if it's unusable). */
export const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export async function loadMe(): Promise<Profile> {
  const r = await gql<{ me: Profile }>(`query Me($homeZone: String) { me(homeZone: $homeZone) { ${PROFILE} } }`, { homeZone: deviceZone() });
  return r.me;
}
