import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Config } from "./config.js";

const MAX_BODY = 1024 * 1024;
const MAX_BLOB = 64 * 1024;
const base64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]*$/)
  .refine(
    (value) => Buffer.from(value, "base64url").toString("base64url") === value,
  );
const key = base64url.refine(
  (value) => Buffer.from(value, "base64url").length === 32,
);
const registration = z.strictObject({ spaceId: key, authKey: key });
const upload = z.strictObject({
  deviceId: z.string().min(1).max(128),
  changes: z
    .array(
      z.strictObject({
        clientSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        blob: base64url,
      }),
    )
    .max(500),
});
const decimal = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
const page = z.strictObject({
  after: decimal.default(0),
  limit: decimal.pipe(z.number().min(1).max(500)).default(200),
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest();

function bearer(req: IncomingMessage): string {
  const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? "");
  if (!match)
    throw new HttpError(
      401,
      "UNAUTHORIZED",
      "A valid Bearer credential is required.",
    );
  return match[1];
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  if (
    req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json.");
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > MAX_BODY)
    throw new HttpError(413, "BODY_TOO_LARGE", "Request body exceeds 1 MiB.");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0,
      finished = false;
    const timer = setTimeout(
      () =>
        fail(new HttpError(408, "REQUEST_TIMEOUT", "Request body timed out.")),
      10000,
    );
    function fail(error: Error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    }
    req.on("data", (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        fail(
          new HttpError(413, "BODY_TOO_LARGE", "Request body exceeds 1 MiB."),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(
          new HttpError(
            400,
            "INVALID_JSON",
            "Request body must be valid JSON.",
          ),
        );
      }
    });
    req.on("error", () =>
      fail(
        new HttpError(
          400,
          "INVALID_REQUEST",
          "Request body could not be read.",
        ),
      ),
    );
    req.on("aborted", () =>
      fail(new HttpError(400, "INVALID_REQUEST", "Request body was aborted.")),
    );
  });
}

