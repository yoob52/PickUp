import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createRelay } from "../src/relay.js";
import { readConfig } from "../src/config.js";

const key = () => randomBytes(32).toString("base64url");
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function start(quota = 20 * 1024 * 1024, trustedProxies = "") {
  const dir = await mkdtemp(join(tmpdir(), "pickup-accounts-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  let now = Date.now();
  const relay = createRelay(
    readConfig({
      PICKUP_DATA_DIR: dir,
      PICKUP_ACCOUNT_QUOTA_BYTES: String(quota),
      PICKUP_TRUSTED_PROXIES: trustedProxies,
    }),
    () => {},
    () => now,
  );
  cleanup.push(() => relay.close());
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const url = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
  const call = async (
    path: string,
    body?: unknown,
    token?: string,
    forwarded?: string,
  ) => {
    const r = await fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(forwarded ? { "X-Real-IP": forwarded } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  async function register(email = "person@example.com") {
    const salt = (await call("/v1/accounts/prelogin", { email })).body
      .salt as string;
    const input = {
      email,
      salt,
      authKey: key(),
      spaceId: key(),
      spaceAuthKey: key(),
      wrappedRootKey: "A".repeat(100),
      recoveryAuthKey: key(),
      recoveryWrappedRootKey: "B".repeat(100),
    };
    const result = await call("/v1/accounts", input);
    expect(result.status).toBe(200);
    return { ...input, token: result.body.sessionToken as string };
  }
  return {
    call,
    register,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
it("registers openly, gives stable indistinguishable prelogin salts, normalizes email and logs out", async () => {
  const s = await start();
  expect((await s.call("/v1/accounts/prelogin", { email: "bad" })).status).toBe(
    400,
  );
  const before = await s.call("/v1/accounts/prelogin", {
    email: "Person@Example.com",
  });
  const a = await s.register();
  expect(
    await s.call("/v1/accounts/prelogin", { email: "person@example.com" }),
  ).toEqual(before);
  const fake = await s.call("/v1/accounts/prelogin", {
    email: "unknown@example.com",
  });
  expect(fake.status).toBe(before.status);
  expect(Object.keys(fake.body)).toEqual(["salt"]);
  expect(fake.body.salt).toHaveLength(43);
  expect(
    await s.call("/v1/accounts/prelogin", { email: "unknown@example.com" }),
  ).toEqual(fake);
  const bad = await s.call("/v1/accounts/login", {
    email: a.email,
    authKey: key(),
  });
  expect(
    await s.call("/v1/accounts/login", {
      email: "unknown@example.com",
      authKey: key(),
    }),
  ).toEqual(bad);
  const login = await s.call("/v1/accounts/login", {
    email: "PERSON@example.com",
    authKey: a.authKey,
  });
  expect(login.status).toBe(200);
  expect(login.body.wrappedRootKey).toBe(a.wrappedRootKey);
  const path = `/v1/spaces/${a.spaceId}/changes`;
  expect((await s.call(path, undefined, login.body.sessionToken)).status).toBe(
    200,
  );
  const other = await s.register("other@example.com");
  expect((await s.call(path, undefined, other.token)).status).toBe(401);
  expect(
    (await s.call("/v1/accounts/logout", {}, login.body.sessionToken)).status,
  ).toBe(200);
  expect((await s.call(path, undefined, login.body.sessionToken)).status).toBe(
    401,
  );
});
it("locks unknown and existing emails with the same backoff and rate limits registrations by IP", async () => {
  const s = await start(),
    a = await s.register();
  for (let i = 0; i < 5; i++)
    expect(
      (await s.call("/v1/accounts/login", { email: a.email, authKey: key() }))
        .status,
    ).toBe(401);
  expect(
    (await s.call("/v1/accounts/login", { email: a.email, authKey: a.authKey }))
      .status,
  ).toBe(429);
  s.advance(5001);
  expect(
    (await s.call("/v1/accounts/login", { email: a.email, authKey: a.authKey }))
      .status,
  ).toBe(200);
  for (let i = 0; i < 5; i++)
    expect(
      (
        await s.call("/v1/accounts/login", {
          email: "unknown@example.com",
          authKey: key(),
        })
      ).status,
    ).toBe(401);
  expect(
    (
      await s.call("/v1/accounts/login", {
        email: "unknown@example.com",
        authKey: key(),
      })
    ).status,
  ).toBe(429);
  s.advance(5001);
  expect(
    (
      await s.call("/v1/accounts/login", {
        email: "unknown@example.com",
        authKey: key(),
      })
    ).status,
  ).toBe(401);
  s.advance(5001);
  expect(
    (
      await s.call("/v1/accounts/login", {
        email: "unknown@example.com",
        authKey: key(),
      })
    ).status,
  ).toBe(429);
  s.advance(5001);
  expect(
    (
      await s.call("/v1/accounts/login", {
        email: "unknown@example.com",
        authKey: key(),
      })
    ).status,
  ).toBe(401);
  for (let i = 0; i < 4; i++) await s.register(`person${i}@example.com`);
  expect((await s.call("/v1/accounts", {})).status).toBe(429);
});
it("enforces account quota transactionally, including the legacy pairing credential, without charging duplicates", async () => {
  const s = await start(10),
    a = await s.register(),
    path = `/v1/spaces/${a.spaceId}/changes`;
  const change = {
    deviceId: "one",
    changes: [
      { clientSeq: 1, blob: Buffer.from("12345678").toString("base64url") },
    ],
  };
  expect((await s.call(path, change, a.token)).status).toBe(200);
  expect((await s.call(path, change, a.token)).body.accepted).toBe(0);
  expect(
    (
      await s.call(
        path,
        { ...change, changes: [{ ...change.changes[0], clientSeq: 2 }] },
        a.spaceAuthKey,
      )
    ).body.error.code,
  ).toBe("QUOTA_EXCEEDED");
  expect((await s.call(path, undefined, a.token)).body.changes).toHaveLength(1);
  expect(
    (
      await s.call(
        path,
        {
          deviceId: "one",
          changes: [
            { clientSeq: 2, blob: Buffer.from("a").toString("base64url") },
            { clientSeq: 3, blob: change.changes[0].blob },
          ],
        },
        a.token,
      )
    ).status,
  ).toBe(413);
  expect((await s.call(path, undefined, a.token)).body.changes).toHaveLength(1);
  expect(
    (
      await s.call(
        path,
        {
          deviceId: "one",
          changes: [
            { clientSeq: 2, blob: Buffer.from("ab").toString("base64url") },
          ],
        },
        a.token,
      )
    ).status,
  ).toBe(200);
});
it("ignores spoofed forwarding headers unless the exact socket peer is trusted", async () => {
  const direct = await start();
  for (let i = 0; i < 5; i++)
    expect(
      (await direct.call("/v1/accounts", {}, undefined, `192.0.2.${i + 1}`))
        .status,
    ).toBe(400);
  expect(
    (await direct.call("/v1/accounts", {}, undefined, "192.0.2.20")).status,
  ).toBe(429);
  const proxied = await start(20 * 1024 * 1024, "127.0.0.1");
  for (let i = 0; i < 5; i++)
    expect(
      (await proxied.call("/v1/accounts", {}, undefined, "192.0.2.1")).status,
    ).toBe(400);
  expect(
    (await proxied.call("/v1/accounts", {}, undefined, "192.0.2.1")).status,
  ).toBe(429);
  expect(
    (await proxied.call("/v1/accounts", {}, undefined, "192.0.2.2")).status,
  ).toBe(400);
});
it("requires recovery proof, preserves encrypted recovery wrapping and revokes sessions on reset", async () => {
  const s = await start(),
    a = await s.register();
  expect(
    (
      await s.call("/v1/accounts/recover", {
        action: "read",
        email: a.email,
        recoveryAuthKey: key(),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await s.call("/v1/accounts/recover", {
        action: "read",
        email: a.email,
        recoveryAuthKey: a.recoveryAuthKey,
      })
    ).body.wrappedRootKey,
  ).toBe(a.recoveryWrappedRootKey);
  const next = {
    action: "reset",
    email: a.email,
    recoveryAuthKey: a.recoveryAuthKey,
    salt: key(),
    authKey: key(),
    wrappedRootKey: "C".repeat(100),
  };
  const reset = await s.call("/v1/accounts/recover", next);
  expect(reset.status).toBe(200);
  expect(
    (await s.call(`/v1/spaces/${a.spaceId}/changes`, undefined, a.token))
      .status,
  ).toBe(401);
  expect(
    (await s.call("/v1/accounts/login", { email: a.email, authKey: a.authKey }))
      .status,
  ).toBe(401);
  expect(
    (
      await s.call("/v1/accounts/login", {
        email: a.email,
        authKey: next.authKey,
      })
    ).body.wrappedRootKey,
  ).toBe(next.wrappedRootKey);
  expect(
    (await s.call("/v1/accounts/prelogin", { email: a.email })).body.salt,
  ).toBe(next.salt);
});
it("keeps handoff opaque, authenticates writes and private polling, expires in two minutes and consumes exactly once", async () => {
  const s = await start(),
    a = await s.register();
  const slot = (await s.call("/v1/handoff", {})).body;
  const path = "/v1/handoff/" + slot.requestId;
  expect((await s.call(path, undefined, slot.requestId)).status).toBe(401);
  expect((await s.call(path, undefined, slot.pollToken)).body).toEqual({
    pending: true,
  });
  expect((await s.call(path, { ciphertext: "A".repeat(100) })).status).toBe(
    401,
  );
  expect(
    (await s.call(path, { ciphertext: "A".repeat(100) }, a.token)).status,
  ).toBe(200);
  expect(
    (await s.call(path, { ciphertext: "B".repeat(100) }, a.token)).status,
  ).toBe(409);
  expect((await s.call(path, undefined, slot.pollToken)).body).toEqual({
    ciphertext: "A".repeat(100),
  });
  expect((await s.call(path, undefined, slot.pollToken)).status).toBe(410);
  const expired = (await s.call("/v1/handoff", {})).body;
  s.advance(120001);
  expect(
    (
      await s.call(
        "/v1/handoff/" + expired.requestId,
        undefined,
        expired.pollToken,
      )
    ).status,
  ).toBe(410);
});
