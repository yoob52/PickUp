// @vitest-environment node
import Database from "better-sqlite3";
import initSqlite from "@sqlite.org/sqlite-wasm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommands } from "../src/worker/commands";
import { migrateSchema } from "../src/worker/migrate";
import { createQueries } from "../src/worker/queries";
import { SyncClient, syncBackoff } from "../src/worker/sync-client";
import {
  deriveSyncKeys,
  encryptChange,
  generateRootKey,
  parsePairingPayload,
  SyncDecryptionError,
} from "../src/worker/sync-crypto";
import { listChangesSince } from "../src/worker/sync";
import type { SqliteDatabase } from "../src/worker/sqlite";
import { SqliteWasmDriver } from "../src/worker/sqlite-wasm-driver";
import { startSyncRelay } from "./sync-relay";

const sqlite = await initSqlite();
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
function open(wasm = false): SqliteDatabase {
  const db = wasm
    ? new SqliteWasmDriver(new sqlite.oo1.DB(":memory:", "c"))
    : new Database(":memory:");
  cleanup.push(() => {
    db.close();
  });
  migrateSchema(db);
  return db;
}
function client(
  db: SqliteDatabase,
  fetcher: typeof fetch = fetch,
  changed = vi.fn(),
) {
  const sync = new SyncClient(db, changed, fetcher);
  cleanup.push(() => sync.close());
  return sync;
}
function create(db: SqliteDatabase, title = "未完的事", note = "") {
  return createCommands(db).createTask({
    commandId: crypto.randomUUID(),
    title,
    note,
  }).value.taskId;
}
function ref(db: SqliteDatabase, taskId: string) {
  return {
    taskId,
    expectedVersion: (
      db.prepare("SELECT version FROM tasks WHERE id=?").get(taskId) as {
        version: number;
      }
    ).version,
  };
}
function seed(db: SqliteDatabase, url: string, root = generateRootKey()) {
  db.prepare(
    "INSERT INTO sync_config(singleton,server_url,root_key) VALUES(1,?,?)",
  ).run(url, root);
}
const cursor = (db: SqliteDatabase) =>
  db.prepare("SELECT pushed_cursor,pulled_cursor FROM sync_config").get() as {
    pushed_cursor: number;
    pulled_cursor: number;
  };
const state = (db: SqliteDatabase) => ({
  tasks: db
    .prepare(
      "SELECT id,title,note,status,status_changed_at,ended_at,content_hlc,status_hlc FROM tasks ORDER BY id",
    )
    .all(),
  history: db
    .prepare(
      "SELECT id,hlc,payload FROM sync_changes WHERE entity='transition' ORDER BY id",
    )
    .all(),
});
async function relay() {
  const relay = await startSyncRelay();
  cleanup.push(() => relay.close());
  return relay;
}

