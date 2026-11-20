import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Config } from "./config.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest();
const key = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine((v) => Buffer.from(v, "base64url").toString("base64url") === v);
const email = z.string().trim().toLowerCase().email().max(254);
const wrapped = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .min(60)
  .max(1024);
const identity = z.strictObject({ email });
const credentials = z.strictObject({ email, authKey: key });
const registration = credentials.extend({
  salt: key,
  spaceId: key,
  spaceAuthKey: key,
  wrappedRootKey: wrapped,
  recoveryAuthKey: key,
  recoveryWrappedRootKey: wrapped,
});
const recovery = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("read"), email, recoveryAuthKey: key }),
  z.strictObject({
    action: z.literal("reset"),
    email,
    recoveryAuthKey: key,
    salt: key,
    authKey: key,
    wrappedRootKey: wrapped,
  }),
]);
type Account = {
  email: string;
  salt: string;
  auth_salt: Uint8Array;
  auth_hash: Uint8Array;
  recovery_salt: Uint8Array;
  recovery_hash: Uint8Array;
  wrapped_root: string;
  recovery_wrapped: string;
  space_id: string;
};
const invalid = () =>
  new HttpError(401, "INVALID_CREDENTIALS", "邮箱、凭据或恢复码不正确。");
const hash = (value: string, salt: Uint8Array) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      value,
      salt,
      32,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, result) => (error ? reject(error) : resolve(result)),
    ),
  );
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new HttpError(400, "VALIDATION_ERROR", "账户请求格式无效。");
  return parsed.data;
}

