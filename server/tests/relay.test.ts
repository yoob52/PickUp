import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";
import { createRelay } from "../src/relay.js";

const token = randomBytes(48).toString("base64url");
const key = () => randomBytes(32).toString("base64url");
const blob = (value = "opaque ciphertext") =>
  Buffer.from(value).toString("base64url");
type Relay = ReturnType<typeof createRelay>;
const dirs: string[] = [];
const relays: Relay[] = [];
async function start(dir?: string) {
  dir ??= await mkdtemp(join(tmpdir(), "pickup-sync-"));
  if (!dirs.includes(dir)) dirs.push(dir);
  const logs: string[] = [];
  const relay = createRelay(
    readConfig({ PICKUP_REGISTRATION_TOKEN: token, PICKUP_DATA_DIR: dir }),
    (line) => logs.push(line),
  );
  relays.push(relay);
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const origin = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
  async function call(
    path: string,
    auth?: string,
    body?: unknown,
    options: RequestInit = {},
  ) {
    const response = await fetch(origin + path, {
      ...options,
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = response.status === 204 ? null : await response.json();
    return { status: response.status, headers: response.headers, body: value };
  }
  async function space(spaceId = key(), authKey = key()) {
    expect((await call("/v1/spaces", token, { spaceId, authKey })).status).toBe(
      201,
    );
    return { spaceId, authKey, path: `/v1/spaces/${spaceId}/changes` };
  }
  return { relay, origin, dir, logs, call, space };
}
afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("configuration", () => {
  it("refuses missing/short credentials and invalid ports/origins", () => {
    for (const value of [undefined, "short", " ".repeat(32)])
      expect(() => readConfig({ PICKUP_REGISTRATION_TOKEN: value })).toThrow(
        "PICKUP_REGISTRATION_TOKEN",
      );
    expect(() =>
      readConfig({ PICKUP_REGISTRATION_TOKEN: token, PORT: "abc" }),
    ).toThrow("PORT");
    expect(() =>
      readConfig({
        PICKUP_REGISTRATION_TOKEN: token,
        PICKUP_ALLOWED_ORIGINS: "*",
      }),
    ).toThrow("PICKUP_ALLOWED_ORIGINS");
    expect(readConfig({ PICKUP_REGISTRATION_TOKEN: token })).toMatchObject({
      port: 8787,
      dataDir: "/data",
      allowedOrigins: ["https://localhost"],
    });
  });
});

it("serves health and returns structured errors for unknown routes and methods", async () => {
  const s = await start();
  expect((await s.call("/healthz")).body).toEqual({ ok: true });
  expect(await s.call("/unknown")).toMatchObject({
    status: 404,
    body: { error: { code: "NOT_FOUND" } },
  });
  expect(await s.call("/healthz", undefined, {}, {})).toMatchObject({
    status: 405,
    body: { error: { code: "METHOD_NOT_ALLOWED" } },
  });
});

it("authenticates registration, keeps spaces isolated and stores only the key digest", async () => {
  const s = await start();
  const spaceId = key(),
    authKey = key();
  expect(await s.call("/v1/spaces", key(), { spaceId, authKey })).toMatchObject(
    { status: 401, body: { error: { code: "UNAUTHORIZED" } } },
  );
  const a = await s.space(spaceId, authKey),
    b = await s.space();
  expect((await s.call("/v1/spaces", token, { spaceId, authKey })).status).toBe(
    200,
  );
  expect(
    (await s.call("/v1/spaces", token, { spaceId, authKey: key() })).status,
  ).toBe(409);
  for (const invalid of [undefined, key(), b.authKey, token, "bad"])
    expect((await s.call(a.path, invalid)).status).toBe(401);
  expect((await s.call(`/v1/spaces/${key()}/changes`, a.authKey)).status).toBe(
    401,
  );
  expect((await s.call(a.path, a.authKey)).body).toEqual({
    changes: [],
    lastServerSeq: 0,
    more: false,
  });
  const db = new DatabaseSync(join(s.dir, "sync.sqlite"));
  try {
    const row = db
      .prepare("SELECT auth_hash FROM spaces WHERE space_id=?")
      .get(spaceId) as { auth_hash: Uint8Array };
    expect(Buffer.from(row.auth_hash)).toEqual(
      createHash("sha256").update(Buffer.from(authKey, "base64url")).digest(),
    );
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
  } finally {
    db.close();
  }
});

it("idempotently appends opaque bytes, rejects changed identities atomically and sequences independently per space", async () => {
  const s = await start(),
    a = await s.space(),
    b = await s.space();
  const body = {
    deviceId: "device-a",
    changes: [
      { clientSeq: 1, blob: randomBytes(32).toString("base64url") },
      { clientSeq: 2, blob: blob() },
    ],
  };
  expect((await s.call(a.path, a.authKey, body)).body).toEqual({
    accepted: 2,
    lastServerSeq: 2,
  });
  expect((await s.call(a.path, a.authKey, body)).body).toEqual({
    accepted: 0,
    lastServerSeq: 2,
  });
  expect(
    (
      await s.call(a.path, a.authKey, {
        deviceId: "device-a",
        changes: [
          { clientSeq: 3, blob: blob() },
          { clientSeq: 1, blob: blob("changed") },
        ],
      })
    ).status,
  ).toBe(409);
  expect((await s.call(a.path, a.authKey)).body).toEqual({
    changes: body.changes.map((c, i) => ({
      serverSeq: i + 1,
      deviceId: body.deviceId,
      blob: c.blob,
    })),
    lastServerSeq: 2,
    more: false,
  });
  expect(
    (
      await s.call(a.path, a.authKey, {
        deviceId: "device-b",
        changes: [body.changes[0]],
      })
    ).body,
  ).toEqual({ accepted: 1, lastServerSeq: 3 });
  expect((await s.call(b.path, b.authKey, body)).body).toEqual({
    accepted: 2,
    lastServerSeq: 2,
  });
  expect(
    (await s.call(a.path, a.authKey, { deviceId: "device-a", changes: [] }))
      .body,
  ).toEqual({ accepted: 0, lastServerSeq: 3 });
});

it("allocates sequences inside the transaction after a slow upload body completes", async () => {
  const s = await start(),
    a = await s.space();
  const body = JSON.stringify({
    deviceId: "slow",
    changes: [{ clientSeq: 1, blob: blob() }],
  });
  const handled = once(s.relay.server, "request");
  const slow = request(s.origin + a.path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${a.authKey}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  });
  const result = new Promise<{ status: number; body: unknown }>(
    (resolve, reject) => {
      slow.on("error", reject);
      slow.on("response", (response) => {
        let text = "";
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode!, body: JSON.parse(text) }),
        );
      });
    },
  );
  slow.write(body.slice(0, 10));
  await handled;
  expect(
    (
      await s.call(a.path, a.authKey, {
        deviceId: "fast",
        changes: [{ clientSeq: 1, blob: blob() }],
      })
    ).body,
  ).toEqual({ accepted: 1, lastServerSeq: 1 });
  slow.end(body.slice(10));
  expect(await result).toEqual({
    status: 200,
    body: { accepted: 1, lastServerSeq: 2 },
  });
});

