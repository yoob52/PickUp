import { z } from "zod";
import { serverUrlSchema } from "../shared/sync-contracts";
import { DomainError } from "./errors";
import { syncChangeSchema, type SyncChange } from "./sync";

const text = new TextEncoder();
export function toBase64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value))
    throw DomainError.validation("无效的 base64url 数据。");
  const bytes = Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (char) => char.charCodeAt(0),
  );
  if (toBase64url(bytes) !== value)
    throw DomainError.validation("无效的 base64url 数据。");
  return bytes;
}
const rootSchema = z.string().refine((value) => {
  try {
    return fromBase64url(value).length === 32;
  } catch {
    return false;
  }
});
const pairingSchema = z.strictObject({ u: serverUrlSchema, k: rootSchema });
export function parsePairingPayload(payload: string): {
  serverUrl: string;
  rootKey: string;
} {
  try {
    if (!payload.startsWith("pickup-sync:1:") || payload.length > 8192)
      throw new Error("version");
    const value = pairingSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          fromBase64url(payload.slice(14)),
        ),
      ),
    );
    return { serverUrl: value.u, rootKey: value.k };
  } catch {
    throw DomainError.validation("配对信息无效或版本不受支持。");
  }
}
export function pairingPayload(serverUrl: string, rootKey: string): string {
  const value = pairingSchema.parse({ u: serverUrl, k: rootKey });
  return "pickup-sync:1:" + toBase64url(text.encode(JSON.stringify(value)));
}
export const generateRootKey = () =>
  toBase64url(crypto.getRandomValues(new Uint8Array(32)));
export async function deriveSyncKeys(rootKey: string) {
  const root = rootSchema.parse(rootKey);
  const material = await crypto.subtle.importKey(
    "raw",
    fromBase64url(root),
    "HKDF",
    false,
    ["deriveBits", "deriveKey"],
  );
  const params = (name: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: text.encode("pickup-sync:1"),
    info: text.encode(`pickup-sync:1:${name}`),
  });
  const spaceId = toBase64url(
    new Uint8Array(
      await crypto.subtle.deriveBits(params("spaceId"), material, 256),
    ),
  );
  const authKey = toBase64url(
    new Uint8Array(
      await crypto.subtle.deriveBits(params("authKey"), material, 256),
    ),
  );
  const encKey = await crypto.subtle.deriveKey(
    params("encKey"),
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { spaceId, authKey, encKey };
}
export type SyncKeys = Awaited<ReturnType<typeof deriveSyncKeys>>;
export class SyncDecryptionError extends DomainError {
  constructor() {
    super("SYNC_ERROR", "同步密文校验失败，未应用任何变更。", false);
  }
}
const aad = (spaceId: string, deviceId: string, clientSeq: number) =>
  text.encode(`${spaceId}:${deviceId}:${clientSeq}`);
export async function encryptChange(
  keys: SyncKeys,
  deviceId: string,
  clientSeq: number,
  change: SyncChange,
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: aad(keys.spaceId, deviceId, clientSeq),
      },
      keys.encKey,
      text.encode(JSON.stringify(change)),
    ),
  );
  const blob = new Uint8Array(14 + encrypted.length);
  blob.set(text.encode("v1"));
  blob.set(nonce, 2);
  blob.set(encrypted, 14);
  return toBase64url(blob);
}
export async function decryptChange(
  keys: SyncKeys,
  deviceId: string,
  clientSeq: number,
  blob: string,
): Promise<SyncChange> {
  try {
    const bytes = fromBase64url(blob);
    if (bytes.length < 30 || bytes[0] !== 118 || bytes[1] !== 49)
      throw new Error("version");
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.slice(2, 14),
        additionalData: aad(keys.spaceId, deviceId, clientSeq),
      },
      keys.encKey,
      bytes.slice(14),
    );
    return syncChangeSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
    );
  } catch {
    throw new SyncDecryptionError();
  }
}
