import { safeStorage } from "electron";

const SAFE_PREFIX = "safe:v1:";

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
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("系统密钥链当前不可用，无法安全加密保存 Notion Token。");
  }
  const encrypted = safeStorage.encryptString(trimmed);
  return `${SAFE_PREFIX}${encrypted.toString("base64")}`;
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
  throw new Error("本机保存的 Notion Token 格式不受支持，请重新配置。");
}
