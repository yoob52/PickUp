import { z } from "zod";
import {
  enableSyncSchema,
  type EnableSyncInput,
  type SyncStatus,
} from "../shared/sync-contracts";
import { DomainError } from "./errors";
import { applyRemoteChanges, listChangeEntriesSince } from "./sync";
import {
  decryptChange,
  deriveSyncKeys,
  encryptChange,
  fromBase64url,
  generateRootKey,
  pairingPayload,
  type SyncKeys,
} from "./sync-crypto";
import type { SqliteDatabase } from "./sqlite";

type Config = {
  server_url: string;
  root_key: string;
  pushed_cursor: number;
  pulled_cursor: number;
  last_success: number | null;
  last_error: string | null;
  stopped: number;
  failures: number;
  retry_at: number | null;
};
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const downloadSchema = z.strictObject({
  changes: z
    .array(
      z.strictObject({
        serverSeq: sequence,
        deviceId: z.string().min(1).max(128),
        clientSeq: sequence,
        blob: z.string().max(87384),
      }),
    )
    .max(500),
  lastServerSeq: sequence,
  more: z.boolean(),
});
const uploadSchema = z.strictObject({
  accepted: sequence,
  lastServerSeq: sequence,
});
class AuthenticationError extends DomainError {
  constructor() {
    super("SYNC_ERROR", "需要重新配对", false);
  }
}
export const syncBackoff = (failures: number): number =>
  Math.min(300_000, 5000 * 2 ** Math.min(6, Math.max(0, failures - 1)));

