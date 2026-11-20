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
  toBase64url,
  generateRootKey,
  pairingPayload,
  parsePairingPayload,
  type SyncKeys,
} from "./sync-crypto";
import type { SqliteDatabase } from "./sqlite";
import {
  accountInputSchema,
  type AccountInput,
  type AccountReply,
} from "../shared/account-contracts";
import {
  passwordKeys,
  recoveryKeys,
  recoveryCode,
  seal,
  unseal,
  rootKeySchema,
  randomKey,
  ecdhKeyPair,
  exportPublic,
  handoffKey,
  handoffPayload,
  parseHandoff,
} from "./account-crypto";

type Config = {
  session_token: string | null;
  account_email: string | null;
  server_url: string;
  root_key: string;
  upload_device_id: string | null;
  pushed_cursor: number;
  pulled_cursor: number;
  pulled_device_id: string | null;
  pulled_client_seq: number | null;
  last_success: number | null;
  last_error: string | null;
  stopped: number;
  failures: number;
  retry_at: number | null;
};
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
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
  private active = true;
  private accountBusy = false;
  private handoff: {
    requestId: string;
    pollToken: string;
    expiresAt: number;
    serverUrl: string;
    privateKey: CryptoKey;
  } | null = null;

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
      accountEmail: c?.account_email ?? null,
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
    if (this.closed || !this.active || this.interval) return;
    this.interval = setInterval(() => this.automatic(), 60_000);
    if (this.config()) this.schedule(0);
  }
  async setActive(active: boolean): Promise<void> {
    this.active = active;
    clearTimeout(this.timer);
    clearInterval(this.interval);
    this.interval = undefined;
    if (!active) this.controller.abort();
    await this.inFlight?.catch(() => this.status());
    if (this.closed || this.active !== active) return;
    this.controller = new AbortController();
    if (active) this.start();
  }
  localCommitted(): void {
    const seq = this.latestSeq();
    if (seq === this.knownSeq) return;
    this.knownSeq = seq;
    this.schedule(2000);
  }
  private schedule(delay: number): void {
    const c = this.config();
    if (this.closed || !this.active || !c || c.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.automatic(),
      Math.max(delay, (c.retry_at ?? 0) - Date.now()),
    );
  }
  private automatic(): void {
    const c = this.config();
    if (
      this.closed ||
      !this.active ||
      !c ||
      c.stopped ||
      (c.retry_at ?? 0) > Date.now()
    )
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
    if (this.closed || !this.active)
      throw DomainError.stateConflict("请回到前台后重试。");
    const controller = new AbortController();
    const signal = AbortSignal.any([
      this.controller.signal,
      controller.signal,
      AbortSignal.timeout(20_000),
    ]);
    try {
      const fetcher = this.fetcher;
      const response = await fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal,
        headers: {
          ...(authKey ? { Authorization: `Bearer ${authKey}` } : {}),
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
      if (!response.body) throw new Error("Missing response body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parts: string[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            controller.abort();
            await reader.cancel();
            throw new DomainError(
              "SYNC_ERROR",
              "同步服务器响应超过 48 MiB 限制。",
              false,
            );
          }
          parts.push(decoder.decode(value, { stream: true }));
        }
        parts.push(decoder.decode());
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(parts.join("")) as unknown;
    } catch (error) {
      controller.abort();
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
      this.saveConfig(parsed.data.serverUrl, rootKey);
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
  private saveConfig(serverUrl: string, rootKey: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM sync_uploads").run();
      this.db
        .prepare(
          "INSERT INTO sync_config(singleton,server_url,root_key,upload_device_id) VALUES(1,?,?,?)",
        )
        .run(serverUrl, rootKey, crypto.randomUUID());
    })();
  }
  async account(raw: AccountInput): Promise<AccountReply> {
    if (this.accountBusy)
      throw DomainError.stateConflict("账户操作正在进行，请稍后重试。");
    this.accountBusy = true;
    try {
      return await this.runAccount(raw);
    } catch (error) {
      if (error instanceof AuthenticationError)
        throw new DomainError(
          "SYNC_ERROR",
          "邮箱、密码或恢复码不正确，或登录已经失效。",
          false,
        );
      throw error;
    } finally {
      this.accountBusy = false;
    }
  }
  private async runAccount(raw: AccountInput): Promise<AccountReply> {
    const input = accountInputSchema.parse(raw);
    if (this.closed || !this.active || this.configuring)
      throw DomainError.stateConflict("请在前台等待当前操作完成。");
    if (input.action === "pendingRecovery") {
      const c = this.config();
      const pending = c?.account_email
        ? (this.db
            .prepare(
              "SELECT recovery_code FROM account_signup WHERE server_url=? AND email=? AND root_key=?",
            )
            .get(c.server_url, c.account_email, c.root_key) as
            { recovery_code: string } | undefined)
        : undefined;
      return {
        status: this.status(),
        ...(pending ? { recoveryCode: pending.recovery_code } : {}),
      };
    }
    if (input.action === "cancelHandoff") {
      this.handoff = null;
      return { status: this.status() };
    }
    if (input.action === "ackRecovery") {
      const c = this.config();
      if (c)
        this.db
          .prepare(
            "DELETE FROM account_signup WHERE server_url=? AND email=? AND root_key=?",
          )
          .run(c.server_url, c.account_email, c.root_key);
      return { status: this.status() };
    }
    if (input.action === "logout") {
      const c = this.config();
      let failure: unknown;
      try {
        if (c?.session_token)
          await this.request(
            c.server_url + "/v1/accounts/logout",
            c.session_token,
            {},
          );
      } catch (error) {
        failure = error;
      }
      await this.disable();
      this.handoff = null;
      if (failure)
        throw new DomainError(
          "SYNC_ERROR",
          "已退出本机；服务器会话撤销未确认，将在到期后失效。",
          true,
        );
      return { status: this.status() };
    }
    if (
      input.action === "inspectHandoff" ||
      input.action === "approveHandoff"
    ) {
      const qr = parseHandoff(input.payload),
        c = this.config();
      if (!c?.session_token || !c.account_email || c.stopped)
        throw DomainError.validation("请先在手机登录账户。");
      if (qr.server !== c.server_url)
        throw DomainError.validation(
          "此二维码来自其他服务器，未发送账户密钥。",
        );
      if (input.action === "inspectHandoff")
        return {
          status: this.status(),
          confirmation: {
            serverUrl: c.server_url,
            email: c.account_email,
            expiresAt: qr.expiresAt,
          },
        };
      const issued = z
        .object({ sessionToken: rootKeySchema })
        .parse(
          await this.request(
            c.server_url + "/v1/accounts/session",
            c.session_token,
            {},
          ),
        );
      const pair = await ecdhKeyPair();
      const key = await handoffKey(pair.privateKey, qr.pubkey, qr.requestId);
      const blob = await seal(
        key,
        {
          rootKey: c.root_key,
          sessionToken: issued.sessionToken,
          email: c.account_email,
        },
        "pickup-handoff:1:" + qr.server + ":" + qr.requestId,
      );
      const ciphertext = toBase64url(
        new TextEncoder().encode(
          JSON.stringify({ pubkey: await exportPublic(pair.publicKey), blob }),
        ),
      );
      parseHandoff(input.payload);
      await this.request(
        c.server_url + "/v1/handoff/" + qr.requestId,
        c.session_token,
        { ciphertext },
      );
      return { status: this.status() };
    }
    if (this.config() && !this.config()!.stopped)
      throw DomainError.stateConflict("请先退出当前账户或停止配对同步。");
    if (input.action === "beginHandoff") {
      const slot = z
        .object({
          requestId: rootKeySchema,
          pollToken: rootKeySchema,
          expiresAt: z.number().int(),
        })
        .parse(await this.request(input.serverUrl + "/v1/handoff", "", {}));
      const pair = await ecdhKeyPair();
      this.handoff = {
        ...slot,
        serverUrl: input.serverUrl,
        privateKey: pair.privateKey,
      };
      return {
        status: this.status(),
        expiresAt: slot.expiresAt,
        qrPayload: handoffPayload({
          server: input.serverUrl,
          requestId: slot.requestId,
          pubkey: await exportPublic(pair.publicKey),
          expiresAt: slot.expiresAt,
        }),
      };
    }
    if (input.action === "pollHandoff") {
      const h = this.handoff;
      if (!h || h.expiresAt <= Date.now()) {
        this.handoff = null;
        throw DomainError.validation("扫码请求已过期，请重新生成。");
      }
      const reply = z
        .union([
          z.strictObject({ pending: z.literal(true) }),
          z.strictObject({ ciphertext: z.string().max(16384) }),
        ])
        .parse(
          await this.request(
            h.serverUrl + "/v1/handoff/" + h.requestId,
            h.pollToken,
          ),
        );
      if ("pending" in reply) return { status: this.status(), pending: true };
      this.handoff = null;
      const payload = z
        .strictObject({
          pubkey: z.string().max(128),
          blob: z.string().max(8192),
        })
        .parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              fromBase64url(reply.ciphertext),
            ),
          ),
        );
      const key = await handoffKey(h.privateKey, payload.pubkey, h.requestId);
      const approved = z
        .strictObject({
          rootKey: rootKeySchema,
          sessionToken: rootKeySchema,
          email: z.string().email(),
        })
        .parse(
          await unseal(
            key,
            payload.blob,
            "pickup-handoff:1:" + h.serverUrl + ":" + h.requestId,
          ),
        );
      await this.connectAccount(
        h.serverUrl,
        approved.rootKey,
        approved.sessionToken,
        approved.email,
      );
      return { status: this.status() };
    }
    this.configuring = true;
    try {
      const server = input.serverUrl,
        email = input.email;
      let rootKey: string, session: unknown, code: string | undefined;
      const context = "pickup-account:1:" + email;
      if (input.action === "recover") {
        const recovery = await recoveryKeys(input.recoveryCode);
        const response = z
          .object({ wrappedRootKey: z.string().max(1024) })
          .parse(
            await this.request(server + "/v1/accounts/recover", "", {
              action: "read",
              email,
              recoveryAuthKey: recovery.authKey,
            }),
          );
        rootKey = rootKeySchema.parse(
          await unseal(
            recovery.kek,
            response.wrappedRootKey,
            context + ":recovery",
          ),
        );
        const salt = randomKey(),
          keys = await passwordKeys(input.password, salt);
        session = await this.request(server + "/v1/accounts/recover", "", {
          action: "reset",
          email,
          recoveryAuthKey: recovery.authKey,
          salt,
          authKey: keys.authKey,
          wrappedRootKey: await seal(keys.kek, rootKey, context),
        });
      } else {
        const { salt } = z
          .object({ salt: rootKeySchema })
          .parse(
            await this.request(server + "/v1/accounts/prelogin", "", { email }),
          );
        const keys = await passwordKeys(input.password, salt);
        if (input.action === "register") {
          const pending = this.db
            .prepare(
              "SELECT root_key,recovery_code FROM account_signup WHERE server_url=? AND email=?",
            )
            .get(server, email) as
            { root_key: string; recovery_code: string } | undefined;
          rootKey = pending?.root_key ?? generateRootKey();
          code = pending?.recovery_code ?? recoveryCode();
          const recovery = await recoveryKeys(code),
            sync = await deriveSyncKeys(rootKey);
          this.db
            .prepare("INSERT OR REPLACE INTO account_signup VALUES(?,?,?,?)")
            .run(server, email, rootKey, code);
          session = await this.request(server + "/v1/accounts", "", {
            email,
            salt,
            authKey: keys.authKey,
            spaceId: sync.spaceId,
            spaceAuthKey: sync.authKey,
            wrappedRootKey: await seal(keys.kek, rootKey, context),
            recoveryAuthKey: recovery.authKey,
            recoveryWrappedRootKey: await seal(
              recovery.kek,
              rootKey,
              context + ":recovery",
            ),
          });
        } else {
          session = await this.request(server + "/v1/accounts/login", "", {
            email,
            authKey: keys.authKey,
          });
          const response = z
            .object({ wrappedRootKey: z.string().max(1024) })
            .parse(session);
          rootKey = rootKeySchema.parse(
            await unseal(keys.kek, response.wrappedRootKey, context),
          );
          const pending = this.db
            .prepare(
              "SELECT recovery_code FROM account_signup WHERE server_url=? AND email=? AND root_key=?",
            )
            .get(server, email, rootKey) as
            { recovery_code: string } | undefined;
          code = pending?.recovery_code;
        }
      }
      const response = z
        .object({
          sessionToken: rootKeySchema,
          email: z.literal(email),
          spaceId: rootKeySchema,
        })
        .parse(session);
      if ((await deriveSyncKeys(rootKey)).spaceId !== response.spaceId)
        throw DomainError.validation("账户空间与密钥不一致，未启用同步。");
      // Configuration is replaced only after credentials and the wrapped key have been verified.
      await this.connectAccount(server, rootKey, response.sessionToken, email);
      return { status: this.status(), ...(code ? { recoveryCode: code } : {}) };
    } finally {
      this.configuring = false;
    }
  }
  private async connectAccount(
    server: string,
    root: string,
    session: string,
    email: string,
  ) {
    if (this.closed || !this.active)
      throw DomainError.stateConflict("请回到前台后重新登录。");
    this.controller.abort();
    await this.inFlight?.catch(() => this.status());
    this.controller = new AbortController();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM sync_config").run();
      this.saveConfig(server, root);
      this.db
        .prepare(
          "UPDATE sync_config SET session_token=?,account_email=? WHERE singleton=1",
        )
        .run(session, email);
    })();
    this.schedule(0);
    this.notify();
  }
  async pair(payload: string): Promise<SyncStatus> {
    if (this.closed || this.configuring || !this.active)
      throw DomainError.stateConflict("请在前台等待同步设置完成后重试。");
    const parsed = parsePairingPayload(payload);
    const config = this.config();
    if (config && !config.stopped)
      throw DomainError.stateConflict("请先停止现有同步，再配对其他设备。");
    if (config) await this.disable();
    this.saveConfig(parsed.serverUrl, parsed.rootKey);
    this.notify();
    return this.syncNow();
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
    if (this.closed || this.configuring || !this.active)
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
        if (this.controller.signal.aborted) throw error;
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
    const deviceId = config.upload_device_id ?? this.deviceId();
    const url = config.server_url + `/v1/spaces/${keys.spaceId}/changes`;
    if (
      config.pulled_cursor &&
      (config.pulled_device_id === null || config.pulled_client_seq === null)
    )
      this.resetContinuity(config);
    for (;;) {
      if (this.controller.signal.aborted)
        throw new DomainError("SYNC_ERROR", "同步已取消。", false);
      const pushed = await this.push(config, keys, deviceId, url);
      const parsed = downloadSchema.safeParse(
        await this.request(
          url + `?after=${Math.max(0, config.pulled_cursor - 1)}&limit=50`,
          config.session_token ?? keys.authKey,
        ),
      );
      if (!parsed.success)
        throw new DomainError("SYNC_ERROR", "同步服务器响应格式无效。", false);
      const page = parsed.data;
      const last = page.changes.at(-1);
      if (config.pulled_cursor > 0) {
        const anchor = page.changes[0];
        if (
          !anchor ||
          anchor.serverSeq !== config.pulled_cursor ||
          anchor.deviceId !== config.pulled_device_id ||
          anchor.clientSeq !== config.pulled_client_seq
        ) {
          this.resetContinuity(config);
          continue;
        }
        page.changes.shift();
      }
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
          .prepare(
            "UPDATE sync_config SET pulled_cursor=?,pulled_device_id=?,pulled_client_seq=? WHERE singleton=1",
          )
          .run(
            page.lastServerSeq,
            last?.deviceId ?? null,
            last?.clientSeq ?? null,
          );
        return result;
      })();
      config.pulled_cursor = page.lastServerSeq;
      config.pulled_device_id = last?.deviceId ?? null;
      config.pulled_client_seq = last?.clientSeq ?? null;
      if (result.applied) this.notify();
      if (
        !pushed &&
        !page.changes.length &&
        this.latestSeq() <= config.pushed_cursor
      )
        return;
    }
  }
  private resetContinuity(config: Config): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE sync_config SET pushed_cursor=0,pulled_cursor=0,pulled_device_id=NULL,pulled_client_seq=NULL,last_error=? WHERE singleton=1",
        )
        .run("同步历史连续性已变化，正在重新上传本地变更。");
    })();
    config.pushed_cursor = 0;
    config.pulled_cursor = 0;
    config.pulled_device_id = null;
    config.pulled_client_seq = null;
    console.warn("sync-relay-continuity-reset");
    this.notify();
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
      await this.request(url, config.session_token ?? keys.authKey, {
        deviceId,
        changes,
      }),
    );
    if (!parsed.success || parsed.data.accepted > changes.length)
      throw new DomainError("SYNC_ERROR", "同步服务器上传回执无效。", false);
    const cursor = changes.at(-1)!.clientSeq;
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE sync_config SET pushed_cursor=? WHERE singleton=1")
        .run(cursor);
    })();
    config.pushed_cursor = cursor;
    return changes.length;
  }
}