export function createAccounts(
  db: DatabaseSync,
  config: Config,
  now: () => number,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS account_meta(id INTEGER PRIMARY KEY CHECK(id=1), secret BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts(email TEXT PRIMARY KEY,salt TEXT NOT NULL,auth_salt BLOB NOT NULL,auth_hash BLOB NOT NULL,recovery_salt BLOB NOT NULL,recovery_hash BLOB NOT NULL,wrapped_root TEXT NOT NULL,recovery_wrapped TEXT NOT NULL,space_id TEXT NOT NULL UNIQUE REFERENCES spaces(space_id));
    CREATE TABLE IF NOT EXISTS sessions(token_hash BLOB PRIMARY KEY,email TEXT NOT NULL REFERENCES accounts(email),expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS account_limits(bucket TEXT PRIMARY KEY,attempts INTEGER NOT NULL,until_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS handoffs(id TEXT PRIMARY KEY,poll_hash BLOB NOT NULL,expires_at INTEGER NOT NULL,ciphertext TEXT);
    CREATE TABLE IF NOT EXISTS account_usage(space_id TEXT PRIMARY KEY REFERENCES spaces(space_id),bytes INTEGER NOT NULL DEFAULT 0);`);
  db.prepare("INSERT OR IGNORE INTO account_meta VALUES(1,?)").run(
    randomBytes(32),
  );
  const secret = (
    db.prepare("SELECT secret FROM account_meta WHERE id=1").get() as {
      secret: Uint8Array;
    }
  ).secret;
  const dummySalt = randomBytes(32),
    dummyHash = scryptSync("dummy", dummySalt, 32);
  const saltFor = (value: string) =>
    createHmac("sha256", secret).update(value).digest("base64url");
  const bucket = (kind: string, value: string) =>
    kind + ":" + createHmac("sha256", secret).update(value).digest("hex");
  function rate(kind: string, value: string, limit: number, window: number) {
    db.prepare("DELETE FROM account_limits WHERE until_at<?").run(
      now() - 3600000,
    );
    const id = bucket(kind, value);
    const row = db
      .prepare("SELECT attempts,until_at FROM account_limits WHERE bucket=?")
      .get(id) as { attempts: number; until_at: number } | undefined;
    if (row && row.until_at > now() && row.attempts >= limit)
      throw new HttpError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试。");
    db.prepare(
      "INSERT INTO account_limits VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN until_at<=? THEN 1 ELSE attempts+1 END,until_at=CASE WHEN until_at<=? THEN excluded.until_at ELSE until_at END",
    ).run(id, now() + window, now(), now());
  }
  function session(credential: string): Account {
    const row = db
      .prepare(
        "SELECT a.* FROM sessions s JOIN accounts a ON a.email=s.email WHERE s.token_hash=? AND s.expires_at>?",
      )
      .get(digest(credential), now()) as Account | undefined;
    if (!row) throw invalid();
    return row;
  }
  function issue(account: Account) {
    db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now());
    const token = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      digest(token),
      account.email,
      now() + 30 * 86400000,
    );
    return {
      sessionToken: token,
      email: account.email,
      spaceId: account.space_id,
      wrappedRootKey: account.wrapped_root,
    };
  }
  async function check(
    value: string,
    row: Account | undefined,
    recover = false,
  ) {
    const result = await hash(
      value,
      row ? (recover ? row.recovery_salt : row.auth_salt) : dummySalt,
    );
    return (
      timingSafeEqual(
        result,
        row ? (recover ? row.recovery_hash : row.auth_hash) : dummyHash,
      ) && !!row
    );
  }
  function lock(value: string, failed: boolean) {
    const id = bucket("email", value);
    const row = db
      .prepare("SELECT attempts,until_at FROM account_limits WHERE bucket=?")
      .get(id) as { attempts: number; until_at: number } | undefined;
    if (!failed) {
      if (row && row.until_at > now() && row.attempts >= 5)
        throw new HttpError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试。");
      return;
    }
    const n = Math.min((row?.attempts ?? 0) + 1, 15);
    db.prepare("INSERT OR REPLACE INTO account_limits VALUES(?,?,?)").run(
      id,
      n,
      now() + Math.min(3600000, 5000 * 2 ** Math.max(0, n - 5)),
    );
  }
  return {
    authorize(space: string, credential: string) {
      try {
        return session(credential).space_id === space;
      } catch (error) {
        if (error instanceof HttpError) return false;
        throw error;
      }
    },
    quota(space: string, bytes: number) {
      const row = db
        .prepare("SELECT bytes FROM account_usage WHERE space_id=?")
        .get(space) as { bytes: number } | undefined;
      if (
        row &&
        row.bytes + bytes > (config.accountQuotaBytes ?? 20 * 1024 * 1024)
      )
        throw new HttpError(
          413,
          "QUOTA_EXCEEDED",
          "账户加密数据已达到存储限额。",
        );
      if (row)
        db.prepare(
          "UPDATE account_usage SET bytes=bytes+? WHERE space_id=?",
        ).run(bytes, space);
    },
    async handle(
      path: string,
      method: string,
      body: unknown,
      credential: string,
      ip: string,
    ) {
      if (path === "/v1/accounts/prelogin") {
        rate("prelogin", ip, 60, 60000);
        const input = parse(identity, body);
        const row = db
          .prepare("SELECT salt FROM accounts WHERE email=?")
          .get(input.email) as { salt: string } | undefined;
        return { salt: row?.salt ?? saltFor(input.email) };
      }
      if (path === "/v1/accounts") {
        rate("register", ip, 5, 3600000);
        const input = parse(registration, body);
        if (input.salt !== saltFor(input.email))
          throw new HttpError(400, "VALIDATION_ERROR", "请重新获取注册盐值。");
        const authSalt = randomBytes(32),
          recoverySalt = randomBytes(32);
        const [authHash, recoveryHash] = await Promise.all([
          hash(input.authKey, authSalt),
          hash(input.recoveryAuthKey, recoverySalt),
        ]);
        db.exec("BEGIN IMMEDIATE");
        try {
          if (
            db
              .prepare("SELECT 1 FROM accounts WHERE email=?")
              .get(input.email) ||
            db
              .prepare("SELECT 1 FROM spaces WHERE space_id=?")
              .get(input.spaceId)
          )
            throw new HttpError(
              409,
              "ACCOUNT_UNAVAILABLE",
              "无法注册，请尝试登录或使用恢复码。",
            );
          db.prepare("INSERT INTO spaces(space_id,auth_hash) VALUES(?,?)").run(
            input.spaceId,
            digest(Buffer.from(input.spaceAuthKey, "base64url")),
          );
          db.prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?,?)").run(
            input.email,
            input.salt,
            authSalt,
            authHash,
            recoverySalt,
            recoveryHash,
            input.wrappedRootKey,
            input.recoveryWrappedRootKey,
            input.spaceId,
          );
          db.prepare("INSERT INTO account_usage(space_id) VALUES(?)").run(
            input.spaceId,
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return issue(
          db
            .prepare("SELECT * FROM accounts WHERE email=?")
            .get(input.email) as Account,
        );
      }
      if (path === "/v1/accounts/login" || path === "/v1/accounts/recover") {
        rate("login", ip, 20, 60000);
        const recovering = path.endsWith("recover");
        const input = recovering
          ? parse(recovery, body)
          : { ...parse(credentials, body), action: "login" as const };
        lock(input.email, false);
        const row = db
          .prepare("SELECT * FROM accounts WHERE email=?")
          .get(input.email) as Account | undefined;
        if (
          !(await check(
            "recoveryAuthKey" in input ? input.recoveryAuthKey : input.authKey,
            row,
            recovering,
          ))
        ) {
          lock(input.email, true);
          throw invalid();
        }
        // Re-read after asynchronous scrypt: a concurrent reset must invalidate old credentials.
        const current = db
          .prepare("SELECT * FROM accounts WHERE email=?")
          .get(input.email) as Account;
        lock(input.email, false);
        if (
          !timingSafeEqual(
            recovering ? current.recovery_hash : current.auth_hash,
            recovering ? row!.recovery_hash : row!.auth_hash,
          )
        )
          throw invalid();
        db.prepare("DELETE FROM account_limits WHERE bucket=?").run(
          bucket("email", input.email),
        );
        if (input.action !== "login") {
          if (input.action === "read")
            return { wrappedRootKey: current.recovery_wrapped };
          const authSalt = randomBytes(32),
            authHash = await hash(input.authKey, authSalt);
          db.exec("BEGIN IMMEDIATE");
          try {
            db.prepare(
              "UPDATE accounts SET salt=?,auth_salt=?,auth_hash=?,wrapped_root=? WHERE email=?",
            ).run(
              input.salt,
              authSalt,
              authHash,
              input.wrappedRootKey,
              input.email,
            );
            db.prepare("DELETE FROM sessions WHERE email=?").run(input.email);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          return issue(
            db
              .prepare("SELECT * FROM accounts WHERE email=?")
              .get(input.email) as Account,
          );
        }
        return issue(current);
      }
      if (path === "/v1/accounts/logout") {
        session(credential);
        db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
          digest(credential),
        );
        return { ok: true };
      }
      if (path === "/v1/accounts/session") {
        rate("session", ip, 20, 60000);
        return issue(session(credential));
      }
      if (path === "/v1/handoff") {
        rate("handoff", ip, 20, 60000);
        db.prepare("DELETE FROM handoffs WHERE expires_at<=?").run(now());
        const id = randomBytes(32).toString("base64url"),
          pollToken = randomBytes(32).toString("base64url"),
          expiresAt = now() + 120000;
        db.prepare("INSERT INTO handoffs VALUES(?,?,?,NULL)").run(
          id,
          digest(pollToken),
          expiresAt,
        );
        return { requestId: id, pollToken, expiresAt };
      }
      const match = /^\/v1\/handoff\/([A-Za-z0-9_-]{43})$/.exec(path);
      if (match) {
        const row = db
          .prepare("SELECT * FROM handoffs WHERE id=? AND expires_at>?")
          .get(match[1], now()) as
          | {
              poll_hash: Uint8Array;
              expires_at: number;
              ciphertext: string | null;
            }
          | undefined;
        if (!row)
          throw new HttpError(
            410,
            "HANDOFF_EXPIRED",
            "扫码请求已过期，请重新生成。",
          );
        if (method === "GET") {
          if (!timingSafeEqual(digest(credential), row.poll_hash))
            throw invalid();
          if (!row.ciphertext) return { pending: true };
          db.prepare("DELETE FROM handoffs WHERE id=?").run(match[1]);
          return { ciphertext: row.ciphertext };
        }
        session(credential);
        const input = parse(
          z.strictObject({
            ciphertext: z
              .string()
              .regex(/^[A-Za-z0-9_-]+$/)
              .min(60)
              .max(16384),
          }),
          body,
        );
        if (row.ciphertext)
          throw new HttpError(409, "HANDOFF_USED", "请求已确认。");
        db.prepare("UPDATE handoffs SET ciphertext=? WHERE id=?").run(
          input.ciphertext,
          match[1],
        );
        return { ok: true };
      }
      throw new HttpError(404, "NOT_FOUND", "Route not found.");
    },
  };
}
