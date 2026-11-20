// @vitest-environment node
import { describe, expect, it } from "vitest";
import { serverUrlSchema } from "../src/shared/sync-contracts";
import { createCommands } from "../src/worker/commands";
import { migrateSchema } from "../src/worker/migrate";
import Database from "better-sqlite3";
import { listChangesSince } from "../src/worker/sync";
import {
  decryptChange,
  deriveSyncKeys,
  encryptChange,
  fromBase64url,
  generateRootKey,
  pairingPayload,
  parsePairingPayload,
  SyncDecryptionError,
  toBase64url,
} from "../src/worker/sync-crypto";

it("derives separate deterministic 32-byte keys and authenticates change identity, version, content and key", async () => {
  const db = new Database(":memory:");
  try {
    migrateSchema(db);
    createCommands(db).createTask({
      commandId: crypto.randomUUID(),
      title: "中文接续",
      note: "私密内容",
    });
    const change = listChangesSince(db).changes[0];
    const root = generateRootKey(),
      keys = await deriveSyncKeys(root);
    const second = await deriveSyncKeys(root);
    expect(second.spaceId).toBe(keys.spaceId);
    expect(second.authKey).toBe(keys.authKey);
    expect(fromBase64url(keys.spaceId)).toHaveLength(32);
    expect(fromBase64url(keys.authKey)).toHaveLength(32);
    expect(keys.spaceId).not.toBe(keys.authKey);
    expect(keys.encKey.extractable).toBe(false);
    const blob = await encryptChange(keys, "device", 17, change);
    expect(await decryptChange(second, "device", 17, blob)).toEqual(change);
    expect(await encryptChange(keys, "device", 17, change)).not.toBe(blob);
    expect(new TextDecoder().decode(fromBase64url(blob))).not.toContain(
      "私密内容",
    );
    await expect(
      decryptChange(
        await deriveSyncKeys(generateRootKey()),
        "device",
        17,
        blob,
      ),
    ).rejects.toBeInstanceOf(SyncDecryptionError);
    await expect(
      decryptChange(keys, "other-device", 17, blob),
    ).rejects.toBeInstanceOf(SyncDecryptionError);
    await expect(
      decryptChange(keys, "device", 18, blob),
    ).rejects.toBeInstanceOf(SyncDecryptionError);
    for (const index of [0, 2, 14, fromBase64url(blob).length - 1]) {
      const bytes = fromBase64url(blob);
      bytes[index] ^= 1;
      await expect(
        decryptChange(keys, "device", 17, toBase64url(bytes)),
      ).rejects.toBeInstanceOf(SyncDecryptionError);
    }
    for (const invalid of ["", "x", "%%%", toBase64url(new Uint8Array(28))])
      await expect(
        decryptChange(keys, "device", 17, invalid),
      ).rejects.toBeInstanceOf(SyncDecryptionError);
  } finally {
    db.close();
  }
});

it("round trips versioned pairing payloads, rejecting invalid roots, versions and URLs", () => {
  const rootKey = generateRootKey();
  const payload = pairingPayload("https://sync.example.com/", rootKey);
  expect(parsePairingPayload(payload)).toEqual({
    serverUrl: "https://sync.example.com",
    rootKey,
  });
  expect(
    parsePairingPayload(pairingPayload("http://localhost:8787", rootKey))
      .rootKey,
  ).toBe(rootKey);
  for (const payload of [
    "",
    "pickup-sync:2:xxx",
    "pickup-sync:1:a",
    "pickup-sync:1:%%%",
    ...[
      { u: "https://example.com", k: "short" },
      { u: "http://example.com", k: rootKey },
      { u: "https://user:pass@example.com", k: rootKey },
      { u: "https://example.com?", k: rootKey },
      { u: "https://example.com#", k: rootKey },
      { u: "https://example.com", k: rootKey, extra: 1 },
      { u: "https://example.com" },
    ].map(
      (value) =>
        "pickup-sync:1:" +
        toBase64url(new TextEncoder().encode(JSON.stringify(value))),
    ),
  ])
    expect(() => parsePairingPayload(payload)).toThrow("配对信息无效");
});

describe("server URL policy", () => {
  it.each([
    ["https://EXAMPLE.com:443/", "https://example.com"],
    ["https://example.com/sync/", "https://example.com/sync"],
    ["https://example.com/path%3F%23/", "https://example.com/path%3F%23"],
  ])("normalizes %s", (input, expected) => {
    expect(serverUrlSchema.parse(input)).toBe(expected);
  });
  it.each([
    "https://example.com",
    "https://example.com/sync/",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://[::1]:8787",
  ])("accepts %s", (value) =>
    expect(serverUrlSchema.safeParse(value).success).toBe(true),
  );
  it.each([
    "",
    "http://example.com",
    "http://localhost.evil.com",
    "file:///data",
    "https://user:pass@example.com",
    "https://example.com?token=secret",
    "https://example.com#fragment",
    "https://example.com?",
    "https://example.com#",
    "https://example.com/sync/?",
    "https://example.com/sync/#",
    "https://example.com?#",
  ])("rejects %s", (value) =>
    expect(serverUrlSchema.safeParse(value).success).toBe(false),
  );
});
