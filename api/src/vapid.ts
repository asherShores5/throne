// Web Push VAPID key pair (copied from HoneyDo, ticket 09), created by the deploy itself (CloudFormation custom resource in AppStack,
// entry point vapidKeysProvider.ts). Keys are created once and never overwritten: a new pair would
// invalidate every push subscription. This module is the logic; the SSM adapter is in the entry point.
import { createECDH, generateKeyPairSync } from "node:crypto";

export interface VapidKeys {
  /** 65-byte uncompressed P-256 point, base64url. Served to the app in config.json. */
  publicKey: string;
  /** 32-byte P-256 scalar, base64url. Secret: only the Notifier reads it. */
  privateKey: string;
}

/** A P-256 key pair in the encoding Web Push uses (same as web-push's generateVAPIDKeys). */
export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, "base64url"), Buffer.from(pub.y!, "base64url")]);
  if (point.length !== 65 || Buffer.from(priv.d!, "base64url").length !== 32) throw new Error("unexpected key size");
  return { publicKey: point.toString("base64url"), privateKey: priv.d! };
}

/** The public key that belongs to a private key, in the same encoding. */
function publicKeyOf(privateKey: string): string {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
  return ecdh.getPublicKey().toString("base64url");
}

/** The two Parameter Store calls the provider needs. */
export interface ParamStore {
  /** The value, or undefined if the parameter doesn't exist. A SecureString stays encrypted unless `decrypt`. */
  get(name: string, opts?: { decrypt: boolean }): Promise<string | undefined>;
  /** Creates the parameter; must fail rather than overwrite one that exists. */
  create(name: string, value: string, secure: boolean): Promise<void>;
}

export interface VapidParamNames {
  private: string;
  public: string;
}

/**
 * Makes sure both parameters exist and returns the public key. Never overwrites. The private key
 * is written first, so a crash between the two writes leaves a private key whose public half can
 * be derived; the next run restores it instead of minting a new pair. The private key is only
 * decrypted in that recovery case.
 */
async function ensureVapidKeys(store: ParamStore, names: VapidParamNames): Promise<string> {
  const existingPublic = await store.get(names.public);
  const hasPrivate = (await store.get(names.private)) !== undefined; // not decrypted
  if (existingPublic && hasPrivate) return existingPublic;
  if (existingPublic) {
    throw new Error(`${names.public} exists without ${names.private}; delete ${names.public} by hand to mint a new pair`);
  }

  let publicKey: string;
  if (hasPrivate) {
    publicKey = publicKeyOf((await store.get(names.private, { decrypt: true }))!);
  } else {
    const keys = generateVapidKeys();
    await store.create(names.private, keys.privateKey, true);
    publicKey = keys.publicKey;
  }
  await store.create(names.public, publicKey, false);
  return publicKey;
}

export interface VapidKeysEvent {
  RequestType: "Create" | "Update" | "Delete";
  PhysicalResourceId?: string;
}

export interface VapidKeysResult {
  PhysicalResourceId: string;
  /** Becomes the custom resource's attributes. Public key only; the private key never leaves SSM. */
  Data: { publicKey?: string };
}

/** Fixed, so an Update never replaces the resource (a replacement would send a Delete). */
const PHYSICAL_ID = "vapid-keys";

/** CDK Provider framework onEvent handler. Delete does nothing: the keys outlive the stack. */
export async function onVapidKeysEvent(event: VapidKeysEvent, store: ParamStore, names: VapidParamNames): Promise<VapidKeysResult> {
  if (event.RequestType === "Delete") return { PhysicalResourceId: event.PhysicalResourceId ?? PHYSICAL_ID, Data: {} };
  return { PhysicalResourceId: PHYSICAL_ID, Data: { publicKey: await ensureVapidKeys(store, names) } };
}
