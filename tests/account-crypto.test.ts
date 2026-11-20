// @vitest-environment node
import { expect, it } from "vitest";
import {
  passwordKeys,
  randomKey,
  recoveryCode,
  recoveryKeys,
  seal,
  unseal,
  ecdhKeyPair,
  exportPublic,
  handoffKey,
  handoffPayload,
  parseHandoff,
} from "../src/worker/account-crypto";
it("derives stable password keys with separated authentication/encryption, rejects wrong passwords, salts, context and corruption", async () => {
  const salt = randomKey(),
    a = await passwordKeys("a strong passphrase", salt),
    b = await passwordKeys("a strong passphrase", salt);
  expect(a.authKey).toBe(b.authKey);
  expect(a.kek.extractable).toBe(false);
  const root = randomKey(),
    wrapped = await seal(a.kek, root, "email@example.com");
  expect(await unseal(b.kek, wrapped, "email@example.com")).toBe(root);
  const wrong = await passwordKeys("wrong password!", salt),
    other = await passwordKeys("a strong passphrase", randomKey());
  expect(wrong.authKey).not.toBe(a.authKey);
  expect(other.authKey).not.toBe(a.authKey);
  for (const [key, blob, context] of [
    [wrong.kek, wrapped, "email@example.com"],
    [other.kek, wrapped, "email@example.com"],
    [a.kek, wrapped, "other@example.com"],
    [
      a.kek,
      (wrapped[0] === "A" ? "B" : "A") + wrapped.slice(1),
      "email@example.com",
    ],
  ] as const)
    await expect(unseal(key, blob, context)).rejects.toThrow();
});
it("wraps the same root independently with a recovery code", async () => {
  const code = recoveryCode(),
    keys = await recoveryKeys(code),
    root = randomKey();
  const wrapped = await seal(keys.kek, root, "recovery");
  expect(
    await unseal((await recoveryKeys(code)).kek, wrapped, "recovery"),
  ).toBe(root);
  await expect(
    unseal((await recoveryKeys(recoveryCode())).kek, wrapped, "recovery"),
  ).rejects.toThrow();
  await expect(recoveryKeys("")).rejects.toThrow();
});
it("binds ECDH handoff encryption to the intended desktop and request, validates QR expiry and rejects substitution", async () => {
  const desktop = await ecdhKeyPair(),
    phone = await ecdhKeyPair(),
    attacker = await ecdhKeyPair(),
    id = randomKey();
  const target = await exportPublic(desktop.publicKey),
    source = await exportPublic(phone.publicKey);
  const qr = handoffPayload({
    server: "https://pickup.example.com",
    requestId: id,
    pubkey: target,
    expiresAt: Date.now() + 120000,
  });
  expect(parseHandoff(qr).requestId).toBe(id);
  const key = await handoffKey(phone.privateKey, target, id),
    encrypted = await seal(key, { rootKey: randomKey() }, id);
  expect(
    await unseal(
      await handoffKey(desktop.privateKey, source, id),
      encrypted,
      id,
    ),
  ).toHaveProperty("rootKey");
  await expect(
    unseal(await handoffKey(attacker.privateKey, source, id), encrypted, id),
  ).rejects.toThrow();
  await expect(
    unseal(
      await handoffKey(desktop.privateKey, source, randomKey()),
      encrypted,
      id,
    ),
  ).rejects.toThrow();
  expect(() => parseHandoff("bad")).toThrow();
  expect(() =>
    parseHandoff(
      handoffPayload({
        server: "https://pickup.example.com",
        requestId: id,
        pubkey: target,
        expiresAt: Date.now() - 1,
      }),
    ),
  ).toThrow();
});