it("paginates without skipping events, caps limits and reports an empty final page", async () => {
  const s = await start(),
    a = await s.space();
  await s.call(a.path, a.authKey, {
    deviceId: "a",
    changes: Array.from({ length: 5 }, (_, i) => ({
      clientSeq: i,
      blob: blob(String(i)),
    })),
  });
  const first = await s.call(a.path + "?after=0&limit=2", a.authKey);
  expect(first.body).toMatchObject({ lastServerSeq: 2, more: true });
  expect(
    first.body.changes.map((c: { serverSeq: number }) => c.serverSeq),
  ).toEqual([1, 2]);
  expect(
    (await s.call(a.path + "?after=2&limit=2", a.authKey)).body,
  ).toMatchObject({ lastServerSeq: 4, more: true });
  expect(
    (await s.call(a.path + "?after=4&limit=2", a.authKey)).body,
  ).toMatchObject({ lastServerSeq: 5, more: false });
  expect((await s.call(a.path + "?after=5", a.authKey)).body).toEqual({
    changes: [],
    lastServerSeq: 5,
    more: false,
  });
  for (const query of [
    "limit=501",
    "limit=0",
    "after=-1",
    "after=1e2",
    "after=9007199254740992",
    "limit=1&limit=2",
    "other=1",
  ])
    expect((await s.call(a.path + "?" + query, a.authKey)).status).toBe(400);
});