it("converges a native store and a WASM store through the real encrypted relay, including concurrent doing", async () => {
  const server = await relay(),
    a = open(),
    b = open(true),
    broadcast = vi.fn();
  const first = client(a),
    second = client(b, fetch, broadcast);
  const firstId = create(a, "电脑记录"),
    secondId = create(b, "移动端记录");
  expect(first.status().enabled).toBe(false);
  expect(() => first.pairing()).toThrow("请先启用同步");
  await expect(first.syncNow()).rejects.toThrow("请先启用同步");
  await first.enable({
    serverUrl: server.url,
    registrationToken: server.token,
  });
  const pairing = parsePairingPayload(first.pairing());
  seed(b, pairing.serverUrl, pairing.rootKey);
  expect(a.prepare("SELECT id FROM sync_device").get()).not.toEqual(
    b.prepare("SELECT id FROM sync_device").get(),
  );
  await first.syncNow();
  await second.syncNow();
  await first.syncNow();
  await second.syncNow();
  createCommands(a).startTask({
    commandId: crypto.randomUUID(),
    task: ref(a, firstId),
  });
  createCommands(b).startTask({
    commandId: crypto.randomUUID(),
    task: ref(b, secondId),
  });
  createCommands(a).updateTask({
    commandId: crypto.randomUUID(),
    ...ref(a, firstId),
    title: "电脑已编辑",
  });
  createCommands(b).updateTask({
    commandId: crypto.randomUUID(),
    ...ref(b, secondId),
    title: "移动端记录",
    note: "手机已编辑",
  });
  for (let round = 0; round < 3; round++) {
    await first.syncNow();
    await second.syncNow();
  }
  expect(state(a)).toEqual(state(b));
  expect(
    a.prepare("SELECT count(*) AS n FROM tasks WHERE status='doing'").get(),
  ).toEqual({ n: 1 });
  expect(
    a.prepare("SELECT count(*) AS n FROM tasks WHERE status='paused'").get(),
  ).toEqual({ n: 1 });
  expect(broadcast).toHaveBeenCalled();
  const before = cursor(a);
  const empty = await first.syncNow();
  expect(empty).toMatchObject({ running: false, error: null, stopped: false });
  expect(empty.lastSuccess).toBeTypeOf("number");
  expect(cursor(a)).toEqual(before);
  expect(
    JSON.stringify(a.prepare("SELECT * FROM sync_config").get()),
  ).not.toContain(server.token);
  const events = a.prepare("SELECT count(*) AS n FROM sync_changes").get();
  await first.disable();
  expect(first.status().enabled).toBe(false);
  expect(a.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 2 });
  expect(a.prepare("SELECT count(*) AS n FROM sync_changes").get()).toEqual(
    events,
  );
  expect(() => first.pairing()).toThrow();
});

it("reuses persisted ciphertext after a lost upload response, including a client restart", async () => {
  const server = await relay(),
    db = open();
  let lose = true;
  const bodies: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith("/changes") && options?.method === "POST") {
      bodies.push(String(options.body));
      if (lose) {
        lose = false;
        throw new TypeError("lost response");
      }
    }
    return response;
  };
  const first = client(db, fetcher);
  create(db);
  const outbox = listChangesSince(db, 0, 1000);
  await first.enable({
    serverUrl: server.url,
    registrationToken: server.token,
  });
  await expect(first.syncNow()).rejects.toThrow("同步请求失败");
  expect(cursor(db).pushed_cursor).toBe(0);
  expect(db.prepare("SELECT count(*) AS n FROM sync_uploads").get()).toEqual({
    n: outbox.changes.length,
  });
  await first.close();
  const next = client(db, fetcher);
  await next.syncNow();
  expect(bodies[1]).toBe(bodies[0]);
  expect(cursor(db).pushed_cursor).toBe(outbox.cursor);
  expect(db.prepare("SELECT count(*) AS n FROM sync_uploads").get()).toEqual({
    n: outbox.changes.length,
  });
});

