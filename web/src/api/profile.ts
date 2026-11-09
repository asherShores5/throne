// The signed-in Profile (schema/profile.graphql). The first call after a new sign-in creates it, with
// this device's time zone as its Home zone; later calls move the Home zone with the device until the
// Profile overrides it in Settings.
import type { Avatar, ProfileFields } from "@throne/shared";
import { gql } from "./gql";

export interface Profile extends ProfileFields {
  id: string;
  /** True while the Home zone follows the device. */
  homeZoneAuto: boolean;
}

/** The deepest selection here sets QUERY_DEPTH_LIMIT (schema/compose.ts): me > avatar > emoji. */
export const PROFILE = `id displayName homeZone homeZoneAuto avatar { emoji color }`;

/** This device's IANA time zone, e.g. America/Los_Angeles (the server falls back to UTC if it's unusable). */
export const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export async function loadMe(): Promise<Profile> {
  const r = await gql<{ me: Profile }>(`query Me($homeZone: String) { me(homeZone: $homeZone) { ${PROFILE} } }`, { homeZone: deviceZone() });
  return r.me;
}

export interface ProfileEdit {
  displayName?: string;
  avatar?: Avatar;
  homeZone?: string;
  homeZoneAuto?: boolean;
}

/** Change only the fields given. */
export async function updateProfile(input: ProfileEdit): Promise<Profile> {
  const r = await gql<{ updateProfile: Profile }>(
    `mutation UpdateProfile($input: ProfileInput!) { updateProfile(input: $input) { ${PROFILE} } }`,
    { input },
  );
  return r.updateProfile;
}

/** The server's message without its "ValidationError: " style prefix, for showing to the Profile. */
export const plainMessage = (e: unknown) => String((e as Error)?.message ?? e).replace(/^(ValidationError|NotFound|Forbidden|Unavailable): /, "");