export class SyncClient {
  private inFlight: Promise<void> | null = null;
  private controller = new AbortController();
  private configuring = false;
  private closed = false;
  private interval: ReturnType<typeof setInterval> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private knownSeq: number;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly changed: () => void = () => {},
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.knownSeq = this.latestSeq();
  }
  private config(): Config | undefined {
    return this.db
      .prepare("SELECT * FROM sync_config WHERE singleton=1")
      .get() as Config | undefined;
  }
  private notify(): void {
    try {
      this.changed();
    } catch {
      console.error("sync-notification-failed");
    }
  }
  private latestSeq(): number {
    return (
      this.db
        .prepare("SELECT coalesce(max(seq),0) AS seq FROM sync_changes")
        .get() as { seq: number }
    ).seq;
  }
  private deviceId(): string {
    return (
      this.db.prepare("SELECT id FROM sync_device WHERE singleton=1").get() as {
        id: string;
      }
    ).id;
  }
  status(): SyncStatus {
    const c = this.config();
    return {
      enabled: !!c,
      serverUrl: c?.server_url ?? null,
      running: !!this.inFlight,
      stopped: !!c?.stopped,
      lastSuccess: c?.last_success ?? null,
      error: c?.last_error ?? null,
      retryAt: c?.retry_at ?? null,
    };
  }
  start(): void {
    if (this.closed || this.interval) return;
    this.interval = setInterval(() => this.automatic(), 60_000);
    if (this.config()) this.schedule(0);
  }
  localCommitted(): void {
    const seq = this.latestSeq();
    if (seq === this.knownSeq) return;
    this.knownSeq = seq;
    this.schedule(2000);
  }
  private schedule(delay: number): void {
    const c = this.config();
    if (this.closed || !c || c.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.automatic(),
      Math.max(delay, (c.retry_at ?? 0) - Date.now()),
    );
  }
  private automatic(): void {
    const c = this.config();
    if (this.closed || !c || c.stopped || (c.retry_at ?? 0) > Date.now())
      return;
    void this.syncNow().catch((error) => {
      if (!(error instanceof DomainError)) console.error("sync-cycle-failed");
    });
  }
  private async request(
    url: string,
    authKey: string,
    body?: unknown,
  ): Promise<unknown> {
    try {
      const response = await this.fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(20_000),
        ]),
        headers: {
          Authorization: `Bearer ${authKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status === 401 || response.status === 403)
        throw new AuthenticationError();
      if (!response.ok)
        throw new DomainError(
          "SYNC_ERROR",
          `同步服务器返回错误（${response.status}），请检查地址或稍后重试。`,
          true,
        );
      return await response.json();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        "SYNC_ERROR",
        "同步请求失败或超时，请检查服务器和网络。",
        true,
      );
    }
  }
  async enable(input: EnableSyncInput): Promise<SyncStatus> {
    if (this.closed || this.configuring || this.config())
      throw DomainError.stateConflict("请先停止现有同步，或等待当前设置完成。");
    const parsed = enableSyncSchema.safeParse(input);
    if (!parsed.success)
      throw DomainError.validation("请填写有效的同步服务器地址和注册令牌。");
    this.configuring = true;
    try {
      const rootKey = generateRootKey();
      const keys = await deriveSyncKeys(rootKey);
      const registration = await this.request(
        parsed.data.serverUrl + "/v1/spaces",
        parsed.data.registrationToken,
        { spaceId: keys.spaceId, authKey: keys.authKey },
      );
      if (
        !z
          .strictObject({ spaceId: z.literal(keys.spaceId) })
          .safeParse(registration).success
      )
        throw new DomainError("SYNC_ERROR", "同步服务器注册回执无效。", false);
      if (this.closed)
        throw new DomainError("SYNC_ERROR", "同步已关闭。", false);
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM sync_uploads").run();
        this.db
          .prepare(
            "INSERT INTO sync_config(singleton,server_url,root_key) VALUES(1,?,?)",
          )
          .run(parsed.data.serverUrl, rootKey);
      })();
      this.schedule(2000);
      this.notify();
      return this.status();
    } finally {
      this.configuring = false;
    }
  }
  pairing(): string {
    const c = this.config();
    if (!c) throw DomainError.validation("请先启用同步。");
    return pairingPayload(c.server_url, c.root_key);
  }
  async disable(): Promise<SyncStatus> {
    if (this.configuring)
      throw DomainError.stateConflict("同步设置正在更新，请稍后重试。");
    this.configuring = true;
    clearTimeout(this.timer);
    this.controller.abort();
    try {
      await this.inFlight?.catch(() => this.status());
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM sync_uploads").run();
        this.db.prepare("DELETE FROM sync_config").run();
      })();
      this.controller = new AbortController();
      this.notify();
      return this.status();
    } finally {
      this.configuring = false;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.interval);
    clearTimeout(this.timer);
    this.controller.abort();
    await this.inFlight?.catch(() => this.status());
  }
  syncNow(): Promise<SyncStatus> {
    if (this.inFlight) return this.inFlight.then(() => this.status());
    if (this.closed || this.configuring)
      return Promise.reject(
        DomainError.stateConflict("同步设置正在更新或已关闭。"),
      );
    const config = this.config();
    if (!config)
      return Promise.reject(DomainError.validation("请先启用同步。"));
    if (config.stopped) return Promise.reject(new AuthenticationError());
    clearTimeout(this.timer);
    this.inFlight = this.cycle(config)
      .then(() => {
        this.db
          .prepare(
            "UPDATE sync_config SET last_success=?,last_error=NULL,failures=0,retry_at=NULL WHERE singleton=1",
          )
          .run(Date.now());
      })
      .catch((error) => {
        const failures = Math.min(config.failures + 1, 7);
        const stopped = error instanceof AuthenticationError;
        const message =
          error instanceof DomainError
            ? error.message
            : "同步失败，请稍后重试。";
        this.db
          .prepare(
            "UPDATE sync_config SET last_error=?,stopped=?,failures=?,retry_at=? WHERE singleton=1",
          )
          .run(
            message,
            stopped ? 1 : 0,
            failures,
            stopped ? null : Date.now() + syncBackoff(failures),
          );
        if (!stopped) this.schedule(syncBackoff(failures));
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
        this.notify();
      });
    this.notify();
    return this.inFlight.then(() => this.status());
  }
  private async cycle(config: Config): Promise<void> {
    const keys = await deriveSyncKeys(config.root_key);
    const deviceId = this.deviceId();
    const url = config.server_url + `/v1/spaces/${keys.spaceId}/changes`;
    for (;;) {
      if (this.controller.signal.aborted)
        throw new DomainError("SYNC_ERROR", "同步已取消。", false);
      const pushed = await this.push(config, keys, deviceId, url);
      const parsed = downloadSchema.safeParse(
        await this.request(
          url + `?after=${config.pulled_cursor}&limit=500`,
          keys.authKey,
        ),
      );
      if (!parsed.success)
        throw new DomainError("SYNC_ERROR", "同步服务器响应格式无效。", false);
      const page = parsed.data;
      let previous = config.pulled_cursor;
      for (const row of page.changes) {
        if (row.serverSeq <= previous)
          throw new DomainError(
            "SYNC_ERROR",
            "同步服务器返回了无效游标。",
            false,
          );
        previous = row.serverSeq;
      }
      if (
        page.lastServerSeq !== previous ||
        (page.more && !page.changes.length)
      )
        throw new DomainError(
          "SYNC_ERROR",
          "同步服务器返回了无效分页。",
          false,
        );
      const changes = await Promise.all(
        page.changes
          .filter((row) => row.deviceId !== deviceId)
          .map((row) =>
            decryptChange(keys, row.deviceId, row.clientSeq, row.blob),
          ),
      );
      const result = this.db.transaction(() => {
        const result = applyRemoteChanges(this.db, changes);
        this.db
          .prepare("UPDATE sync_config SET pulled_cursor=? WHERE singleton=1")
          .run(page.lastServerSeq);
        return result;
      })();
      config.pulled_cursor = page.lastServerSeq;
      if (result.applied) this.notify();
      if (
        !pushed &&
        !page.changes.length &&
        this.latestSeq() <= config.pushed_cursor
      )
        return;
    }
  }
  private async push(
    config: Config,
    keys: SyncKeys,
    deviceId: string,
    url: string,
  ): Promise<number> {
    const page = listChangeEntriesSince(this.db, config.pushed_cursor, 500);
    const changes: { clientSeq: number; blob: string }[] = [];
    let size = new TextEncoder().encode(
      JSON.stringify({ deviceId, changes: [] }),
    ).length;
    for (const entry of page.entries) {
      const prior = this.db
        .prepare("SELECT blob FROM sync_uploads WHERE seq=?")
        .get(entry.seq) as { blob: string } | undefined;
      const blob =
        prior?.blob ??
        (await encryptChange(keys, deviceId, entry.seq, entry.change));
      if (fromBase64url(blob).length > 65536)
        throw new DomainError(
          "SYNC_ERROR",
          "一条变更超过服务器 64 KiB 限制，未跳过该变更。",
          false,
        );
      const change = { clientSeq: entry.seq, blob };
      const length =
        new TextEncoder().encode(JSON.stringify(change)).length + 1;
      if (size + length > 1024 * 1024) break;
      changes.push(change);
      size += length;
      if (!prior)
        this.db
          .prepare("INSERT INTO sync_uploads(seq,blob) VALUES(?,?)")
          .run(entry.seq, blob);
    }
    if (!changes.length) return 0;
    const parsed = uploadSchema.safeParse(
      await this.request(url, keys.authKey, { deviceId, changes }),
    );
    if (!parsed.success || parsed.data.accepted > changes.length)
      throw new DomainError("SYNC_ERROR", "同步服务器上传回执无效。", false);
    const cursor = changes.at(-1)!.clientSeq;
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE sync_config SET pushed_cursor=? WHERE singleton=1")
        .run(cursor);
      this.db.prepare("DELETE FROM sync_uploads WHERE seq<=?").run(cursor);
    })();
    config.pushed_cursor = cursor;
    return changes.length;
  }
}