describe.each([false, true])("%s WASM transactional pull", (wasm) => {
  it("restarts a pre-anchor cursor safely and keeps N=0 without an anchor", async () => {
    const db = open(wasm);
    seed(db, "https://relay.example.com");
    db.prepare("UPDATE sync_config SET pulled_cursor=7,pushed_cursor=7").run();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ changes: [], lastServerSeq: 0, more: false }),
      );
    const sync = client(db, fetcher);
    await sync.syncNow();
    expect(cursor(db)).toEqual({ pushed_cursor: 0, pulled_cursor: 0 });
    expect(
      db
        .prepare("SELECT pulled_device_id,pulled_client_seq FROM sync_config")
        .get(),
    ).toEqual({ pulled_device_id: null, pulled_client_seq: null });
    await sync.syncNow();
    expect(warning).toHaveBeenCalledTimes(1);
    for (const [url] of fetcher.mock.calls)
      expect(String(url)).toContain("after=0&");
  });
  it.each([false, true])(
    "replays identical ciphertext after restoring an older relay backup (refilled: %s)",
    async (refilled) => {
      const server = await relay(),
        a = open(wasm),
        b = open(!wasm);
      const first = client(a),
        second = client(b);
      create(a, "备份中的任务");
      await first.enable({
        serverUrl: server.url,
        registrationToken: server.token,
      });
      const pairing = parsePairingPayload(first.pairing());
      const keys = await deriveSyncKeys(pairing.rootKey);
      seed(b, server.url, pairing.rootKey);
      await first.syncNow();
      await second.syncNow();
      await first.syncNow();
      const snapshot = await server.backup();
      create(a, "备份后的电脑任务");
      create(b, "备份后的另一设备任务");
      for (let i = 0; i < 3; i++) {
        await first.syncNow();
        await second.syncNow();
      }
      const download = async () => {
        const response = await fetch(
          `${server.url}/v1/spaces/${keys.spaceId}/changes?limit=500`,
          { headers: { Authorization: `Bearer ${keys.authKey}` } },
        );
        const page = (await response.json()) as {
          changes: { deviceId: string; clientSeq: number; blob: string }[];
        };
        return page.changes
          .map(({ deviceId, clientSeq, blob }) => ({
            deviceId,
            clientSeq,
            blob,
          }))
          .sort(
            (a, b) =>
              a.deviceId.localeCompare(b.deviceId) || a.clientSeq - b.clientSeq,
          );
      };
      const before = await download();
      const oldCursor = cursor(a).pulled_cursor;
      await server.restore(snapshot);
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      if (refilled) {
        await second.syncNow();
        create(b, "另一设备重新填满中继");
        await second.syncNow();
        expect((await download()).length).toBeGreaterThanOrEqual(oldCursor);
        create(a, "恢复期间待上传的任务");
        warning.mockClear();
      }
      await first.syncNow();
      expect(warning).toHaveBeenCalledWith("sync-relay-continuity-reset");
      for (let i = 0; i < 3; i++) {
        await first.syncNow();
        await second.syncNow();
      }
      const restored = await download();
      for (const change of before) expect(restored).toContainEqual(change);
      if (!refilled) expect(restored).toEqual(before);
      create(a, "恢复后继续记录");
      for (let i = 0; i < 2; i++) {
        await first.syncNow();
        await second.syncNow();
      }
      expect(state(a)).toEqual(state(b));
      expect(createQueries(b).workspaceSnapshot().counts.todo).toBe(
        refilled ? 6 : 4,
      );
    },
  );
  it("never applies a partial page or advances the cursor on invalid ciphertext", async () => {
    const db = open(wasm),
      source = open(wasm),
      root = generateRootKey(),
      keys = await deriveSyncKeys(root);
    seed(db, "https://relay.example.com", root);
    create(source);
    const changes = listChangesSince(source).changes;
    const good = await encryptChange(keys, "remote", 1, changes[0]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        changes: [
          { serverSeq: 1, deviceId: "remote", clientSeq: 1, blob: good },
          { serverSeq: 2, deviceId: "remote", clientSeq: 2, blob: "bad" },
        ],
        lastServerSeq: 2,
        more: false,
      }),
    );
    const sync = client(db, fetcher);
    await expect(sync.syncNow()).rejects.toBeInstanceOf(SyncDecryptionError);
    expect(cursor(db).pulled_cursor).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({
      n: 0,
    });
  });
  it("rolls back remote materialization if cursor persistence fails", async () => {
    const db = open(wasm),
      source = open(wasm),
      root = generateRootKey(),
      keys = await deriveSyncKeys(root);
    seed(db, "https://relay.example.com", root);
    create(source);
    const blob = await encryptChange(
      keys,
      "remote",
      1,
      listChangesSince(source).changes[0],
    );
    db.exec(
      "CREATE TRIGGER cursor_failure BEFORE UPDATE OF pulled_cursor ON sync_config BEGIN SELECT RAISE(ABORT,'cursor failure'); END",
    );
    const sync = client(
      db,
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          changes: [{ serverSeq: 1, deviceId: "remote", clientSeq: 1, blob }],
          lastServerSeq: 1,
          more: false,
        }),
      ),
    );
    await expect(sync.syncNow()).rejects.toThrow("cursor failure");
    expect(cursor(db).pulled_cursor).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({
      n: 0,
    });
    expect(listChangesSince(db).changes).toEqual([]);
  });
});

