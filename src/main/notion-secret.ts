import { safeStorage } from "electron";

const SAFE_PREFIX = "safe:v1:";
const FALLBACK_PREFIX = "local:v1:";

export function maskNotionToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "••••";
  const prefix = trimmed.slice(0, 4);
  const suffix = trimmed.slice(-4);
  return `${prefix}••••${suffix}`;
}

export function encryptNotionToken(plain: string): string {
  const trimmed = plain.trim();
  if (!trimmed) return "";
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(trimmed);
    return `${SAFE_PREFIX}${encrypted.toString("base64")}`;
  }
  return `${FALLBACK_PREFIX}${Buffer.from(trimmed, "utf8").toString("base64")}`;
}

export function decryptNotionToken(stored: string): string {
  if (!stored) return "";
  if (stored.startsWith(SAFE_PREFIX)) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("系统密钥链当前不可用，无法解密本机 Notion Token。");
    }
    const raw = Buffer.from(stored.slice(SAFE_PREFIX.length), "base64");
    return safeStorage.decryptString(raw);
  }
  if (stored.startsWith(FALLBACK_PREFIX)) {
    return Buffer.from(stored.slice(FALLBACK_PREFIX.length), "base64").toString(
      "utf8",
    );
  }
  return "";
}
