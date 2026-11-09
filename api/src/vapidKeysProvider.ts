// Lambda entry for the VapidKeys custom resource (AppStack). Logic and tests: vapid.ts.
// Logs nothing: the event carries no secrets, but the private key passes through this process.
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { onVapidKeysEvent, type ParamStore, type VapidKeysEvent } from "./vapid";

const ssm = new SSMClient({});

const store: ParamStore = {
  async get(name, opts) {
    try {
      const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: opts?.decrypt ?? false }));
      return out.Parameter?.Value;
    } catch (e) {
      if ((e as Error).name === "ParameterNotFound") return undefined;
      throw e;
    }
  },
  async create(name, value, secure) {
    // Overwrite: false makes SSM itself refuse to replace an existing key.
    await ssm.send(new PutParameterCommand({
      Name: name, Value: value, Type: secure ? "SecureString" : "String", Overwrite: false,
      Description: secure
        ? "Throne Web Push VAPID private key (read by the Notifier only)"
        : "Throne Web Push VAPID public key (served to the app in config.json)",
    }));
  },
};

export async function handler(event: VapidKeysEvent) {
  try {
    return await onVapidKeysEvent(event, store, {
      private: process.env.VAPID_PRIVATE_PARAM!,
      public: process.env.VAPID_PUBLIC_PARAM!,
    });
  } catch (e) {
    // Rethrow name and message only, never the SDK error object (its request would carry the key).
    throw new Error(`${(e as Error).name}: ${(e as Error).message}`);
  }
}
