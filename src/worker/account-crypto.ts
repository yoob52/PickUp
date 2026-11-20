import { z } from "zod";
import { DomainError } from "./errors";
import { fromBase64url, toBase64url, generateRootKey } from "./sync-crypto";
import { serverUrlSchema } from "../shared/sync-contracts";

const text = new TextEncoder();
export const randomKey = generateRootKey;
async function derive(material: CryptoKey, name: string) {
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: text.encode("pickup-account:1"),
        info: text.encode(name),
      },
      material,
      256,
    ),
  );
}
export async function passwordKeys(password: string, salt: string) {
  const source = await crypto.subtle.importKey(
    "raw",
    text.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const master = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: fromBase64url(salt),
      iterations: 600000,
    },
    source,
    256,
  );
  return accountKeys(new Uint8Array(master));
}
async function accountKeys(bytes: Uint8Array<ArrayBuffer>) {
  const material = await crypto.subtle.importKey("raw", bytes, "HKDF", false, [
    "deriveBits",
  ]);
  const authKey = toBase64url(await derive(material, "authKey"));
  const kek = await crypto.subtle.importKey(
    "raw",
    await derive(material, "kek"),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  return { authKey, kek };
}
export async function recoveryKeys(code: string) {
  if (!code.startsWith("pickup-recovery:1:"))
    throw DomainError.validation("恢复码格式无效。");
  const bytes = fromBase64url(code.slice(18));
  if (bytes.length !== 32) throw DomainError.validation("恢复码格式无效。");
  return accountKeys(bytes);
}
export const recoveryCode = () => "pickup-recovery:1:" + randomKey();
export async function seal(
  key: CryptoKey,
  value: unknown,
  context: string,
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: text.encode(context) },
      key,
      text.encode(JSON.stringify(value)),
    ),
  );
  const result = new Uint8Array(12 + encrypted.length);
  result.set(nonce);
  result.set(encrypted, 12);
  return toBase64url(result);
}
export async function unseal(
  key: CryptoKey,
  value: string,
  context: string,
): Promise<unknown> {
  try {
    const bytes = fromBase64url(value);
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.slice(0, 12),
        additionalData: text.encode(context),
      },
      key,
      bytes.slice(12),
    );
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plain),
    ) as unknown;
  } catch {
    throw new DomainError(
      "SYNC_ERROR",
      "账户密钥解密失败，请检查密码或恢复码。",
      false,
    );
  }
}
const encodedKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const rootKeySchema = encodedKey.refine(
  (value) => fromBase64url(value).length === 32,
);
const publicKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => {
    const b = fromBase64url(value);
    return b.length === 65 && b[0] === 4;
  });
const handoffSchema = z.strictObject({
  server: serverUrlSchema,
  requestId: encodedKey,
  pubkey: publicKey,
  expiresAt: z.number().int().positive(),
});
export type HandoffQR = z.infer<typeof handoffSchema>;
export function handoffPayload(value: HandoffQR) {
  return (
    "pickup-login:1:" +
    toBase64url(text.encode(JSON.stringify(handoffSchema.parse(value))))
  );
}
export function parseHandoff(value: string): HandoffQR {
  try {
    if (!value.startsWith("pickup-login:1:") || value.length > 4096)
      throw new Error("version");
    const input = handoffSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          fromBase64url(value.slice(15)),
        ),
      ),
    );
    if (input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 125000)
      throw new Error("expired");
    return input;
  } catch {
    throw DomainError.validation("扫码登录请求无效或已过期，请重新生成。");
  }
}
export async function ecdhKeyPair() {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
}
export async function exportPublic(key: CryptoKey) {
  return toBase64url(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}
export async function handoffKey(
  privateKey: CryptoKey,
  publicKey: string,
  requestId: string,
) {
  const pub = await crypto.subtle.importKey(
    "raw",
    fromBase64url(publicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: pub },
    privateKey,
    256,
  );
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: text.encode(requestId),
      info: text.encode("pickup-handoff:1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