it.each([401, 403])(
  "stops automatically on %i, persists re-pair status and never retries",
  async (status) => {
    vi.useFakeTimers();
    const db = open();
    seed(db, "https://relay.example.com");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status }));
    const sync = client(db, fetcher);
    sync.start();
    await expect(sync.syncNow()).rejects.toThrow("需要重新配对");
    expect(sync.status()).toMatchObject({
      stopped: true,
      error: "需要重新配对",
      retryAt: null,
    });
    create(db);
    sync.localCommitted();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(sync.syncNow()).rejects.toThrow("需要重新配对");
  },
);

it("debounces committed changes, runs every minute, prevents overlapping cycles and resets bounded backoff", async () => {
  vi.useFakeTimers();
  const db = open();
  seed(db, "https://relay.example.com");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url, options) =>
      options?.method === "POST"
        ? Response.json({
            accepted: (
              JSON.parse(String(options.body)) as { changes: unknown[] }
            ).changes.length,
            lastServerSeq: 0,
          })
        : Response.json({
            changes: [],
            lastServerSeq: Number(
              new URL(String(url)).searchParams.get("after"),
            ),
            more: false,
          }),
    );
  const sync = client(db, fetcher);
  sync.start();
  await sync.syncNow();
  fetcher.mockClear();
  create(db);
  sync.localCommitted();
  await vi.advanceTimersByTimeAsync(1000);
  create(db);
  sync.localCommitted();
  await vi.advanceTimersByTimeAsync(1999);
  expect(fetcher).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
  await sync.syncNow();
  expect(fetcher).toHaveBeenCalled();
  fetcher.mockClear();
  await vi.advanceTimersByTimeAsync(57_000);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
  await sync.syncNow();
  expect(fetcher).toHaveBeenCalled();
  fetcher.mockResolvedValue(new Response(null, { status: 503 }));
  for (let failures = 1; failures <= 10; failures++) {
    await expect(sync.syncNow()).rejects.toThrow();
    expect(sync.status().retryAt! - Date.now()).toBe(syncBackoff(failures));
  }
  expect(syncBackoff(1)).toBe(5000);
  expect(syncBackoff(2)).toBe(10000);
  expect(syncBackoff(50)).toBe(300000);
  fetcher.mockResolvedValue(
    Response.json({ changes: [], lastServerSeq: 0, more: false }),
  );
  await sync.syncNow();
  expect(sync.status()).toMatchObject({ error: null, retryAt: null });
  let release!: (response: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  fetcher.mockClear();
  const first = sync.syncNow(),
    second = sync.syncNow();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  release(Response.json({ changes: [], lastServerSeq: 0, more: false }));
  expect(await first).toEqual(await second);
  expect(sync.status().running).toBe(false);
});

it("splits uploads at the one MiB wire limit rather than skipping large valid batches", async () => {
  const server = await relay(),
    db = open(),
    sizes: number[] = [];
  const sync = client(db, async (url, options) => {
    if (String(url).endsWith("/changes") && options?.body)
      sizes.push(new TextEncoder().encode(String(options.body)).length);
    return fetch(url, options);
  });
  for (let i = 0; i < 80; i++) create(db, `任务 ${i}`, "中".repeat(4000));
  await sync.enable({ serverUrl: server.url, registrationToken: server.token });
  await sync.syncNow();
  expect(sizes.length).toBeGreaterThan(1);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(1024 * 1024);
  expect(cursor(db).pushed_cursor).toBe(listChangesSince(db, 0, 1000).cursor);
});