export function createRelay(
  config: Config,
  log: (line: string) => void = console.log,
) {
  mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(join(config.dataDir, "sync.sqlite"));
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS spaces(space_id TEXT PRIMARY KEY,auth_hash BLOB NOT NULL,last_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS changes(space_id TEXT NOT NULL REFERENCES spaces(space_id), server_seq INTEGER NOT NULL,device_id TEXT NOT NULL,client_seq INTEGER NOT NULL,blob BLOB NOT NULL,
        PRIMARY KEY(space_id,server_seq),UNIQUE(space_id,device_id,client_seq));`);
  } catch (error) {
    db.close();
    throw error;
  }
  const registrationHash = digest(config.registrationToken);

  const server = createServer((req, res) => {
    const started = performance.now();
    let route = "<unmatched>";
    let logged = false;
    const logRequest = () => {
      if (logged) return;
      logged = true;
      log(
        `${req.method ?? "UNKNOWN"} ${route} ${res.writableFinished ? res.statusCode : 499} ${(performance.now() - started).toFixed(1)}ms`,
      );
    };
    res.once("finish", logRequest);
    res.once("close", logRequest);
    void handle().catch((error) => {
      req.resume();
      if (res.destroyed) return;
      const failure =
        error instanceof HttpError
          ? error
          : new HttpError(
              500,
              "INTERNAL_ERROR",
              "The request could not be completed.",
            );
      if (failure.status === 413 || failure.status === 408)
        res.setHeader("Connection", "close");
      json(res, failure.status, {
        error: { code: failure.code, message: failure.message },
      });
    });

    async function handle(): Promise<void> {
      const url = new URL(req.url ?? "/", "http://relay.invalid");
      const match = /^\/v1\/spaces\/([^/]+)\/changes$/.exec(url.pathname);
      if (url.pathname === "/healthz") route = "/healthz";
      else if (url.pathname === "/v1/spaces") route = "/v1/spaces";
      else if (match) route = "/v1/spaces/:id/changes";
      const origin = req.headers.origin;
      res.setHeader("Vary", "Origin");
      if (origin !== undefined) {
        if (!config.allowedOrigins.includes(origin))
          throw new HttpError(
            403,
            "ORIGIN_NOT_ALLOWED",
            "This origin is not allowed.",
          );
        res.setHeader("Access-Control-Allow-Origin", origin);
      }
      if (route === "<unmatched>")
        throw new HttpError(404, "NOT_FOUND", "Route not found.");
      const methods =
        route === "/healthz"
          ? ["GET"]
          : route === "/v1/spaces"
            ? ["POST"]
            : ["GET", "POST"];
      if (req.method === "OPTIONS") {
        const requested = req.headers["access-control-request-method"];
        const headers = (req.headers["access-control-request-headers"] ?? "")
          .split(",")
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean);
        if (
          !origin ||
          !requested ||
          !methods.includes(requested) ||
          headers.some((h) => !["authorization", "content-type"].includes(h))
        )
          throw new HttpError(
            403,
            "PREFLIGHT_NOT_ALLOWED",
            "Preflight method or headers are not allowed.",
          );
        res.writeHead(204, {
          "Access-Control-Allow-Methods": methods.join(", "),
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "600",
        });
        res.end();
        return;
      }
      if (!methods.includes(req.method ?? "")) {
        res.setHeader("Allow", methods.join(", "));
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
      }
      if (route === "/healthz") {
        json(res, 200, { ok: true });
        return;
      }
      if (route === "/v1/spaces") {
        if (!timingSafeEqual(digest(bearer(req)), registrationHash))
          throw new HttpError(
            401,
            "UNAUTHORIZED",
            "Invalid registration credential.",
          );
        const input = registration.safeParse(await readJson(req));
        if (!input.success)
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            "Expected 32-byte base64url spaceId and authKey.",
          );
        const { spaceId, authKey } = input.data;
        const hash = digest(Buffer.from(authKey, "base64url"));
        const existing = db
          .prepare("SELECT auth_hash FROM spaces WHERE space_id=?")
          .get(spaceId) as { auth_hash: Uint8Array } | undefined;
        if (existing && !timingSafeEqual(hash, existing.auth_hash))
          throw new HttpError(
            409,
            "SPACE_CONFLICT",
            "Space already exists with a different key.",
          );
        if (!existing)
          db.prepare("INSERT INTO spaces(space_id,auth_hash) VALUES(?,?)").run(
            spaceId,
            hash,
          );
        json(res, existing ? 200 : 201, { spaceId });
        return;
      }
      const space = key.safeParse(match![1]);
      if (!space.success)
        throw new HttpError(400, "VALIDATION_ERROR", "Invalid space id.");
      const auth = key.safeParse(bearer(req));
      const row = db
        .prepare("SELECT auth_hash FROM spaces WHERE space_id=?")
        .get(space.data) as { auth_hash: Uint8Array } | undefined;
      const supplied = digest(
        auth.success ? Buffer.from(auth.data, "base64url") : Buffer.alloc(0),
      );
      const correct = timingSafeEqual(
        supplied,
        row?.auth_hash ?? Buffer.alloc(32),
      );
      if (!auth.success || !row || !correct)
        throw new HttpError(401, "UNAUTHORIZED", "Invalid space credential.");
      if (req.method === "GET") {
        if (
          [...url.searchParams.keys()].some(
            (k) => url.searchParams.getAll(k).length !== 1,
          )
        )
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            "Duplicate query parameters are not allowed.",
          );
        const input = page.safeParse(Object.fromEntries(url.searchParams));
        if (!input.success)
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            "Invalid after or limit (maximum 500).",
          );
        const { after, limit } = input.data;
        const rows = db
          .prepare(
            "SELECT server_seq,device_id,client_seq,blob FROM changes WHERE space_id=? AND server_seq>? ORDER BY server_seq LIMIT ?",
          )
          .all(space.data, after, limit + 1) as {
          server_seq: number;
          device_id: string;
          client_seq: number;
          blob: Uint8Array;
        }[];
        const selected = rows.slice(0, limit);
        json(res, 200, {
          changes: selected.map((c) => ({
            serverSeq: c.server_seq,
            deviceId: c.device_id,
            clientSeq: c.client_seq,
            blob: Buffer.from(c.blob).toString("base64url"),
          })),
          lastServerSeq:
            selected.at(-1)?.server_seq ??
            (
              db
                .prepare("SELECT last_seq FROM spaces WHERE space_id=?")
                .get(space.data) as { last_seq: number }
            ).last_seq,
          more: rows.length > limit,
        });
        return;
      }
      const input = upload.safeParse(await readJson(req));
      if (!input.success)
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          "Expected deviceId and at most 500 changes with safe integer sequences and canonical base64url blobs no larger than 64 KiB.",
        );
      if (
        input.data.changes.some(
          (change) => Buffer.from(change.blob, "base64url").length > MAX_BLOB,
        )
      )
        throw new HttpError(
          413,
          "BLOB_TOO_LARGE",
          "Ciphertext blob exceeds 64 KiB.",
        );
      db.exec("BEGIN IMMEDIATE");
      let accepted = 0,
        lastServerSeq = 0;
      try {
        lastServerSeq = (
          db
            .prepare("SELECT last_seq FROM spaces WHERE space_id=?")
            .get(space.data) as { last_seq: number }
        ).last_seq;
        for (const change of input.data.changes) {
          const bytes = Buffer.from(change.blob, "base64url");
          const prior = db
            .prepare(
              "SELECT blob FROM changes WHERE space_id=? AND device_id=? AND client_seq=?",
            )
            .get(space.data, input.data.deviceId, change.clientSeq) as
            { blob: Uint8Array } | undefined;
          if (prior) {
            if (!bytes.equals(prior.blob))
              throw new HttpError(
                409,
                "CHANGE_CONFLICT",
                "A client sequence was reused with different ciphertext.",
              );
            continue;
          }
          if (lastServerSeq === Number.MAX_SAFE_INTEGER)
            throw new HttpError(
              409,
              "SEQUENCE_EXHAUSTED",
              "Space sequence is exhausted.",
            );
          lastServerSeq++;
          db.prepare(
            "INSERT INTO changes(space_id,server_seq,device_id,client_seq,blob) VALUES(?,?,?,?,?)",
          ).run(
            space.data,
            lastServerSeq,
            input.data.deviceId,
            change.clientSeq,
            bytes,
          );
          accepted++;
        }
        db.prepare("UPDATE spaces SET last_seq=? WHERE space_id=?").run(
          lastServerSeq,
          space.data,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      json(res, 200, { accepted, lastServerSeq });
    }
  });
  server.on("clientError", (error, socket) => {
    const code = (error as NodeJS.ErrnoException).code;
    const status =
      code === "HPE_HEADER_OVERFLOW"
        ? 431
        : code === "ERR_HTTP_REQUEST_TIMEOUT"
          ? 408
          : 400;
    if (socket.writable) {
      const body = JSON.stringify({
        error: { code: "INVALID_REQUEST", message: "Invalid HTTP request." },
      });
      socket.end(
        `HTTP/1.1 ${status} Error\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  let closing: Promise<void> | undefined;
  return {
    server,
    close(): Promise<void> {
      closing ??= new Promise((resolve, reject) => {
        const timer = setTimeout(() => server.closeAllConnections(), 10000);
        timer.unref();
        server.close((error) => {
          clearTimeout(timer);
          db.close();
          if (
            error &&
            (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
          )
            reject(error);
          else resolve();
        });
      });
      return closing;
    },
  };
}