it("enforces JSON shapes, canonical keys, change counts, blob size and the body limit", async () => {
  const s = await start(),
    a = await s.space();
  for (const body of [
    {},
    { spaceId: "a", authKey: key() },
    { spaceId: key() + "=", authKey: key() },
  ])
    expect((await s.call("/v1/spaces", token, body)).status).toBe(400);
  for (const body of [
    { deviceId: "", changes: [] },
    { deviceId: "d", changes: [{ clientSeq: 1.5, blob: blob() }] },
    { deviceId: "d", changes: [{ clientSeq: 1, blob: "a=" }] },
    {
      deviceId: "d",
      changes: Array.from({ length: 501 }, (_, i) => ({
        clientSeq: i,
        blob: "",
      })),
    },
  ])
    expect((await s.call(a.path, a.authKey, body)).status).toBe(400);
  expect(
    (
      await s.call(a.path, a.authKey, {
        deviceId: "d",
        changes: [
          { clientSeq: 0, blob: Buffer.alloc(65536).toString("base64url") },
        ],
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await s.call(a.path, a.authKey, {
        deviceId: "d",
        changes: [
          { clientSeq: 1, blob: Buffer.alloc(65537).toString("base64url") },
        ],
      })
    ).status,
  ).toBe(413);
  expect(
    (
      await s.call(a.path, a.authKey, {
        deviceId: "d",
        changes: Array.from({ length: 500 }, (_, i) => ({
          clientSeq: i + 1,
          blob: "",
        })),
      })
    ).status,
  ).toBe(200);
  expect(
    (await s.call(a.path, a.authKey, { padding: "a".repeat(1024 * 1024) }))
      .status,
  ).toBe(413);
  const bad = await fetch(s.origin + a.path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${a.authKey}`,
      "Content-Type": "application/json",
    },
    body: "{",
  });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ error: { code: "INVALID_JSON" } });
  expect(
    (
      await fetch(s.origin + a.path, {
        method: "POST",
        headers: { Authorization: `Bearer ${a.authKey}` },
        body: "{}",
      })
    ).status,
  ).toBe(415);
});

it("bounds chunked bodies even without Content-Length", async () => {
  const s = await start(),
    a = await s.space();
  const result = await new Promise<{ status: number; body: unknown }>(
    (resolve, reject) => {
      const req = request(
        s.origin + a.path,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${a.authKey}`,
            "Content-Type": "application/json",
          },
        },
        (response) => {
          let value = "";
          response.on("data", (chunk) => {
            value += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode!, body: JSON.parse(value) }),
          );
        },
      );
      req.on("error", reject);
      req.write(" ".repeat(700000));
      req.end(" ".repeat(700000));
    },
  );
  expect(result).toMatchObject({
    status: 413,
    body: { error: { code: "BODY_TOO_LARGE" } },
  });
});

it("permits only configured CORS origins/preflights and logs route templates without credentials or blobs", async () => {
  const s = await start(),
    a = await s.space();
  const options = {
    method: "OPTIONS",
    headers: {
      Origin: "https://localhost",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Authorization, Content-Type",
    },
  };
  const preflight = await s.call(a.path, undefined, undefined, options);
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe(
    "https://localhost",
  );
  expect(preflight.headers.get("access-control-allow-headers")).toContain(
    "Authorization",
  );
  expect(
    (
      await s.call(a.path, undefined, undefined, {
        ...options,
        headers: { ...options.headers, Origin: "https://evil.invalid" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await s.call(
        a.path,
        a.authKey,
        {
          deviceId: "private-device",
          changes: [{ clientSeq: 0, blob: blob("private-encrypted-payload") }],
        },
        { headers: { Origin: "https://evil.invalid" } },
      )
    ).status,
  ).toBe(403);
  expect((await s.call(a.path, a.authKey)).body.changes).toEqual([]);
  expect(
    (
      await s.call(a.path, a.authKey, undefined, {
        headers: { Origin: "https://localhost" },
      })
    ).headers.get("access-control-allow-origin"),
  ).toBe("https://localhost");
  const logs = s.logs.join("\n");
  for (const secret of [
    token,
    a.authKey,
    a.spaceId,
    "private-device",
    blob("private-encrypted-payload"),
  ])
    expect(logs).not.toContain(secret);
  expect(
    s.logs.every((line) =>
      /^(GET|POST|OPTIONS) \/(?:healthz|v1\/spaces(?:\/:id\/changes)?) \d{3} \d+\.\dms$/.test(
        line,
      ),
    ),
  ).toBe(true);
});

it("persists credentials and ciphertext through a graceful restart", async () => {
  const s = await start(),
    a = await s.space();
  await s.call(a.path, a.authKey, {
    deviceId: "persist",
    changes: [{ clientSeq: 1, blob: blob() }],
  });
  await s.relay.close();
  const second = await start(s.dir);
  expect((await second.call(a.path, a.authKey)).body).toEqual({
    changes: [{ serverSeq: 1, deviceId: "persist", blob: blob() }],
    lastServerSeq: 1,
    more: false,
  });
  expect(
    (
      await second.call(a.path, a.authKey, {
        deviceId: "persist",
        changes: [{ clientSeq: 1, blob: blob() }],
      })
    ).body,
  ).toEqual({ accepted: 0, lastServerSeq: 1 });
});