it.each(["headers", "body"])(
  "aborts stalled %s after twenty seconds and records the timeout without moving cursors",
  async (phase) => {
    vi.useFakeTimers();
    const db = open();
    seed(db, "https://relay.example.com");
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        return controller.signal;
      });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, options) => {
        if (phase === "body")
          return new Response(
            new ReadableStream({
              start(controller) {
                options!.signal!.addEventListener(
                  "abort",
                  () => controller.error(new Error("aborted")),
                  { once: true },
                );
              },
            }),
          );
        return new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      });
    const sync = client(db, fetcher);
    const pending = expect(sync.syncNow()).rejects.toThrow("超时");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(timeout).toHaveBeenCalledWith(20000);
    await vi.advanceTimersByTimeAsync(20000);
    await pending;
    expect(cursor(db)).toEqual({ pushed_cursor: 0, pulled_cursor: 0 });
    expect(sync.status().error).toContain("超时");
  },
);

it.each([false, true])(
  "bounds streamed responses at 48 MiB (oversized: %s)",
  async (oversized) => {
    const db = open();
    seed(db, "https://relay.example.com");
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const json = new TextEncoder().encode(
      JSON.stringify({ changes: [], lastServerSeq: 0, more: false }),
    );
    let remaining = 48 * 1024 * 1024 + (oversized ? 1 : 0);
    let signal!: AbortSignal;
    let reads = 0;
    const sync = client(db, async (_url, options) => {
      signal = options!.signal!;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            reads++;
            if (!remaining) {
              if (oversized) return controller.enqueue(chunk);
              return controller.close();
            }
            if (remaining > 48 * 1024 * 1024 - json.length) {
              controller.enqueue(json);
              remaining -= json.length;
            } else {
              const value = chunk.subarray(
                0,
                Math.min(chunk.length, remaining),
              );
              remaining -= value.length;
              controller.enqueue(value);
            }
          },
          cancel,
        }),
      );
    });
    if (oversized) {
      await expect(sync.syncNow()).rejects.toMatchObject({
        code: "SYNC_ERROR",
        message: expect.stringContaining("48 MiB"),
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(signal.aborted).toBe(true);
      expect(sync.status().error).toContain("48 MiB");
      expect(cursor(db)).toEqual({ pushed_cursor: 0, pulled_cursor: 0 });
    } else {
      await expect(sync.syncNow()).resolves.toMatchObject({ error: null });
    }
    expect(reads).toBeLessThanOrEqual(51);
  },
);

it("rejects invalid registration and preserves the disabled state and local data", async () => {
  const server = await relay(),
    db = open(),
    sync = client(db);
  create(db);
  await expect(
    sync.enable({
      serverUrl: "http://example.com",
      registrationToken: server.token,
    }),
  ).rejects.toThrow("有效");
  await expect(
    sync.enable({ serverUrl: server.url, registrationToken: "x".repeat(40) }),
  ).rejects.toThrow("需要重新配对");
  expect(sync.status().enabled).toBe(false);
  expect(createQueries(db).workspaceSnapshot().counts.todo).toBe(1);
});

it("drains a local commit made while an otherwise empty pull is in flight", async () => {
  const db = open();
  seed(db, "https://relay.example.com");
  let release!: (response: Response) => void;
  let hold = true;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (_url, options) => {
      if (options?.method === "POST")
        return Response.json({
          accepted: (JSON.parse(String(options.body)) as { changes: unknown[] })
            .changes.length,
          lastServerSeq: 0,
        });
      if (hold) {
        hold = false;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return Response.json({ changes: [], lastServerSeq: 0, more: false });
    });
  const sync = client(db, fetcher);
  const cycle = sync.syncNow();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  create(db);
  sync.localCommitted();
  release(Response.json({ changes: [], lastServerSeq: 0, more: false }));
  await cycle;
  expect(cursor(db).pushed_cursor).toBe(listChangesSince(db, 0, 1000).cursor);
  expect(cursor(db).pushed_cursor).toBeGreaterThan(0);
});
